/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The only writer of trigger runtime state (`<userData>/triggers/state.json`) and of
 *  the staged event payloads (`pending/<runId>.json`). The scheduler, the run ledger
 *  and the poll runner mutate state exclusively through this repository so debouncing,
 *  pruning, orphan cleanup and write ordering live in one place.
 *
 *  Startup sweep drops trigger keys whose workspace is no longer in the registry and
 *  pending payloads nothing references; a periodic prune expires dedupe keys even
 *  when a trigger never writes a new one again.
 *--------------------------------------------------------------------------------------------*/

import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ILogger } from '@universe-editor/platform'
import { isValidTriggerRunId } from '@universe-editor/node-services'
import {
  forget,
  isProcessed,
  markQueued,
  markStarted,
  prune,
  type ProcessedKeys,
} from '../../../shared/triggers/dedupe.js'
import {
  TRIGGER_DEFAULTS,
  type TriggerEvent,
  type TriggerPayloadValue,
} from '../../../shared/triggers/types.js'
import { writeJsonAtomic } from '../jsonConfig/atomicFile.js'
import { unrefTimer, type TriggerClock, type TriggerTimerHandle } from './triggerClock.js'
import { parseTriggerKey } from './triggerIdentity.js'
import {
  createEmptyTriggerStateFile,
  DEFAULT_TRIGGER_RUNTIME_STATE,
  TriggerStateStore,
  type PendingRunRecord,
  type TriggerRuntimeState,
  type TriggerStateFile,
} from './triggerStateStore.js'

export type RuntimeStatePatch = {
  readonly [K in keyof TriggerRuntimeState]?: TriggerRuntimeState[K] | undefined
}

export interface TriggerStateRepositoryOptions {
  readonly file: string
  readonly pendingDir: string
  readonly logger: ILogger
  readonly clock: TriggerClock
  readonly debounceMs?: number
  /** Hard cap on one trigger's dedupe keys (test seam; defaults to the production limit). */
  readonly processedKeyLimit?: number
  readonly ttlMs?: number
  /** How often expired dedupe keys are dropped even without a write. */
  readonly pruneIntervalMs?: number
  /** Test seam: the debounced state writer (default: a TriggerStateStore on `file`). */
  readonly stateStore?: TriggerStateStore
}

const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60_000

export class TriggerStateRepository {
  private readonly _pendingDir: string
  private readonly _logger: ILogger
  private readonly _clock: TriggerClock
  private readonly _store: TriggerStateStore
  private readonly _processedKeyLimit: number
  /**
   * Per-trigger floors raised by a poll round larger than the configured limit.
   * `markProcessed` must not evict keys from the round that is being consumed;
   * the floor stays at the largest round seen (poll stdout is capped at 1 MB).
   */
  private readonly _processedLimitFloors = new Map<string, number>()
  private readonly _ttlMs: number
  private readonly _pruneIntervalMs: number
  private _state: TriggerStateFile = createEmptyTriggerStateFile()
  private _pruneTimer: TriggerTimerHandle | undefined
  private _disposed = false

  constructor(options: TriggerStateRepositoryOptions) {
    this._pendingDir = options.pendingDir
    this._logger = options.logger
    this._clock = options.clock
    this._processedKeyLimit = Math.max(
      1,
      Math.floor(options.processedKeyLimit ?? TRIGGER_DEFAULTS.processedKeyLimit),
    )
    this._ttlMs = options.ttlMs ?? TRIGGER_DEFAULTS.processedKeyTtlMs
    this._pruneIntervalMs = Math.max(1_000, options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS)
    this._store =
      options.stateStore ??
      new TriggerStateStore({
        file: options.file,
        logger: options.logger,
        now: () => this._clock.now(),
        timers: {
          setTimeout: (callback, ms) => this._clock.setTimeout(callback, ms),
          clearTimeout: (handle) => this._clock.clearTimeout(handle),
        },
        ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
      })
  }

  get state(): TriggerStateFile {
    return this._state
  }

  async load(): Promise<TriggerStateFile> {
    this._state = await this._store.load()
    // Expire stale keys before the first summary; the maintenance timer only
    // exists while there is something to prune (a fully disabled setup keeps
    // zero trigger timers besides the startup gate).
    this._pruneProcessed()
    this._ensurePruneScheduled()
    return this._state
  }

  stateFor(triggerKey: string): TriggerRuntimeState {
    return this._state.triggers[triggerKey] ?? DEFAULT_TRIGGER_RUNTIME_STATE
  }

  /** Limits shared by baseline seeding and generic dedupe-key writes. */
  pruneOptions(): { readonly limit: number; readonly ttlMs: number } {
    return { limit: this._processedKeyLimit, ttlMs: this._ttlMs }
  }

