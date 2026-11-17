/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The single entry for a run's lifecycle: accept (dedupe + staged payload), enqueue,
 *  start (host routing, trust, run directory, start timeout), end, defer and drop.
 *  Owns the RunQueue slots, the active/queued maps and the end-report watchdog, so no
 *  other module mutates run state directly.
 *
 *  A deferred run is not a failure: its slot is released but the pending payload and
 *  its `queued` dedupe status survive so a reconnect + window can replay it.
 *--------------------------------------------------------------------------------------------*/

import { basename } from 'node:path'
import { localize, REMOTE_SCHEME, type ILogger, type URI } from '@universe-editor/platform'
import type { ITriggerRunHost } from '../../../shared/ipc/triggerService.js'
import { parseWorkspaceUri } from '../../../shared/triggers/configParse.js'
import { RunQueue, type RunQueueOptions } from '../../../shared/triggers/runQueue.js'
import { renderTriggerPrompt } from '../../../shared/triggers/promptTemplate.js'
import { isProcessed } from '../../../shared/triggers/dedupe.js'
import {
  isElevatedModeId,
  TRIGGER_DEFAULTS,
  type TriggerEvent,
  type TriggerRunRequest,
} from '../../../shared/triggers/types.js'
import { parseTriggerKey } from './triggerIdentity.js'
import { DeferredRunError } from './triggerErrors.js'
import type { TriggerClock, TriggerTimerHandle } from './triggerClock.js'
import type { TriggerExecutionBackend } from './triggerExecutionBackend.js'
import type { RuntimeStatePatch } from './triggerStateRepository.js'
import type { PendingRunRecord, TriggerRuntimeState } from './triggerStateStore.js'
import type { RoutedTrigger } from './triggerTypes.js'

/** Mirrors `RunQueueItem`; the queue only needs runId + triggerKey. */
export interface PendingRun {
  readonly runId: string
  readonly triggerKey: string
  /** Bare trigger id (prompt fence, logs, audit). */
  readonly triggerId: string
  /** Workspace URI string (logs / audit only). */
  readonly workspace: string
  readonly eventKey: string
  readonly firedAt: number
}

export interface ActiveRun extends PendingRun {
  phase: 'starting' | 'running'
  /** When the host accepted the run; `firedAt` is the event time and may be earlier. */
  startedAt?: number
  windowId?: number
  sessionId?: string
  watchdogTimer?: TriggerTimerHandle
}

/** Beyond the configured budget before a silent renderer is presumed stuck. */
const WATCHDOG_GRACE_MS = 10 * 60_000

/** Manual events are explicit user actions: pause never gates or drops them. */
function isManualEventKey(eventKey: string): boolean {
  return eventKey.startsWith('manual:')
}

export interface RunLedgerHost {
  readonly logger: ILogger
  readonly clock: TriggerClock
  readonly uuid: () => string
  readonly startRunTimeoutMs: number
  findTrigger(triggerKey: string): RoutedTrigger | undefined
  isRunnable(
    trigger: RoutedTrigger,
    options?: { ignoreBackoff?: boolean; manual?: boolean },
  ): boolean
  isWorkspaceOffline(trigger: RoutedTrigger): boolean
  remoteWindowMissing(trigger: RoutedTrigger): boolean
  resolveHost(trigger: RoutedTrigger): Promise<{ host: ITriggerRunHost; windowId: number }>
  getHost(windowId: number): ITriggerRunHost | undefined
  backendFor(trigger: RoutedTrigger): TriggerExecutionBackend
  workspaceAuthority(workspaceUri: URI): string | undefined
  authorityOfKey(triggerKey: string): string | undefined
  stateFor(triggerKey: string): TriggerRuntimeState
  isPausedAll(): boolean
  setTriggerState(triggerKey: string, patch: RuntimeStatePatch): void
  markProcessed(triggerKey: string, eventKey: string, status: 'queued' | 'started'): void
  forgetKey(triggerKey: string, eventKey: string, runId?: string): void
  removePendingRecord(runId: string): void
  pendingRecords(): readonly PendingRunRecord[]
  stateProtectedRunIds(): ReadonlySet<string>
  isGateOpen(): boolean
  addPending(record: PendingRunRecord): void
  writePendingPayload(runId: string, event: TriggerEvent): Promise<void>
  readPendingEvent(pending: PendingRun): Promise<TriggerEvent | undefined>
  recordFailure(trigger: RoutedTrigger, message: string, now?: number): void
  audit(action: string, result: 'success' | 'failure', detail?: string): void
  fireChange(): void
}

