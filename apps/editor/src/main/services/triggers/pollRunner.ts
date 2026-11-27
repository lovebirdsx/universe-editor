/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Executes poll sources: one fetch command per trigger at a time (a command that
 *  outlives its interval must never overlap itself), newest-first truncation against
 *  the dedupe limit, and the first-observation baseline. Cadence (`nextPoll`) stays
 *  with the scheduler; this runner only reports completion back.
 *--------------------------------------------------------------------------------------------*/

import type { ILogger } from '@universe-editor/platform'
import type { PollFetchResult } from '@universe-editor/node-services'
import {
  isProcessed,
  markStarted,
  newestItems,
  prune,
  type ProcessedKeys,
  type PruneOptions,
} from '../../../shared/triggers/dedupe.js'
import type { TriggerEvent, TriggerSourceConfig } from '../../../shared/triggers/types.js'
import type { TriggerClock } from './triggerClock.js'
import type { TriggerExecutionBackend } from './triggerExecutionBackend.js'
import type { RuntimeStatePatch } from './triggerStateRepository.js'
import type { TriggerRuntimeState } from './triggerStateStore.js'
import type { RoutedTrigger } from './triggerTypes.js'

type PollSource = Extract<TriggerSourceConfig, { type: 'poll' }>

export interface PollRunnerHost {
  readonly logger: ILogger
  readonly clock: TriggerClock
  readonly processedKeyLimit: number
  findTrigger(triggerKey: string): RoutedTrigger | undefined
  isRunnable(
    trigger: RoutedTrigger,
    options?: { ignoreBackoff?: boolean; manual?: boolean },
  ): boolean
  isTrusted(workspaceUri: string): Promise<boolean>
  backendFor(trigger: RoutedTrigger): TriggerExecutionBackend
  stateFor(triggerKey: string): TriggerRuntimeState
  setTriggerState(triggerKey: string, patch: RuntimeStatePatch): void
  pruneOptionsFor(triggerKey: string): PruneOptions
  /** Keep this round's keys from being evicted by the configured dedupe limit. */
  raiseProcessedLimit(triggerKey: string, limit: number): void
  acceptEvent(trigger: RoutedTrigger, event: TriggerEvent): Promise<boolean>
  recordFailure(trigger: RoutedTrigger, message: string, now: number): void
  fireChange(): void
  /** The fetch finished (success or not); the scheduler re-arms the next slot. */
  onPollFinished(triggerKey: string): void
}

export class PollRunner {
  private readonly _host: PollRunnerHost
  /** Poll commands currently in flight, one per trigger key (never overlap). */
  private readonly _polling = new Set<string>()

  constructor(host: PollRunnerHost) {
    this._host = host
  }

  isPolling(triggerKey: string): boolean {
    return this._polling.has(triggerKey)
  }

  async runPoll(trigger: RoutedTrigger): Promise<void> {
    if (trigger.source.type !== 'poll') return
    if (this._polling.has(trigger.key)) return
    this._polling.add(trigger.key)
    try {
      await this._pollOnce(trigger, trigger.source)
    } finally {
      this._polling.delete(trigger.key)
      this._host.onPollFinished(trigger.key)
    }
  }

  private async _pollOnce(trigger: RoutedTrigger, source: PollSource): Promise<void> {
    const host = this._host
    // The poll command runs in main (or on the remote host) with the user's
    // privileges: never execute it for an untrusted workspace, independently of
    // the per-window trust check at run start (a background window may not exist
    // until a run actually starts).
    if (!(await host.isTrusted(trigger.workspaceUri.toString()))) {
      host.logger.info(`trigger ${trigger.id}: poll skipped (workspace is not trusted)`)
      return
    }

    const outcome = await host.backendFor(trigger).fetchPoll(trigger, source)
    if (outcome.kind === 'skipped') {
      host.logger.info(`trigger ${trigger.id}: remote poll skipped (${outcome.reason})`)
      return
    }
    const result: PollFetchResult = outcome.result
    const now = host.clock.now()
    const current = host.findTrigger(trigger.key)
    if (current === undefined || !host.isRunnable(current, { ignoreBackoff: true })) {
      host.logger.info(`trigger ${trigger.id}: poll result ignored (trigger no longer runnable)`)
      return
    }
    if (!result.ok) {
      host.logger.warn(`trigger ${trigger.id}: poll failed: ${result.error}`)
      host.recordFailure(current, result.error, now)
      return
    }

    // One round can exceed the per-trigger dedupe limit. Firing the newest slice
    // is fine, but the older prefix was still observed: record it too, otherwise
    // a shorter / reordered next round can move those keys into the newest window
    // and fire them as if they were new. The round size (bounded by the 1 MB
    // stdout cap) also raises this trigger's effective limit, so neither the
    // baseline write nor `markProcessed` can evict a key from this same round.
    const selected = newestItems(result.items, host.processedKeyLimit)
    const dropped =
      selected.dropped === 0
        ? []
        : result.items.slice(0, result.items.length - selected.items.length)
    const state = host.stateFor(trigger.key)
    const recovery = pollRecoveryPatch(state)
    const droppedNew = dropped.filter(
      (item) => !isProcessed(state.processed, `poll:${item.key}`),
    ).length
    if (droppedNew > 0) {
      host.logger.warn(
        `trigger ${trigger.id}: poll returned ${result.items.length} items; keeping the newest ${selected.items.length}; recording ${dropped.length} older poll item(s) without firing (${droppedNew} new)`,
      )
    }
    host.raiseProcessedLimit(trigger.key, result.items.length)
    const pruneOptions = host.pruneOptionsFor(trigger.key)
    const droppedAt = Math.max(0, now - 1)

    if (!state.baselineDone) {
      let processed: ProcessedKeys = state.processed
      for (const item of dropped) {
        processed = markStarted(processed, `poll:${item.key}`, droppedAt)
      }
      for (const item of selected.items) {
        processed = markStarted(processed, `poll:${item.key}`, now)
      }
      host.setTriggerState(trigger.key, {
        processed: prune(processed, now, pruneOptions),
        baselineDone: true,
        ...(recovery ?? {}),
      })
      host.logger.info(
        `trigger ${trigger.id}: poll baseline recorded items=${result.items.length}` +
          (dropped.length > 0 ? ` dropped=${dropped.length}` : ''),
      )
      host.fireChange()
      return
    }

    if (dropped.length > 0) {
      let processed = host.stateFor(trigger.key).processed
      for (const item of dropped) {
        const key = `poll:${item.key}`
        if (!isProcessed(processed, key)) {
          processed = markStarted(processed, key, droppedAt)
        }
      }
      host.setTriggerState(trigger.key, {
        processed: prune(processed, now, pruneOptions),
        ...(recovery ?? {}),
      })
    } else if (recovery !== undefined) {
      host.setTriggerState(trigger.key, recovery)
    }
    if (recovery !== undefined) host.fireChange()

    for (const item of selected.items) {
      await host.acceptEvent(host.findTrigger(trigger.key) ?? current, {
        triggerId: trigger.id,
        key: `poll:${item.key}`,
        payload: item.payload,
        firedAt: now,
      })
    }
  }
}

/** A successful fetch proves the source healthy again, so failure state is cleared. */
function pollRecoveryPatch(state: TriggerRuntimeState): RuntimeStatePatch | undefined {
  if (
    state.lastError === undefined &&
    state.consecutiveFailures <= 0 &&
    state.backoffUntil === undefined
  ) {
    return undefined
  }
  return { consecutiveFailures: 0, lastError: undefined, backoffUntil: undefined }
}