  /** Limits for one trigger, including a floor raised by an oversized poll round. */
  pruneOptionsFor(triggerKey: string): { readonly limit: number; readonly ttlMs: number } {
    return {
      limit: Math.max(this._processedKeyLimit, this._processedLimitFloors.get(triggerKey) ?? 0),
      ttlMs: this._ttlMs,
    }
  }

  /**
   * A poll round narrower than its output must still record every item. Raise
   * this trigger's effective limit to the round size so the dedupe writes that
   * follow cannot immediately evict those keys again.
   */
  raiseProcessedLimit(triggerKey: string, limit: number): void {
    const normalized = Math.max(1, Math.floor(limit))
    if (normalized <= (this._processedLimitFloors.get(triggerKey) ?? 0)) return
    this._processedLimitFloors.set(triggerKey, normalized)
  }

  pendingRecords(): readonly PendingRunRecord[] {
    return this._state.pending
  }

  /** Run ids whose payload / run directory must survive a retention prune. */
  protectedRunIds(): ReadonlySet<string> {
    return new Set(this._state.pending.map((record) => record.runId))
  }

  setPausedAll(paused: boolean): void {
    if (this._state.pausedAll === paused) return
    this._commit({ ...this._state, pausedAll: paused })
  }

  setTriggerState(triggerKey: string, patch: RuntimeStatePatch): void {
    const current = this.stateFor(triggerKey)
    // Explicit `undefined` means "clear this field"; deleting the key keeps the
    // persisted state free of nulls under exactOptionalPropertyTypes.
    const next: Record<string, unknown> = { ...current }
    let changed = false
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        if (Object.hasOwn(next, key)) {
          delete next[key]
          changed = true
        }
      } else if (next[key] !== value) {
        next[key] = value
        changed = true
      }
    }
    if (!changed) return
    this._commit({
      ...this._state,
      triggers: {
        ...this._state.triggers,
        [triggerKey]: next as unknown as TriggerRuntimeState,
      },
    })
  }

  removeTriggerState(triggerKey: string): void {
    this._processedLimitFloors.delete(triggerKey)
    if (this._state.triggers[triggerKey] === undefined) return
    const triggers = { ...this._state.triggers }
    delete triggers[triggerKey]
    this._commit({ ...this._state, triggers })
  }

  markProcessed(triggerKey: string, eventKey: string, status: 'queued' | 'started'): void {
    const now = this._clock.now()
    const current = this.stateFor(triggerKey).processed
    const updated =
      status === 'queued' ? markQueued(current, eventKey, now) : markStarted(current, eventKey, now)
    this.setTriggerState(triggerKey, {
      processed: prune(updated, now, this.pruneOptionsFor(triggerKey)),
    })
  }

  forgetKey(triggerKey: string, eventKey: string, runId?: string): void {
    const current = this.stateFor(triggerKey).processed
    if (isProcessed(current, eventKey)) {
      this.setTriggerState(triggerKey, { processed: forget(current, eventKey) })
    }
    if (runId !== undefined) this.removePending(runId)
  }

  addPending(record: PendingRunRecord): void {
    if (this._state.pending.some((entry) => entry.runId === record.runId)) return
    this._commit({ ...this._state, pending: [...this._state.pending, record] })
  }

  removePending(runId: string): void {
    const pending = this._state.pending
    if (pending.some((record) => record.runId === runId)) {
      this._commit({ ...this._state, pending: pending.filter((record) => record.runId !== runId) })
    }
    this.removePendingPayload(runId)
  }

  dropPendingForWorkspace(workspaceKey: string): void {
    const removed = this._state.pending.filter(
      (record) => parseTriggerKey(record.triggerKey)?.workspaceKey === workspaceKey,
    )
    if (removed.length === 0) return
    this._commit({
      ...this._state,
      pending: this._state.pending.filter(
        (record) => parseTriggerKey(record.triggerKey)?.workspaceKey !== workspaceKey,
      ),
    })
    for (const record of removed) this.removePendingPayload(record.runId)
  }

  pendingPayloadPath(runId: string): string {
    return join(this._pendingDir, `${runId}.json`)
  }

  async writePendingPayload(runId: string, event: TriggerEvent): Promise<void> {
    await writeJsonAtomic(this.pendingPayloadPath(runId), event)
  }

  async readPendingEvent(pending: {
    readonly runId: string
    readonly triggerId: string
    readonly eventKey: string
    readonly firedAt: number
  }): Promise<TriggerEvent | undefined> {
    let text: string
    try {
      text = await readFile(this.pendingPayloadPath(pending.runId), 'utf8')
    } catch {
      return undefined
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return undefined
    }
    if (typeof raw !== 'object' || raw === null) return undefined
    const payloadRaw = (raw as { payload?: unknown }).payload
    const payload: Record<string, TriggerPayloadValue> = {}
    if (typeof payloadRaw === 'object' && payloadRaw !== null && !Array.isArray(payloadRaw)) {
      for (const [key, value] of Object.entries(payloadRaw)) {
        if (
          typeof value === 'string' ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value))
        ) {
          payload[key] = value
        }
      }
    }
    return {
      triggerId: pending.triggerId,
      key: pending.eventKey,
      payload,
      firedAt: pending.firedAt,
    }
  }

  removePendingPayload(runId: string): void {
    void rm(this.pendingPayloadPath(runId), { force: true }).catch(() => undefined)
  }

  /**
   * Startup cleanup. Trigger keys whose workspace left the registry, and pending
   * records referencing such a key, can never run again; their payload files are
   * deleted too. Payload files without a matching pending record are orphans from
   * a crash between the two writes and are removed as well.
   */
  async startupSweep(registeredWorkspaceKeys: ReadonlySet<string>): Promise<void> {
    const isRegistered = (triggerKey: string): boolean => {
      const parsed = parseTriggerKey(triggerKey)
      return parsed !== undefined && registeredWorkspaceKeys.has(parsed.workspaceKey)
    }
    const triggers: Record<string, TriggerRuntimeState> = {}
    let changed = false
    for (const [triggerKey, value] of Object.entries(this._state.triggers)) {
      if (isRegistered(triggerKey)) triggers[triggerKey] = value
      else changed = true
    }
    const pending = this._state.pending.filter((record) => {
      if (isRegistered(record.triggerKey)) return true
      changed = true
      return false
    })
    if (changed) {
      this._logger.info('trigger state: dropped entries whose workspace is no longer registered')
      this._commit({ ...this._state, triggers, pending })
    }

    const referenced = new Set(pending.map((record) => `${record.runId}.json`))
    let names: string[]
    try {
      names = await readdir(this._pendingDir)
    } catch {
      names = []
    }
    for (const name of names) {
      if (!name.endsWith('.json') || referenced.has(name)) continue
      await rm(join(this._pendingDir, name), { force: true }).catch(() => undefined)
    }
    await this.flushIfPending()
  }

  /** Write immediately when a debounced write is pending; no-op otherwise. */
  flushIfPending(): Promise<void> {
    return this._store.flushIfPending()
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    if (this._pruneTimer !== undefined) {
      this._clock.clearTimeout(this._pruneTimer)
      this._pruneTimer = undefined
    }
    this._store.dispose()
  }

  private _commit(next: TriggerStateFile): void {
    this._state = next
    this._store.set(next)
    this._ensurePruneScheduled()
  }

  private _ensurePruneScheduled(): void {
    if (this._disposed || this._pruneTimer !== undefined || !this._hasProcessedKeys()) return
    this._schedulePeriodicPrune()
  }

  private _hasProcessedKeys(): boolean {
    return Object.values(this._state.triggers).some(
      (state) => Object.keys(state.processed).length > 0,
    )
  }

  private _schedulePeriodicPrune(): void {
    if (this._disposed || this._pruneTimer !== undefined) return
    const timer = this._clock.setTimeout(() => {
      this._pruneTimer = undefined
      this._pruneProcessed()
      if (this._hasProcessedKeys()) this._schedulePeriodicPrune()
    }, this._pruneIntervalMs)
    unrefTimer(timer)
    this._pruneTimer = timer
  }

  private _pruneProcessed(): void {
    const now = this._clock.now()
    let changed = false
    const triggers: Record<string, TriggerRuntimeState> = {}
    for (const [triggerKey, state] of Object.entries(this._state.triggers)) {
      const processed = prune(state.processed, now, this.pruneOptionsFor(triggerKey))
      if (sameProcessed(processed, state.processed)) {
        triggers[triggerKey] = state
      } else {
        triggers[triggerKey] = { ...state, processed }
        changed = true
      }
    }
    if (!changed) return
    this._commit({ ...this._state, triggers })
    this._logger.debug('trigger state: pruned expired dedupe keys')
  }
}

function sameProcessed(left: ProcessedKeys, right: ProcessedKeys): boolean {
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  for (const key of leftKeys) {
    const a = left[key]
    const b = right[key]
    if (a === undefined || b === undefined || a.at !== b.at || a.status !== b.status) return false
  }
  return true
}

/** Payload files are named by run id; a malformed id is never a valid payload. */
export function isPendingPayloadFileName(name: string): boolean {
  return name.endsWith('.json') && isValidTriggerRunId(name.slice(0, -'.json'.length))
}