export class TriggerRunLedger {
  private readonly _host: RunLedgerHost
  private readonly _queue = new RunQueue<PendingRun>(TRIGGER_DEFAULTS.maxConcurrentRuns)
  private readonly _active = new Map<string, ActiveRun>()
  private readonly _queued = new Map<string, PendingRun>()
  private _replaying = false
  private _disposed = false

  constructor(host: RunLedgerHost) {
    this._host = host
  }

  stats(triggerKey: string): { readonly running: number; readonly queued: number } {
    return this._queue.stats(triggerKey)
  }

  setGlobalLimit(limit: number): void {
    for (const item of this._queue.setGlobalLimit(limit)) this._beginQueuedRun(item)
  }

  async acceptEvent(
    trigger: RoutedTrigger,
    event: TriggerEvent,
    options: {
      ignoreBackoff?: boolean
      manual?: boolean
      /** Poll keys already represented by this manual event; mark them processed too. */
      consumeKeys?: readonly string[]
    } = {},
  ): Promise<boolean> {
    if (this._disposed) return false
    const host = this._host
    const state = host.stateFor(trigger.key)
    if (host.isPausedAll() || (state.paused && options.manual !== true)) {
      host.logger.info(`trigger ${trigger.id}: event ${event.key} dropped (paused)`)
      return false
    }
    if (!this._isActivated(trigger)) {
      host.logger.info(`trigger ${trigger.id}: event ${event.key} dropped (needs confirmation)`)
      return false
    }
    if (host.isWorkspaceOffline(trigger)) {
      // Disconnected remote workspace = missed time; do not consume the event.
      host.logger.info(`trigger ${trigger.id}: event ${event.key} dropped (remote offline)`)
      return false
    }
    const backoffUntil = state.backoffUntil
    if (!options.ignoreBackoff && backoffUntil !== undefined && host.clock.now() < backoffUntil) {
      // Swarm events in particular must stay unconsumed: no key is marked, so the
      // next report after the backoff ends triggers them normally.
      host.logger.info(`trigger ${trigger.id}: event ${event.key} dropped (backoff)`)
      return false
    }
    if (isProcessed(state.processed, event.key)) {
      host.logger.info(`trigger ${trigger.id}: duplicate event ${event.key} ignored`)
      return false
    }

    // Only keys this call actually reserves may be rolled back below; a key a
    // concurrent poll already marked must survive a staging failure.
    const consumeKeys = [
      ...new Set((options.consumeKeys ?? []).filter((key) => !isProcessed(state.processed, key))),
    ]

    const pending: PendingRun = {
      runId: host.uuid(),
      triggerKey: trigger.key,
      triggerId: trigger.id,
      workspace: trigger.workspace,
      eventKey: event.key,
      firedAt: event.firedAt,
    }
    // Reserve the key synchronously, before the await below: two concurrent
    // reports must not both pass the dedupe check.
    host.markProcessed(trigger.key, event.key, 'queued')
    for (const key of consumeKeys) host.markProcessed(trigger.key, key, 'queued')
    try {
      await host.writePendingPayload(pending.runId, event)
    } catch (err) {
      host.logger.warn(
        `trigger ${trigger.id}: cannot stage event ${event.key}: ${describeError(err)}`,
      )
      host.forgetKey(trigger.key, event.key)
      for (const key of consumeKeys) host.forgetKey(trigger.key, key)
      host.recordFailure(
        trigger,
        localize('triggers.error.pendingWriteFailed', 'Could not stage the trigger event on disk'),
      )
      return false
    }

    host.addPending(toPendingRecord(pending))

    const result = this._queue.enqueue(pending, this._queueOptions(trigger))
    switch (result.status) {
      case 'started':
        this._active.set(pending.runId, { ...pending, phase: 'starting' })
        void this._startRun(pending)
        break
      case 'queued':
        this._queued.set(pending.runId, pending)
        host.logger.info(`trigger ${trigger.id}: event ${event.key} queued run=${pending.runId}`)
        break
      case 'dropped':
        host.logger.info(`trigger ${trigger.id}: event ${event.key} dropped (overflow)`)
        this._dropPending(pending)
        break
      case 'dropped-oldest':
        host.logger.info(
          `trigger ${trigger.id}: event ${event.key} queued run=${pending.runId} (queue full, dropped ${result.dropped.runId})`,
        )
        this._dropPending(result.dropped)
        this._queued.set(pending.runId, pending)
        break
    }
    host.fireChange()
    return true
  }

  /** End-report hook: stop watchdog, forget the tracking entry and free its slot. */
  takeRun(runId: string): ActiveRun | undefined {
    const entry = this._active.get(runId)
    if (entry === undefined) return undefined
    this._clearWatchdog(entry)
    this._active.delete(runId)
    this._releaseSlot(runId)
    return entry
  }

  /** Fail every active run bound to a window that went away (reload / crash / close). */
  failRunsForWindow(windowId: number, message: string): void {
    for (const entry of [...this._active.values()]) {
      if (entry.windowId !== windowId) continue
      this._host.logger.warn(
        `run ${entry.runId}: failed trigger=${entry.triggerId} key=${entry.eventKey}: ${message}`,
      )
      this._failActiveRun(entry.runId, message)
    }
  }

  /** Pause: drop automatic (non-manual) queued events; manual runs survive. */
  dropAutomaticQueued(triggerKey: string): void {
    const dropped = this._queue.remove(triggerKey, (item) => !isManualEventKey(item.eventKey))
    for (const pending of dropped) this._dropPending(pending)
  }

  dropAllQueued(): void {
    this._queue.clear()
    for (const pending of [...this._queued.values()]) this._dropPending(pending)
    this._queued.clear()
  }

  /** Queue slots currently held by a matching trigger (workspace teardown). */
  queuedTriggerKeys(matches: (triggerKey: string) => boolean): readonly string[] {
    const keys = new Set<string>()
    for (const pending of this._queued.values()) {
      if (matches(pending.triggerKey)) keys.add(pending.triggerKey)
    }
    return [...keys]
  }

  /** Drop the RunQueue slots of one trigger; queued records are handled separately. */
  clearTriggerQueue(triggerKey: string): void {
    this._queue.clear(triggerKey)
  }

  dropQueuedForWorkspace(matches: (triggerKey: string) => boolean, keepPending: boolean): void {
    for (const pending of [...this._queued.values()]) {
      if (!matches(pending.triggerKey)) continue
      this._queued.delete(pending.runId)
      if (!keepPending) {
        this._host.forgetKey(pending.triggerKey, pending.eventKey, pending.runId)
      }
    }
  }

  /** Run ids a prune must never delete (`state.json` records + live runs). */
  protectedRunIds(stateRunIds: readonly string[]): ReadonlySet<string> {
    const ids = new Set<string>(stateRunIds)
    for (const runId of this._active.keys()) ids.add(runId)
    for (const runId of this._queued.keys()) ids.add(runId)
    return ids
  }

  /** Active / queued / pending run ids of one authority for a remote prune. */
  protectedRunIdsForAuthority(authority: string): readonly string[] {
    const ids = new Set<string>()
    const collect = (runId: string, triggerKey: string): void => {
      if (this._host.authorityOfKey(triggerKey) === authority) ids.add(runId)
    }
    for (const run of this._active.values()) collect(run.runId, run.triggerKey)
    for (const run of this._queued.values()) collect(run.runId, run.triggerKey)
    for (const record of this._host.pendingRecords()) collect(record.runId, record.triggerKey)
    return [...ids]
  }

  async replayPendingRuns(): Promise<void> {
    if (!this._host.isGateOpen()) return
    if (this._disposed || this._replaying) return
    this._replaying = true
    try {
      const host = this._host
      for (const record of [...host.pendingRecords()]) {
        if (this._queued.has(record.runId) || this._active.has(record.runId)) continue
        const entry = host.stateFor(record.triggerKey).processed[record.eventKey]
        if (entry === undefined || entry.status !== 'queued') {
          // Already started before the restart: never replay.
          host.removePendingRecord(record.runId)
          continue
        }
        const trigger = host.findTrigger(record.triggerKey)
        const manual = isManualEventKey(record.eventKey)
        if (trigger === undefined || !host.isRunnable(trigger, { manual })) {
          // Keep the record untouched: a later resume / confirmation / backoff
          // expiry replays it.
          host.logger.info(
            `pending run ${record.runId}: kept for trigger ${parseTriggerKey(record.triggerKey)?.triggerId ?? record.triggerKey} (not runnable)`,
          )
          continue
        }
        const pending: PendingRun = {
          runId: record.runId,
          triggerKey: record.triggerKey,
          triggerId: trigger.id,
          workspace: trigger.workspace,
          eventKey: record.eventKey,
          firedAt: record.firedAt,
        }
        if ((await host.readPendingEvent(pending)) === undefined) {
          host.logger.warn(`pending run ${record.runId}: payload missing, forgetting the event`)
          host.forgetKey(record.triggerKey, record.eventKey, record.runId)
          continue
        }
        const result = this._queue.enqueue(pending, this._queueOptions(trigger))
        switch (result.status) {
          case 'started':
            this._active.set(pending.runId, { ...pending, phase: 'starting' })
            void this._startRun(pending)
            break
          case 'queued':
            this._queued.set(pending.runId, pending)
            break
          case 'dropped':
            this._dropPending(pending)
            break
          case 'dropped-oldest':
            this._dropPending(result.dropped)
            this._queued.set(pending.runId, pending)
            break
        }
        host.logger.info(
          `pending run ${record.runId}: re-enqueued trigger=${parseTriggerKey(record.triggerKey)?.triggerId ?? record.triggerKey}`,
        )
      }
    } finally {
      this._replaying = false
    }
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    for (const run of this._active.values()) this._clearWatchdog(run)
    this._active.clear()
    this._queued.clear()
  }

  private _isActivated(trigger: RoutedTrigger): boolean {
    return this._host.stateFor(trigger.key).activationConfirmed === trigger.fingerprint
  }

  private _queueOptions(trigger: RoutedTrigger): RunQueueOptions {
    return {
      concurrency: trigger.concurrency,
      overflow: trigger.overflow,
      queueLimit: TRIGGER_DEFAULTS.queueLimit,
    }
  }

  private async _startRun(pending: PendingRun): Promise<void> {
    const host = this._host
    const trigger = host.findTrigger(pending.triggerKey)
    // Pause / disable / confirmation may have landed while the run sat in the queue:
    // those are not failures, so release the slot and forget the key quietly.
    const manual = isManualEventKey(pending.eventKey)
    if (trigger === undefined || !host.isRunnable(trigger, { manual })) {
      if (trigger !== undefined && host.isWorkspaceOffline(trigger)) {
        // Disconnect after acceptance: the event stays pending for a replay.
        this._deferRun(pending, 'remote workspace went offline')
        return
      }
      if (trigger !== undefined && host.remoteWindowMissing(trigger)) {
        // The window went away after acceptance: keep the event for its return.
        this._deferRun(pending, 'no open window holds this remote workspace')
        return
      }
      host.logger.info(
        `run ${pending.runId}: not started trigger=${pending.triggerId} key=${pending.eventKey} (no longer runnable)`,
      )
      this._active.delete(pending.runId)
      this._releaseSlot(pending.runId)
      host.forgetKey(pending.triggerKey, pending.eventKey, pending.runId)
      host.fireChange()
      return
    }
    try {
      const event = await host.readPendingEvent(pending)
      if (event === undefined) {
        throw new Error(
          localize(
            'triggers.error.pendingEventLost',
            'The queued trigger event is no longer available',
          ),
        )
      }
      const { host: runHost, windowId } = await host.resolveHost(trigger)
      const beforeStart = this._active.get(pending.runId)
      if (beforeStart === undefined) return
      beforeStart.windowId = windowId
      // Trust is checked before anything is written to disk for this run. The
      // probe is a renderer round-trip: it gets the same timeout as startRun so a
      // wedged window cannot hold the queue slot forever.
      const trusted = await this._withHostTimeout(
        runHost.isWorkspaceTrusted(trigger.workspace),
        pending.runId,
        'trust check',
      )
      if (trusted === undefined) {
        throw new Error(
          localize(
            'triggers.error.hostUnresponsive',
            'The editor window did not respond in time ({action})',
            { action: 'trust check' },
          ),
        )
      }
      if (!trusted) {
        throw new Error(
          localize('triggers.error.workspaceUntrusted', 'The workspace is not trusted'),
        )
      }
      const authority = host.workspaceAuthority(trigger.workspaceUri)
      const backend = host.backendFor(trigger)
      const protectedRunIds =
        authority === undefined
          ? [...this.protectedRunIds([...host.stateProtectedRunIds()])]
          : this.protectedRunIdsForAuthority(authority)
      const created = await this._withHostTimeout(
        backend.createRunDir(trigger, pending.runId, protectedRunIds),
        pending.runId,
        'run directory',
      )
      if (created === undefined) {
        if (!backend.isAvailable()) {
          throw new DeferredRunError(`remote '${authority}' went away while creating the run dir`)
        }
        throw new Error(
          localize(
            'triggers.error.hostUnresponsive',
            'The editor window did not respond in time ({action})',
            { action: 'run directory' },
          ),
        )
      }
      if (created.kind === 'unavailable') throw new DeferredRunError(created.reason)
      const runDir = created.runDir
      const request = this._buildRunRequest(trigger, pending, event, runDir, authority)
      const result = await this._startHostRun(runHost, request, pending.runId)
      if (result === undefined) {
        throw new Error(
          localize(
            'triggers.error.startRunTimeout',
            'The editor window did not start the run in time',
          ),
        )
      }
      if (!this._active.has(pending.runId)) {
        // The run already reported its end (or was failed) before the host answered.
        // Book the event as started and drop its pending payload anyway: leaving it
        // queued would make a restart replay an event whose run is already over.
        host.markProcessed(trigger.key, pending.eventKey, 'started')
        host.removePendingRecord(pending.runId)
        void runHost.cancelRun(pending.runId).catch(() => undefined)
        return
      }
      host.markProcessed(trigger.key, pending.eventKey, 'started')
      host.removePendingRecord(pending.runId)
      const active = this._active.get(pending.runId)
      if (active !== undefined) {
        active.phase = 'running'
        active.startedAt = host.clock.now()
        active.sessionId = result.sessionId
        this._armWatchdog(active, trigger)
      }
      host.logger.info(
        `run ${pending.runId}: started trigger=${trigger.id} key=${pending.eventKey} session=${result.sessionId}`,
      )
      host.audit(
        'run-start',
        'success',
        `trigger=${trigger.id} key=${pending.eventKey} run=${pending.runId} session=${result.sessionId}`,
      )
      host.fireChange()
    } catch (err) {
      if (err instanceof DeferredRunError) {
        this._deferRun(pending, err.reason)
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      host.logger.warn(
        `run ${pending.runId}: start failed trigger=${pending.triggerId} key=${pending.eventKey}: ${message}`,
      )
      this._failActiveRun(pending.runId, message)
    }
  }

  /**
   * Release the queue slot but keep the durable pending record and its `queued`
   * dedupe status: reconnect + an open window replays it. Never a failure, never
   * a backoff (docs/development/triggers.md §4 "deferred").
   */
  private _deferRun(pending: PendingRun, reason: string): void {
    const host = this._host
    const active = this._active.get(pending.runId)
    if (active !== undefined) {
      this._clearWatchdog(active)
      this._active.delete(pending.runId)
    }
    this._releaseSlot(pending.runId)
    host.logger.info(
      `run ${pending.runId}: deferred trigger=${pending.triggerId} key=${pending.eventKey} (${reason}); the event stays pending`,
    )
    host.fireChange()
  }

  /**
   * A renderer that dies without closing its window (reload loop, OOM without a
   * clean unload) never reports its run end. Past the configured budget plus a
   * grace period the run is failed and the host is asked to cancel.
   */
  private _armWatchdog(run: ActiveRun, trigger: RoutedTrigger): void {
    this._clearWatchdog(run)
    const budgetMs =
      (trigger.session.budget.timeoutMin + trigger.session.budget.approvalTimeoutMin) * 60_000
    const deadline = this._host.clock.now() + Math.max(0, budgetMs) + WATCHDOG_GRACE_MS
    run.watchdogTimer = this._host.clock.setTimeout(
      () => {
        run.watchdogTimer = undefined
        this._onWatchdog(run.runId)
      },
      Math.max(0, deadline - this._host.clock.now()),
    )
  }

  private _clearWatchdog(run: ActiveRun): void {
    if (run.watchdogTimer !== undefined) {
      this._host.clock.clearTimeout(run.watchdogTimer)
      run.watchdogTimer = undefined
    }
  }

  private _onWatchdog(runId: string): void {
    const host = this._host
    const entry = this._active.get(runId)
    if (entry === undefined) return
    const trigger = host.findTrigger(entry.triggerKey)
    const budget = trigger?.session.budget ?? TRIGGER_DEFAULTS.budget
    host.logger.warn(
      `run ${runId}: no end report after ${budget.timeoutMin + budget.approvalTimeoutMin}min budget + ${WATCHDOG_GRACE_MS}ms grace trigger=${entry.triggerId} key=${entry.eventKey}`,
    )
    const runHost = entry.windowId === undefined ? undefined : host.getHost(entry.windowId)
    if (runHost !== undefined) {
      void runHost.cancelRun(runId).catch((err: unknown) => {
        host.logger.warn(`run ${runId}: watchdog cancel failed: ${describeError(err)}`)
      })
    }
    this._failActiveRun(
      runId,
      localize('triggers.error.runWatchdog', 'The automated run did not report its end in time'),
    )
  }

  /**
   * Bound every renderer / remote round-trip before `startRun` with the same
   * timeout: one wedged window must not hold a queue slot forever. Returns
   * `undefined` when the deadline passed; the caller records the failure (which
   * frees the slot) and the abandoned promise's rejection is swallowed.
   */
  private async _withHostTimeout<T>(
    call: Promise<T>,
    runId: string,
    label: string,
  ): Promise<T | undefined> {
    let timedOut = false
    let timer: TriggerTimerHandle | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = this._host.clock.setTimeout(() => {
        timedOut = true
        resolve(undefined)
      }, this._host.startRunTimeoutMs)
    })
    const answered = call.then(
      (value) => (timedOut ? undefined : value),
      (err: unknown) => {
        if (timedOut) {
          this._host.logger.warn(
            `run ${runId}: ${label} failed after the timeout: ${describeError(err)}`,
          )
          return undefined
        }
        throw err
      },
    )
    const result = await Promise.race([answered, timeout])
    if (timer !== undefined) this._host.clock.clearTimeout(timer)
    return result
  }

  /**
   * `host.startRun` has no transport timeout, so a wedged renderer would hold its
   * queue slot forever. On timeout the run is failed by the caller (slot released,
   * backoff recorded); a renderer that finishes starting later must not resurrect
   * an untracked session, so its session is cancelled and the result dropped.
   */
  private async _startHostRun(
    host: ITriggerRunHost,
    request: TriggerRunRequest,
    runId: string,
  ): Promise<{ readonly sessionId: string } | undefined> {
    let timedOut = false
    let timer: TriggerTimerHandle | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = this._host.clock.setTimeout(() => {
        timedOut = true
        resolve(undefined)
      }, this._host.startRunTimeoutMs)
    })
    const started = host.startRun(request).then(
      (result) => {
        if (timedOut) {
          this._host.logger.warn(`run ${runId}: renderer started it after the timeout; cancelling`)
          void host.cancelRun(runId).catch((err: unknown) => {
            this._host.logger.warn(`run ${runId}: late cancel failed: ${describeError(err)}`)
          })
          return undefined
        }
        return result
      },
      (err: unknown) => {
        if (timedOut) {
          this._host.logger.warn(
            `run ${runId}: renderer reported a start failure after the timeout`,
          )
          return undefined
        }
        throw err
      },
    )
    const result = await Promise.race([started, timeout])
    if (timer !== undefined) this._host.clock.clearTimeout(timer)
    return result
  }

  private _buildRunRequest(
    trigger: RoutedTrigger,
    pending: PendingRun,
    event: TriggerEvent,
    runDir: string,
    authority: string | undefined,
  ): TriggerRunRequest {
    const session = trigger.session
    // Host-native path: the renderer hands it to the agent session as-is.
    const cwd = this._host.backendFor(trigger).resolveCwd(trigger)
    const promptOptions = {
      trigger: { id: trigger.id, name: trigger.name },
      template: session.prompt,
      event,
      runDir,
      ...(session.skill === undefined ? {} : { skill: session.skill }),
    }
    const prompt = renderTriggerPrompt(promptOptions)
    const promptForSystemContract = renderTriggerPrompt({
      ...promptOptions,
      outputContract: 'system',
    })
    const fingerprint = trigger.fingerprint
    const state = this._host.stateFor(trigger.key)
    // Bypass-class modes are covered by the single activation confirmation; the
    // renderer must never grant them on an unconfirmed definition.
    const elevated = isElevatedModeId(session.mode) && state.activationConfirmed === fingerprint
    return {
      origin: {
        triggerId: trigger.id,
        triggerName: trigger.name,
        workspaceName: workspaceFolderName(trigger.workspace),
        eventKey: pending.eventKey,
        runId: pending.runId,
      },
      ...(session.agent === undefined ? {} : { agentId: session.agent }),
      showSession: trigger.showSession,
      cwd,
      ...(authority === undefined ? {} : { authority }),
      ...(session.mode === undefined ? {} : { mode: session.mode }),
      allowElevatedMode: elevated,
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(session.mcpServers === undefined ? {} : { mcpServerNames: session.mcpServers }),
      prompt,
      promptForSystemContract,
      runDir,
      budget: session.budget,
    }
  }

  private _releaseSlot(runId: string): void {
    for (const item of this._queue.complete(runId)) this._beginQueuedRun(item)
  }

  private _beginQueuedRun(item: PendingRun): void {
    const host = this._host
    this._queued.delete(item.runId)
    if (this._active.has(item.runId)) return
    const trigger = host.findTrigger(item.triggerKey)
    const manual = isManualEventKey(item.eventKey)
    if (trigger === undefined || !host.isRunnable(trigger, { manual })) {
      if (
        trigger !== undefined &&
        (host.isWorkspaceOffline(trigger) || host.remoteWindowMissing(trigger))
      ) {
        // The drain that produced this item already claimed a slot: release it.
        // Keep the pending record and its `queued` dedupe status so a reconnect
        // (plus an open window) replays the event; never a failure.
        const reason = host.isWorkspaceOffline(trigger)
          ? 'remote workspace went offline'
          : 'no open window holds this remote workspace'
        host.logger.info(
          `run ${item.runId}: deferred trigger=${item.triggerId} key=${item.eventKey} (${reason})`,
        )
        this._releaseSlot(item.runId)
        host.fireChange()
        return
      }
      // Paused / disabled while queued: not a failure, just drop the reservation.
      host.logger.info(
        `run ${item.runId}: dropped trigger=${item.triggerId} key=${item.eventKey} (no longer runnable)`,
      )
      host.forgetKey(item.triggerKey, item.eventKey, item.runId)
      this._releaseSlot(item.runId)
      host.fireChange()
      return
    }
    this._active.set(item.runId, { ...item, phase: 'starting' })
    void this._startRun(item)
  }

  private _dropPending(pending: PendingRun): void {
    this._queued.delete(pending.runId)
    this._host.forgetKey(pending.triggerKey, pending.eventKey, pending.runId)
  }

  private _failActiveRun(runId: string, message: string): void {
    const host = this._host
    const entry = this._active.get(runId)
    if (entry === undefined) return
    this._clearWatchdog(entry)
    this._active.delete(runId)
    this._releaseSlot(runId)
    host.forgetKey(entry.triggerKey, entry.eventKey, runId)
    const trigger = host.findTrigger(entry.triggerKey)
    if (trigger === undefined) {
      host.fireChange()
      return
    }
    host.recordFailure(trigger, message, host.clock.now())
    host.fireChange()
  }
}

function toPendingRecord(pending: PendingRun): PendingRunRecord {
  return {
    runId: pending.runId,
    triggerKey: pending.triggerKey,
    eventKey: pending.eventKey,
    firedAt: pending.firedAt,
  }
}

function workspaceFolderName(workspace: string): string {
  const uri = parseWorkspaceUri(workspace)
  if (uri === undefined) {
    const name = basename(workspace)
    return name.length > 0 ? name : workspace
  }
  const name = basename(uri.path)
  // Two hosts can expose the same path; keep the authority in the label. The
  // renderer shows the same `name (authority)` shape for remote workspaces.
  if (uri.scheme === REMOTE_SCHEME) {
    return name.length > 0 ? `${name} (${uri.authority})` : `${uri.authority}`
  }
  return name.length > 0 ? name : workspace
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
