/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Application-singleton trigger scheduler. Owns the config file, the persistent
 *  dedupe/backoff state, one wake-up timer, poll fetching, run queueing and the
 *  window routing that hands a run to a renderer's ITriggerRunHost.
 *  Design: docs/development/triggers-design.md
 *
 *  Logging rule: triggerId / event key / runId / sessionId only — never an event
 *  payload, prompt, verdict summary or command output.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  Disposable,
  Emitter,
  generateUuid,
  localize,
  URI,
  type Event,
  type ILogger,
  type IOpenWindowInfo,
} from '@universe-editor/platform'
import {
  swarmReviewEvent,
  type ITriggerRunHost,
  type ITriggerMainService,
  type SwarmNeedsActionReview,
} from '../../../shared/ipc/triggerService.js'
import {
  TRIGGER_DEFAULTS,
  type TriggerConfig,
  type TriggerEvent,
  type TriggerPayloadValue,
  type TriggerRunEnd,
  type TriggerRunRequest,
  type TriggerStatus,
  type TriggerSummary,
  type TriggersConfig,
} from '../../../shared/triggers/types.js'
import {
  computeDue,
  DEFAULT_MISSED_GRACE_MS,
  type ScheduleSourceConfig,
} from '../../../shared/triggers/scheduler.js'
import {
  forget,
  isProcessed,
  markQueued,
  markStarted,
  prune,
  type ProcessedKeys,
} from '../../../shared/triggers/dedupe.js'
import { RunQueue, type RunQueueOptions } from '../../../shared/triggers/runQueue.js'
import { nextBackoffMs, shouldAutoPause } from '../../../shared/triggers/backoff.js'
import { renderTriggerPrompt } from '../../../shared/triggers/promptTemplate.js'
import { isElevatedMode, triggerFingerprint } from '../../../shared/triggers/configParse.js'
import { AuditLog } from '../mobileGateway/auditLog.js'
import { JsonConfigFileStore, type JsonConfigFileState } from '../jsonConfig/jsonConfigFileStore.js'
import { writeJsonAtomic } from '../jsonConfig/atomicFile.js'
import {
  findWorkspaceHost,
  isSameWorkspace,
  listWorkspaceWindows,
  waitForWorkspaceHost,
  type WorkspaceHostDirectory,
} from '../window/workspaceWindowRouting.js'
import {
  createEmptyTriggersConfig,
  ensureTriggersConfigFile,
  readTriggersConfigFile,
  serializeTriggersConfig,
  triggersConfigPath,
  triggersDirectory,
} from './triggersConfigFile.js'
import {
  createEmptyTriggerStateFile,
  DEFAULT_TRIGGER_RUNTIME_STATE,
  TriggerStateStore,
  type PendingRunRecord,
  type TriggerRuntimeState,
  type TriggerStateFile,
} from './triggerStateStore.js'
import { createPollCommandFetcher, type PollCommandFetcher } from './pollCommandFetcher.js'

export type TriggerTimerHandle = unknown

/** Everything time-based goes through this so tests can run on a fake clock. */
export interface TriggerClock {
  now(): number
  setTimeout(callback: () => void, ms: number): TriggerTimerHandle
  clearTimeout(handle: TriggerTimerHandle): void
}

export const systemTriggerClock: TriggerClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Subset of `WindowMainService` the scheduler needs; set after windows are built. */
export interface TriggerWindowProvider {
  getOpenWindowInfos(): readonly IOpenWindowInfo[]
  openWindowForFolderInBackground(folder: URI): Promise<void>
}

export interface TriggerMainServiceOptions {
  readonly userDataDir: string
  readonly logger: ILogger
  readonly clock?: TriggerClock
  /** Electron `Notification` in production; a spy in tests. */
  readonly notify?: (title: string, body: string) => void
  readonly fetchPollItems?: PollCommandFetcher
  readonly auditLog?: AuditLog
  readonly uuid?: () => string
  readonly startupGraceMs?: number
  readonly hostWaitTimeoutMs?: number
  readonly hostWaitPollMs?: number
  readonly stateDebounceMs?: number
  readonly maxRunDirectories?: number
}

/** Mirrors `RunQueueItem`; the queue only needs runId + triggerId. */
interface PendingRun {
  readonly runId: string
  readonly triggerId: string
  readonly eventKey: string
  readonly firedAt: number
}

interface ActiveRun extends PendingRun {
  phase: 'starting' | 'running'
  windowId?: number
  sessionId?: string
}

type RuntimeStatePatch = {
  readonly [K in keyof TriggerRuntimeState]?: TriggerRuntimeState[K] | undefined
}

const PRUNE_OPTIONS = {
  limit: TRIGGER_DEFAULTS.processedKeyLimit,
  ttlMs: TRIGGER_DEFAULTS.processedKeyTtlMs,
} as const

const DEFAULT_MAX_RUN_DIRECTORIES = 200
const DEFAULT_HOST_WAIT_TIMEOUT_MS = 60_000

export class TriggerMainService extends Disposable implements ITriggerMainService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _clock: TriggerClock
  private readonly _notify: (title: string, body: string) => void
  private readonly _fetchPollItems: PollCommandFetcher
  private readonly _uuid: () => string
  private readonly _startupGraceMs: number
  private readonly _hostWaitTimeoutMs: number
  private readonly _hostWaitPollMs: number | undefined
  private readonly _maxRunDirectories: number
  private readonly _dir: string
  private readonly _configFile: string
  private readonly _runsDir: string
  private readonly _pendingDir: string
  private readonly _auditLog: AuditLog
  private readonly _configStore: JsonConfigFileStore<TriggersConfig>
  private readonly _stateStore: TriggerStateStore
  private readonly _queue = new RunQueue<PendingRun>(TRIGGER_DEFAULTS.maxConcurrentRuns)
  private readonly _onDidChangeTriggers = this._register(new Emitter<readonly TriggerSummary[]>())
  readonly onDidChangeTriggers: Event<readonly TriggerSummary[]> = this._onDidChangeTriggers.event

  private _config: TriggersConfig = createEmptyTriggersConfig()
  private _state: TriggerStateFile = createEmptyTriggerStateFile()
  private _windows: TriggerWindowProvider | undefined
  private readonly _hosts = new Map<number, ITriggerRunHost>()
  private readonly _active = new Map<string, ActiveRun>()
  private readonly _queued = new Map<string, PendingRun>()
  private readonly _armedSchedule = new Map<string, number>()
  private readonly _nextPoll = new Map<string, number>()
  private readonly _startedAt: number
  private _firstHostAt: number | undefined
  private _gateDeadline: number | undefined
  private _gateTimer: TriggerTimerHandle | undefined
  private _gateOpen = false
  private _wakeTimer: TriggerTimerHandle | undefined
  private readonly _ready: Promise<void>
  private _disposed = false

  constructor(options: TriggerMainServiceOptions) {
    super()
    this._logger = options.logger
    this._clock = options.clock ?? systemTriggerClock
    this._notify = options.notify ?? (() => undefined)
    this._fetchPollItems = options.fetchPollItems ?? createPollCommandFetcher(options.logger)
    this._uuid = options.uuid ?? generateUuid
    this._startupGraceMs = Math.max(0, options.startupGraceMs ?? TRIGGER_DEFAULTS.startupGraceMs)
    this._hostWaitTimeoutMs = Math.max(0, options.hostWaitTimeoutMs ?? DEFAULT_HOST_WAIT_TIMEOUT_MS)
    this._hostWaitPollMs = options.hostWaitPollMs
    this._maxRunDirectories = Math.max(1, options.maxRunDirectories ?? DEFAULT_MAX_RUN_DIRECTORIES)
    this._dir = triggersDirectory(options.userDataDir)
    this._configFile = triggersConfigPath(options.userDataDir)
    this._runsDir = join(this._dir, 'runs')
    this._pendingDir = join(this._dir, 'pending')
    this._startedAt = this._clock.now()
    this._auditLog =
      options.auditLog ??
      new AuditLog(join(this._dir, 'audit.jsonl'), { now: () => this._clock.now() })
    this._stateStore = new TriggerStateStore({
      file: join(this._dir, 'state.json'),
      logger: options.logger,
      now: () => this._clock.now(),
      ...(options.stateDebounceMs === undefined ? {} : { debounceMs: options.stateDebounceMs }),
    })
    this._configStore = this._register(
      new JsonConfigFileStore<TriggersConfig>({
        file: this._configFile,
        logger: options.logger,
        directoryLabel: 'triggers config',
        createDefault: createEmptyTriggersConfig,
        read: readTriggersConfigFile,
        serialize: serializeTriggersConfig,
      }),
    )
    this._register(this._configStore.onDidChangeExternal((state) => this._applyConfig(state)))
    this._ready = this._initialize()
  }

  /** Main-internal: resolves once the config and state files have been read. */
  initialize(): Promise<void> {
    return this._ready.catch(() => undefined)
  }

  // ---- ITriggerMainService -------------------------------------------------

  async listTriggers(): Promise<readonly TriggerSummary[]> {
    await this._awaitReady()
    return this._summaries()
  }

  async runNow(triggerId: string): Promise<void> {
    await this._awaitReady()
    const trigger = this._requireTrigger(triggerId)
    if (this._state.pausedAll) {
      throw new Error(localize('triggers.error.allPaused', 'All triggers are paused'))
    }
    if (this._stateFor(trigger.id).paused) {
      throw new Error(localize('triggers.error.triggerPaused', 'This trigger is paused'))
    }
    if (this._needsConfirmation(trigger)) {
      throw new Error(
        localize(
          'triggers.error.needsConfirmation',
          'Confirm the elevated mode for this trigger before running it',
        ),
      )
    }
    const event: TriggerEvent = {
      triggerId: trigger.id,
      key: `manual:${this._uuid()}`,
      payload: {},
      firedAt: this._clock.now(),
    }
    this._logger.info(`trigger ${trigger.id}: manual event ${event.key}`)
    await this._acceptEvent(trigger, event)
  }

  async setPaused(triggerId: string, paused: boolean): Promise<void> {
    await this._awaitReady()
    const trigger = this._requireTrigger(triggerId)
    this._setTriggerState(
      trigger.id,
      paused
        ? { paused: true, lastError: undefined }
        : { paused: false, consecutiveFailures: 0, backoffUntil: undefined, lastError: undefined },
    )
    this._logger.info(`trigger ${trigger.id}: ${paused ? 'paused' : 'resumed'} by the user`)
    this._audit(paused ? 'trigger-paused' : 'trigger-resumed', 'success', `trigger=${trigger.id}`)
    this._syncTiming(this._clock.now())
    this._fireChange()
  }

  async setAllPaused(paused: boolean): Promise<void> {
    await this._awaitReady()
    this._state = { ...this._state, pausedAll: paused }
    this._stateStore.set(this._state)
    if (paused) {
      this._dropQueuedRuns()
      this._armedSchedule.clear()
      this._nextPoll.clear()
      this._rescheduleWake()
    } else {
      this._syncTiming(this._clock.now())
    }
    this._logger.info(`all triggers ${paused ? 'paused' : 'resumed'} by the user`)
    this._audit(paused ? 'all-paused' : 'all-resumed', 'success')
    this._fireChange()
  }

  async confirmElevatedMode(triggerId: string): Promise<void> {
    await this._awaitReady()
    const trigger = this._requireTrigger(triggerId)
    if (!isElevatedMode(trigger.session.mode)) {
      throw new Error(
        localize('triggers.error.notElevatedMode', 'This trigger does not use a bypass-class mode'),
      )
    }
    const fingerprint = triggerFingerprint(trigger)
    this._setTriggerState(trigger.id, { elevatedConfirmed: fingerprint })
    this._logger.info(`trigger ${trigger.id}: elevated mode confirmed fingerprint=${fingerprint}`)
    this._audit(
      'confirm-elevated-mode',
      'success',
      `trigger=${trigger.id} fingerprint=${fingerprint}`,
    )
    this._fireChange()
  }

  async confirmAutoApprove(triggerId: string): Promise<void> {
    await this._awaitReady()
    const trigger = this._requireTrigger(triggerId)
    if (!trigger.allowedActions.includes('swarm.approve')) {
      throw new Error(
        localize(
          'triggers.error.approveNotAllowed',
          'This trigger does not allow the swarm.approve action',
        ),
      )
    }
    const fingerprint = triggerFingerprint(trigger)
    this._setTriggerState(trigger.id, { approveConfirmed: fingerprint })
    this._logger.info(
      `trigger ${trigger.id}: automatic approve confirmed fingerprint=${fingerprint}`,
    )
    this._audit(
      'confirm-auto-approve',
      'success',
      `trigger=${trigger.id} fingerprint=${fingerprint}`,
    )
    this._fireChange()
  }

  async ensureConfigFile(): Promise<string> {
    await this._awaitReady()
    try {
      const created = await ensureTriggersConfigFile(this._configFile)
      if (created) this._logger.info('created the example triggers.json')
    } catch (err) {
      this._logger.warn(`failed to create triggers.json: ${describeError(err)}`)
      throw new Error(
        localize(
          'triggers.error.configWriteFailed',
          'Could not create the trigger configuration file',
        ),
      )
    }
    return URI.file(this._configFile).toString()
  }

  getConfigFileUri(): Promise<string> {
    return Promise.resolve(URI.file(this._configFile).toString())
  }

  async reportRunEnd(end: TriggerRunEnd): Promise<void> {
    await this._awaitReady()
    const entry = this._active.get(end.runId)
    if (entry === undefined) {
      this._logger.warn(`run ${end.runId}: end report ignored (not tracked)`)
      return
    }
    this._active.delete(end.runId)
    this._releaseSlot(end.runId)

    const now = this._clock.now()
    const failed = end.outcome === 'failed'
    const message = failed
      ? (end.error ?? localize('triggers.error.runFailed', 'The automated run failed'))
      : undefined
    const detail = [
      `trigger=${entry.triggerId}`,
      `key=${entry.eventKey}`,
      `run=${end.runId}`,
      `session=${end.sessionId ?? '-'}`,
      `outcome=${end.outcome}`,
      `verdict=${end.verdict ?? '-'}`,
      `actions=${formatActions(end)}`,
    ].join(' ')
    this._audit('run-end', failed ? 'failure' : 'success', detail)
    this._logger.info(
      `run ${end.runId}: ended trigger=${entry.triggerId} key=${entry.eventKey} outcome=${end.outcome}`,
    )

    if (end.outcome === 'completed') {
      this._setTriggerState(entry.triggerId, {
        lastRunAt: now,
        consecutiveFailures: 0,
        backoffUntil: undefined,
        lastError: undefined,
      })
      this._fireChange()
      return
    }
    if (failed) {
      const trigger = this._findTrigger(entry.triggerId)
      if (trigger !== undefined) this._recordFailure(trigger, message ?? '', now)
      else this._setTriggerState(entry.triggerId, { lastRunAt: now, lastError: message })
    } else {
      this._setTriggerState(entry.triggerId, { lastRunAt: now })
    }
    this._fireChange()
  }

  async reportSwarmNeedsAction(reviews: readonly SwarmNeedsActionReview[]): Promise<void> {
    await this._awaitReady()
    const now = this._clock.now()
    for (const trigger of this._config.triggers) {
      if (!trigger.enabled || trigger.source.type !== 'swarm-review') continue
      const state = this._stateFor(trigger.id)
      if (!state.baselineDone) {
        let processed = state.processed
        for (const review of reviews) {
          processed = markStarted(processed, `swarm:${review.reviewId}`, now)
        }
        this._setTriggerState(trigger.id, {
          processed: prune(processed, now, PRUNE_OPTIONS),
          baselineDone: true,
        })
        this._logger.info(
          `trigger ${trigger.id}: swarm baseline recorded reviews=${reviews.length}`,
        )
        continue
      }
      for (const review of reviews) {
        const event = swarmReviewEvent(trigger.id, review, now)
        if (isProcessed(this._stateFor(trigger.id).processed, event.key)) continue
        await this._acceptEvent(trigger, event)
      }
    }
    this._fireChange()
  }

  // ---- main-internal wiring ------------------------------------------------

  registerWindowHost(windowId: number, host: ITriggerRunHost): void {
    this._hosts.set(windowId, host)
    this._logger.info(`window host registered id=${windowId}`)
    if (this._gateOpen) return
    if (this._firstHostAt === undefined) {
      this._firstHostAt = this._clock.now()
      const deadline = this._firstHostAt + this._startupGraceMs
      if (this._gateDeadline === undefined || deadline > this._gateDeadline) {
        this._armGateTimer(deadline)
      }
    }
  }

  unregisterWindowHost(windowId: number): void {
    this._hosts.delete(windowId)
    this._logger.info(`window host unregistered id=${windowId}`)
    const message = localize(
      'triggers.error.windowClosed',
      'The window running this trigger closed',
    )
    for (const entry of [...this._active.values()]) {
      if (entry.windowId !== windowId) continue
      this._logger.warn(
        `run ${entry.runId}: failed trigger=${entry.triggerId} key=${entry.eventKey} (window closed)`,
      )
      this._failActiveRun(entry.runId, message)
    }
  }

  setWindowProvider(provider: TriggerWindowProvider): void {
    this._windows = provider
  }

  override dispose(): void {
    if (this._disposed) return
    this._disposed = true
    if (this._wakeTimer !== undefined) {
      this._clock.clearTimeout(this._wakeTimer)
      this._wakeTimer = undefined
    }
    if (this._gateTimer !== undefined) {
      this._clock.clearTimeout(this._gateTimer)
      this._gateTimer = undefined
    }
    this._stateStore.dispose()
    super.dispose()
  }

  // ---- initialization / gating --------------------------------------------

  private async _initialize(): Promise<void> {
    try {
      this._state = await this._stateStore.load()
    } catch (err) {
      this._logger.warn(`trigger state load failed; starting empty: ${describeError(err)}`)
      this._state = createEmptyTriggerStateFile()
    }
    const configState = await this._configStore.load()
    this._applyConfig(configState)
    this._armGate()
  }

  private _armGate(): void {
    if (this._disposed || this._gateOpen) return
    const startedDeadline = this._startedAt + this._startupGraceMs
    const hostDeadline =
      this._firstHostAt === undefined ? undefined : this._firstHostAt + this._startupGraceMs
    const deadline =
      hostDeadline === undefined ? startedDeadline : Math.max(startedDeadline, hostDeadline)
    this._armGateTimer(deadline)
  }

  private _armGateTimer(deadline: number): void {
    if (this._gateTimer !== undefined) this._clock.clearTimeout(this._gateTimer)
    this._gateDeadline = deadline
    const delay = Math.max(0, deadline - this._clock.now())
    this._logger.trace(`trigger scheduling gate in ${delay}ms`)
    this._gateTimer = this._clock.setTimeout(() => {
      this._gateTimer = undefined
      this._openGate()
    }, delay)
  }

  private _openGate(): void {
    if (this._disposed || this._gateOpen) return
    this._gateOpen = true
    this._logger.info('trigger scheduling started')
    void this._replayPendingRuns()
    this._syncTiming(this._clock.now())
    this._fireChange()
  }

  // ---- config -------------------------------------------------------------

  private _applyConfig(state: JsonConfigFileState<TriggersConfig>): void {
    this._config = state.value
    if (state.error !== undefined) {
      this._logger.warn(`triggers.json is invalid: ${state.error}`)
    }
    if (this._config.invalid.length > 0) {
      this._logger.warn(`triggers.json: ${this._config.invalid.length} invalid trigger entr(ies)`)
    }
    for (const item of this._queue.setGlobalLimit(this._config.maxConcurrentRuns)) {
      this._beginQueuedRun(item)
    }
    // Schedule/poll cadence is config-derived: drop the previous wake anchors so
    // an edited cron or interval takes effect immediately (the persisted
    // lastScheduledAt still drives missed-slot handling).
    this._armedSchedule.clear()
    this._nextPoll.clear()
    if (this._gateOpen) this._syncTiming(this._clock.now())
    else this._rescheduleWake()
    this._fireChange()
  }

  private _findTrigger(triggerId: string): TriggerConfig | undefined {
    return this._config.triggers.find((trigger) => trigger.id === triggerId)
  }

  private _requireTrigger(triggerId: string): TriggerConfig {
    const trigger = this._findTrigger(triggerId)
    if (trigger !== undefined) return trigger
    const invalid = this._config.invalid.find((entry) => entry.id === triggerId)
    if (invalid !== undefined) {
      throw new Error(
        localize('triggers.error.triggerInvalid', 'Invalid trigger configuration: {errors}', {
          errors: invalid.errors.join('; '),
        }),
      )
    }
    throw new Error(
      localize('triggers.error.triggerNotFound', 'Trigger not found: {id}', { id: triggerId }),
    )
  }

  // ---- scheduling ---------------------------------------------------------

  private _isRunnable(trigger: TriggerConfig): boolean {
    if (!trigger.enabled || this._state.pausedAll) return false
    if (this._stateFor(trigger.id).paused) return false
    return !this._needsConfirmation(trigger)
  }

  private _syncTiming(now: number): void {
    this._pruneTiming()
    if (!this._gateOpen || this._disposed) return
    for (const trigger of this._config.triggers) {
      if (trigger.source.type !== 'poll' || !this._isRunnable(trigger)) continue
      if (this._nextPoll.has(trigger.id)) continue
      // The first poll right after the startup grace seeds the baseline.
      this._nextPoll.set(trigger.id, now)
    }
    this._processDueSchedules(now)
    this._rescheduleWake()
  }

  private _pruneTiming(): void {
    for (const triggerId of [...this._armedSchedule.keys()]) {
      const trigger = this._findTrigger(triggerId)
      if (
        trigger === undefined ||
        trigger.source.type !== 'schedule' ||
        !this._isRunnable(trigger)
      ) {
        this._armedSchedule.delete(triggerId)
      }
    }
    for (const triggerId of [...this._nextPoll.keys()]) {
      const trigger = this._findTrigger(triggerId)
      if (trigger === undefined || trigger.source.type !== 'poll' || !this._isRunnable(trigger)) {
        this._nextPoll.delete(triggerId)
      }
    }
  }

  private _processDueSchedules(now: number): void {
    for (const trigger of this._config.triggers) {
      if (trigger.source.type !== 'schedule' || !this._isRunnable(trigger)) continue
      const armed = this._armedSchedule.get(trigger.id)
      if (armed !== undefined && armed > now) continue
      this._evaluateSchedule(trigger, trigger.source, now)
    }
  }

  private _evaluateSchedule(
    trigger: TriggerConfig,
    source: ScheduleSourceConfig,
    now: number,
  ): void {
    const state = this._stateFor(trigger.id)
    const decision = computeDue(source, state.lastScheduledAt, now, DEFAULT_MISSED_GRACE_MS)
    if (decision.skipped > 0) {
      this._logger.info(
        `trigger ${trigger.id}: skipped ${decision.skipped} missed schedule occurrence(s)`,
      )
    }
    const due = [...decision.due]
    let next = decision.next
    const armed = this._armedSchedule.get(trigger.id)
    if (
      due.length === 0 &&
      armed !== undefined &&
      now >= armed &&
      now - armed <= DEFAULT_MISSED_GRACE_MS
    ) {
      // First wake after enable: `lastScheduledAt` had no previous slot, so the
      // pure decision cannot report this occurrence as due.
      due.push(armed)
      next = computeDue(source, armed, now, DEFAULT_MISSED_GRACE_MS).next
    }

    let lastFired = state.lastScheduledAt
    for (const at of due) {
      const event: TriggerEvent = {
        triggerId: trigger.id,
        key: `schedule:${new Date(at).toISOString()}`,
        payload: {},
        firedAt: at,
      }
      this._logger.info(`trigger ${trigger.id}: schedule event ${event.key}`)
      void this._acceptEvent(trigger, event)
      lastFired = at
    }
    if (lastFired !== state.lastScheduledAt) {
      this._setTriggerState(trigger.id, { lastScheduledAt: lastFired })
    }
    if (next === undefined) {
      this._armedSchedule.delete(trigger.id)
      if (due.length === 0) {
        this._logger.warn(`trigger ${trigger.id}: schedule has no next occurrence`)
      }
    } else {
      this._armedSchedule.set(trigger.id, next)
    }
  }

  private _processDuePolls(now: number): void {
    for (const trigger of this._config.triggers) {
      if (trigger.source.type !== 'poll' || !this._isRunnable(trigger)) continue
      const due = this._nextPoll.get(trigger.id)
      if (due === undefined || due > now) continue
      void this._runPoll(trigger)
    }
  }

  private async _runPoll(trigger: TriggerConfig): Promise<void> {
    if (trigger.source.type !== 'poll') return
    const source = trigger.source
    const intervalMs = source.intervalSec * 1000
    this._nextPoll.set(trigger.id, this._clock.now() + intervalMs)
    this._rescheduleWake()

    const result = await this._fetchPollItems({
      command: source.fetch.command,
      cwd: trigger.workspace,
      timeoutSec: source.fetch.timeoutSec,
      keyField: source.keyField,
    })
    const now = this._clock.now()
    const current = this._findTrigger(trigger.id)
    if (current === undefined || !this._isRunnable(current)) {
      this._logger.info(`trigger ${trigger.id}: poll result ignored (trigger no longer runnable)`)
      return
    }
    if (!result.ok) {
      this._logger.warn(`trigger ${trigger.id}: poll failed: ${result.error}`)
      this._recordFailure(current, result.error, now)
      if (this._isRunnable(current)) {
        const backoffUntil = this._stateFor(trigger.id).backoffUntil ?? now
        this._nextPoll.set(trigger.id, Math.max(now + intervalMs, backoffUntil))
      }
      this._rescheduleWake()
      return
    }

    const state = this._stateFor(trigger.id)
    if (!state.baselineDone) {
      let processed: ProcessedKeys = state.processed
      for (const item of result.items) {
        processed = markStarted(processed, `poll:${item.key}`, now)
      }
      this._setTriggerState(trigger.id, {
        processed: prune(processed, now, PRUNE_OPTIONS),
        baselineDone: true,
      })
      this._logger.info(
        `trigger ${trigger.id}: poll baseline recorded items=${result.items.length}`,
      )
      this._fireChange()
      this._rescheduleWake()
      return
    }

    for (const item of result.items) {
      await this._acceptEvent(this._findTrigger(trigger.id) ?? current, {
        triggerId: trigger.id,
        key: `poll:${item.key}`,
        payload: item.payload,
        firedAt: now,
      })
    }
    this._rescheduleWake()
  }

  private _rescheduleWake(): void {
    if (this._wakeTimer !== undefined) {
      this._clock.clearTimeout(this._wakeTimer)
      this._wakeTimer = undefined
    }
    if (this._disposed || !this._gateOpen) return
    let next: number | undefined
    for (const at of this._armedSchedule.values())
      next = next === undefined ? at : Math.min(next, at)
    for (const at of this._nextPoll.values()) next = next === undefined ? at : Math.min(next, at)
    if (next === undefined) return
    const delay = Math.max(0, next - this._clock.now())
    this._wakeTimer = this._clock.setTimeout(() => {
      this._wakeTimer = undefined
      this._onWake()
    }, delay)
  }

  private _onWake(): void {
    if (this._disposed || !this._gateOpen) return
    const now = this._clock.now()
    this._processDueSchedules(now)
    this._processDuePolls(now)
    this._rescheduleWake()
  }

  // ---- events → runs ------------------------------------------------------

  private async _acceptEvent(trigger: TriggerConfig, event: TriggerEvent): Promise<boolean> {
    if (this._disposed) return false
    const state = this._stateFor(trigger.id)
    if (this._state.pausedAll || state.paused) {
      this._logger.info(`trigger ${trigger.id}: event ${event.key} dropped (paused)`)
      return false
    }
    if (this._needsConfirmation(trigger)) {
      this._logger.info(`trigger ${trigger.id}: event ${event.key} dropped (needs confirmation)`)
      return false
    }
    if (isProcessed(state.processed, event.key)) {
      this._logger.info(`trigger ${trigger.id}: duplicate event ${event.key} ignored`)
      return false
    }

    const pending: PendingRun = {
      runId: this._uuid(),
      triggerId: trigger.id,
      eventKey: event.key,
      firedAt: event.firedAt,
    }
    try {
      await writeJsonAtomic(this._pendingPayloadPath(pending.runId), event)
    } catch (err) {
      this._logger.warn(
        `trigger ${trigger.id}: cannot stage event ${event.key}: ${describeError(err)}`,
      )
      this._recordFailure(
        trigger,
        localize('triggers.error.pendingWriteFailed', 'Could not stage the trigger event on disk'),
      )
      return false
    }

    this._markProcessed(trigger.id, event.key, 'queued')
    this._state = {
      ...this._state,
      pending: [...this._state.pending, toPendingRecord(pending)],
    }
    this._stateStore.set(this._state)

    const result = this._queue.enqueue(pending, this._queueOptions(trigger))
    switch (result.status) {
      case 'started':
        this._active.set(pending.runId, { ...pending, phase: 'starting' })
        void this._startRun(pending)
        break
      case 'queued':
        this._queued.set(pending.runId, pending)
        this._logger.info(`trigger ${trigger.id}: event ${event.key} queued run=${pending.runId}`)
        break
      case 'dropped':
        this._logger.info(`trigger ${trigger.id}: event ${event.key} dropped (overflow)`)
        this._dropPending(pending)
        break
      case 'dropped-oldest':
        this._logger.info(
          `trigger ${trigger.id}: event ${event.key} queued run=${pending.runId} (queue full, dropped ${result.dropped.runId})`,
        )
        this._dropPending(result.dropped)
        this._queued.set(pending.runId, pending)
        break
    }
    this._fireChange()
    return true
  }

  private _queueOptions(trigger: TriggerConfig): RunQueueOptions {
    return {
      concurrency: trigger.concurrency,
      overflow: trigger.overflow,
      queueLimit: TRIGGER_DEFAULTS.queueLimit,
    }
  }

  private async _startRun(pending: PendingRun): Promise<void> {
    const trigger = this._findTrigger(pending.triggerId)
    if (trigger === undefined) {
      this._logger.warn(
        `run ${pending.runId}: trigger ${pending.triggerId} is no longer configured`,
      )
      this._active.delete(pending.runId)
      this._releaseSlot(pending.runId)
      this._forgetKey(pending.triggerId, pending.eventKey, pending.runId)
      this._fireChange()
      return
    }
    try {
      const event = await this._readPendingEvent(pending)
      if (event === undefined) {
        throw new Error(
          localize(
            'triggers.error.pendingEventLost',
            'The queued trigger event is no longer available',
          ),
        )
      }
      const runDir = await this._createRunDir(pending.runId)
      const request = this._buildRunRequest(trigger, pending, event, runDir)
      const { host, windowId } = await this._resolveHost(trigger)
      const beforeStart = this._active.get(pending.runId)
      if (beforeStart === undefined) return
      beforeStart.windowId = windowId
      const trusted = await host.isWorkspaceTrusted()
      if (!trusted) {
        throw new Error(
          localize('triggers.error.workspaceUntrusted', 'The workspace is not trusted'),
        )
      }
      const result = await host.startRun(request)
      if (!this._active.has(pending.runId)) {
        void host.cancelRun(pending.runId).catch(() => undefined)
        return
      }
      this._markProcessed(trigger.id, pending.eventKey, 'started')
      this._removePendingRecord(pending.runId)
      const active = this._active.get(pending.runId)
      if (active !== undefined) {
        active.phase = 'running'
        active.sessionId = result.sessionId
      }
      this._logger.info(
        `run ${pending.runId}: started trigger=${trigger.id} key=${pending.eventKey} session=${result.sessionId}`,
      )
      this._audit(
        'run-start',
        'success',
        `trigger=${trigger.id} key=${pending.eventKey} run=${pending.runId} session=${result.sessionId}`,
      )
      this._fireChange()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this._logger.warn(
        `run ${pending.runId}: start failed trigger=${pending.triggerId} key=${pending.eventKey}: ${message}`,
      )
      this._failActiveRun(pending.runId, message)
    }
  }

  private async _resolveHost(
    trigger: TriggerConfig,
  ): Promise<{ host: ITriggerRunHost; windowId: number }> {
    const target = { folder: URI.file(trigger.workspace).toString() }
    const directory = this._hostDirectory()
    const immediate = findWorkspaceHost(directory, target)
    if (immediate !== undefined) {
      const host = this._hosts.get(immediate)
      if (host !== undefined) return { host, windowId: immediate }
    }

    const provider = this._windows
    if (provider === undefined) {
      throw new Error(
        localize(
          'triggers.error.windowUnavailable',
          'No editor window is available to run the trigger',
        ),
      )
    }
    const alreadyOpen = listWorkspaceWindows(provider.getOpenWindowInfos()).some((workspace) =>
      isSameWorkspace(workspace, target),
    )
    if (!alreadyOpen) {
      this._logger.info(`trigger ${trigger.id}: opening a background window for its workspace`)
      try {
        await provider.openWindowForFolderInBackground(URI.file(trigger.workspace))
      } catch (err) {
        throw new Error(
          localize(
            'triggers.error.windowOpenFailed',
            'Could not open an editor window for the workspace: {reason}',
            { reason: describeError(err) },
          ),
        )
      }
    }

    const windowId = await waitForWorkspaceHost(directory, {
      target,
      timeoutMs: this._hostWaitTimeoutMs,
      ...(this._hostWaitPollMs === undefined ? {} : { pollIntervalMs: this._hostWaitPollMs }),
    })
    if (windowId === undefined) {
      throw new Error(
        localize(
          'triggers.error.hostTimeout',
          'Timed out waiting for an editor window to accept the run',
        ),
      )
    }
    const host = this._hosts.get(windowId)
    if (host === undefined) {
      throw new Error(
        localize('triggers.error.hostMissing', 'The editor window did not expose its run host'),
      )
    }
    return { host, windowId }
  }

  private _hostDirectory(): WorkspaceHostDirectory {
    return {
      listOpenWorkspaces: () => listWorkspaceWindows(this._windows?.getOpenWindowInfos() ?? []),
      hasHost: (windowId) => this._hosts.has(windowId),
    }
  }

  private _buildRunRequest(
    trigger: TriggerConfig,
    pending: PendingRun,
    event: TriggerEvent,
    runDir: string,
  ): TriggerRunRequest {
    const session = trigger.session
    const prompt = renderTriggerPrompt({
      trigger: { id: trigger.id, name: trigger.name },
      template: session.prompt,
      event,
      runDir,
      ...(session.skill === undefined ? {} : { skill: session.skill }),
    })
    const fingerprint = triggerFingerprint(trigger)
    const state = this._stateFor(trigger.id)
    const elevated = isElevatedMode(session.mode) && state.elevatedConfirmed === fingerprint
    const approve =
      trigger.allowedActions.includes('swarm.approve') && state.approveConfirmed === fingerprint
    return {
      origin: {
        triggerId: trigger.id,
        triggerName: trigger.name,
        eventKey: pending.eventKey,
        runId: pending.runId,
      },
      ...(session.agent === undefined ? {} : { agentId: session.agent }),
      cwd: join(trigger.workspace, session.cwd ?? ''),
      ...(session.mode === undefined ? {} : { mode: session.mode }),
      allowElevatedMode: elevated,
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(session.mcpServers === undefined ? {} : { mcpServerNames: session.mcpServers }),
      prompt,
      runDir,
      budget: session.budget,
      allowedActions: trigger.allowedActions,
      approveConfirmed: approve,
      payload: event.payload,
    }
  }

  private async _readPendingEvent(pending: PendingRun): Promise<TriggerEvent | undefined> {
    let text: string
    try {
      text = await readFile(this._pendingPayloadPath(pending.runId), 'utf8')
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

  private async _createRunDir(runId: string): Promise<string> {
    const runDir = join(this._runsDir, runId)
    await mkdir(runDir, { recursive: true })
    await pruneRunDirectories(this._runsDir, this._maxRunDirectories, this._logger)
    return runDir
  }

  private _pendingPayloadPath(runId: string): string {
    return join(this._pendingDir, `${runId}.json`)
  }

  private _releaseSlot(runId: string): void {
    for (const item of this._queue.complete(runId)) this._beginQueuedRun(item)
  }

  private _beginQueuedRun(item: PendingRun): void {
    this._queued.delete(item.runId)
    if (this._active.has(item.runId)) return
    this._active.set(item.runId, { ...item, phase: 'starting' })
    void this._startRun(item)
  }

  private _dropQueuedRuns(): void {
    this._queue.clear()
    for (const pending of [...this._queued.values()]) this._dropPending(pending)
    this._queued.clear()
  }

  private _dropPending(pending: PendingRun): void {
    this._queued.delete(pending.runId)
    this._forgetKey(pending.triggerId, pending.eventKey, pending.runId)
  }

  private _failActiveRun(runId: string, message: string): void {
    const entry = this._active.get(runId)
    if (entry === undefined) return
    this._active.delete(runId)
    this._releaseSlot(runId)
    this._forgetKey(entry.triggerId, entry.eventKey, runId)
    const trigger = this._findTrigger(entry.triggerId)
    if (trigger === undefined) {
      this._fireChange()
      return
    }
    this._recordFailure(trigger, message, this._clock.now())
    this._fireChange()
  }

  // ---- persistence --------------------------------------------------------

  private _stateFor(triggerId: string): TriggerRuntimeState {
    return this._state.triggers[triggerId] ?? DEFAULT_TRIGGER_RUNTIME_STATE
  }

  private _setTriggerState(triggerId: string, patch: RuntimeStatePatch): void {
    const current = this._stateFor(triggerId)
    // Explicit `undefined` means "clear this field"; deleting the key keeps the
    // persisted state free of nulls under exactOptionalPropertyTypes.
    const next: Record<string, unknown> = { ...current }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    this._state = {
      ...this._state,
      triggers: {
        ...this._state.triggers,
        [triggerId]: next as unknown as TriggerRuntimeState,
      },
    }
    this._stateStore.set(this._state)
  }

  private _markProcessed(triggerId: string, key: string, status: 'queued' | 'started'): void {
    const now = this._clock.now()
    const current = this._stateFor(triggerId).processed
    const updated =
      status === 'queued' ? markQueued(current, key, now) : markStarted(current, key, now)
    this._setTriggerState(triggerId, { processed: prune(updated, now, PRUNE_OPTIONS) })
  }

  private _forgetKey(triggerId: string, key: string, runId?: string): void {
    const current = this._stateFor(triggerId).processed
    if (isProcessed(current, key)) {
      this._setTriggerState(triggerId, { processed: forget(current, key) })
    }
    if (runId !== undefined) this._removePendingRecord(runId)
  }

  private _removePendingRecord(runId: string): void {
    const pending = this._state.pending
    if (pending.some((record) => record.runId === runId)) {
      this._state = {
        ...this._state,
        pending: pending.filter((record) => record.runId !== runId),
      }
      this._stateStore.set(this._state)
    }
    void rm(this._pendingPayloadPath(runId), { force: true }).catch(() => undefined)
  }

  private async _replayPendingRuns(): Promise<void> {
    for (const record of [...this._state.pending]) {
      const entry = this._stateFor(record.triggerId).processed[record.eventKey]
      if (entry === undefined || entry.status !== 'queued') {
        // Already started before the restart: never replay.
        this._removePendingRecord(record.runId)
        continue
      }
      const trigger = this._findTrigger(record.triggerId)
      if (trigger === undefined || !trigger.enabled) {
        this._logger.info(
          `pending run ${record.runId}: kept for trigger ${record.triggerId} (unavailable)`,
        )
        continue
      }
      const pending: PendingRun = {
        runId: record.runId,
        triggerId: record.triggerId,
        eventKey: record.eventKey,
        firedAt: record.firedAt,
      }
      if ((await this._readPendingEvent(pending)) === undefined) {
        this._logger.warn(`pending run ${record.runId}: payload missing, forgetting the event`)
        this._forgetKey(record.triggerId, record.eventKey, record.runId)
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
      this._logger.info(`pending run ${record.runId}: re-enqueued trigger=${record.triggerId}`)
    }
  }

  // ---- failures / notifications -------------------------------------------

  private _recordFailure(trigger: TriggerConfig, message: string, now = this._clock.now()): void {
    const state = this._stateFor(trigger.id)
    const consecutiveFailures = state.consecutiveFailures + 1
    const backoffUntil = now + nextBackoffMs(consecutiveFailures)
    const autoPause = shouldAutoPause(consecutiveFailures) && !state.paused
    this._setTriggerState(trigger.id, {
      consecutiveFailures,
      backoffUntil,
      lastError: message,
      ...(autoPause ? { paused: true } : {}),
    })
    this._logger.warn(
      `trigger ${trigger.id}: failure ${consecutiveFailures} backoff=${backoffUntil - now}ms: ${message}`,
    )
    if (autoPause) {
      this._logger.warn(
        `trigger ${trigger.id}: auto-paused after ${consecutiveFailures} consecutive failures`,
      )
      this._audit('auto-pause', 'failure', `trigger=${trigger.id} failures=${consecutiveFailures}`)
      try {
        this._notify(
          localize('triggers.notification.autoPaused.title', 'Trigger paused: {name}', {
            name: trigger.name,
          }),
          localize(
            'triggers.notification.autoPaused.body',
            '"{name}" failed {count} times in a row and was paused. Run "Triggers: List Triggers" to resume it.',
            { name: trigger.name, count: consecutiveFailures },
          ),
        )
      } catch (err) {
        this._logger.warn(`trigger ${trigger.id}: notification failed: ${describeError(err)}`)
      }
      this._pruneTiming()
      this._rescheduleWake()
    }
  }

  // ---- summaries ----------------------------------------------------------

  private _needsConfirmation(trigger: TriggerConfig): boolean {
    if (!isElevatedMode(trigger.session.mode)) return false
    return this._stateFor(trigger.id).elevatedConfirmed !== triggerFingerprint(trigger)
  }

  private _summaries(): readonly TriggerSummary[] {
    const summaries: TriggerSummary[] = []
    for (const trigger of this._config.triggers) {
      const state = this._stateFor(trigger.id)
      const stats = this._queue.stats(trigger.id)
      const fingerprint = triggerFingerprint(trigger)
      const elevatedMode = isElevatedMode(trigger.session.mode)
      const elevatedModeConfirmed = elevatedMode && state.elevatedConfirmed === fingerprint
      const approveAction = trigger.allowedActions.includes('swarm.approve')
      const approveConfirmed = approveAction && state.approveConfirmed === fingerprint
      const paused = state.paused || this._state.pausedAll
      const needsConfirmation = elevatedMode && !elevatedModeConfirmed
      const status: TriggerStatus = paused
        ? 'paused'
        : needsConfirmation
          ? 'needs-confirmation'
          : stats.running > 0
            ? 'running'
            : !trigger.enabled
              ? 'disabled'
              : 'idle'
      const nextRunAt = this._nextRunAt(trigger, paused)
      summaries.push({
        id: trigger.id,
        name: trigger.name,
        sourceType: trigger.source.type,
        status,
        enabled: trigger.enabled,
        paused,
        elevatedMode,
        elevatedModeConfirmed,
        approveAction,
        approveConfirmed,
        running: stats.running,
        queued: stats.queued,
        consecutiveFailures: state.consecutiveFailures,
        ...(state.lastRunAt === undefined ? {} : { lastRunAt: state.lastRunAt }),
        ...(nextRunAt === undefined ? {} : { nextRunAt }),
        ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
      })
    }
    for (const invalid of this._config.invalid) {
      summaries.push({
        id: invalid.id,
        name: invalid.id,
        sourceType: 'unknown',
        status: 'invalid',
        enabled: false,
        paused: false,
        elevatedMode: false,
        elevatedModeConfirmed: false,
        approveAction: false,
        approveConfirmed: false,
        running: 0,
        queued: 0,
        consecutiveFailures: 0,
        errors: invalid.errors,
      })
    }
    return summaries
  }

  private _nextRunAt(trigger: TriggerConfig, paused: boolean): number | undefined {
    if (!trigger.enabled || paused) return undefined
    if (trigger.source.type === 'schedule') return this._armedSchedule.get(trigger.id)
    if (trigger.source.type === 'poll') return this._nextPoll.get(trigger.id)
    return undefined
  }

  private _fireChange(): void {
    this._onDidChangeTriggers.fire(this._summaries())
  }

  private _audit(action: string, result: 'success' | 'failure', detail?: string): void {
    void this._auditLog
      .append({ action, result, ...(detail === undefined ? {} : { detail }) })
      .catch((err) => this._logger.warn(`audit append failed: ${describeError(err)}`))
  }

  private async _awaitReady(): Promise<void> {
    await this._ready.catch(() => undefined)
  }
}

function toPendingRecord(pending: PendingRun): PendingRunRecord {
  return {
    runId: pending.runId,
    triggerId: pending.triggerId,
    eventKey: pending.eventKey,
    firedAt: pending.firedAt,
  }
}

function formatActions(end: TriggerRunEnd): string {
  if (end.actions.length === 0) return '-'
  return end.actions.map((action) => `${action.type}@${action.target}=${action.result}`).join(',')
}

/** Keeps the newest `keep` run directories (by mtime) and deletes the rest. */
export async function pruneRunDirectories(
  root: string,
  keep: number,
  logger?: ILogger,
): Promise<void> {
  let names: string[]
  try {
    const entries = await readdir(root, { withFileTypes: true })
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return
  }
  if (names.length <= keep) return
  const stats = await Promise.all(
    names.map(async (name) => {
      try {
        return { name, at: (await stat(join(root, name))).mtimeMs }
      } catch {
        return undefined
      }
    }),
  )
  const ordered = stats
    .filter((entry): entry is { name: string; at: number } => entry !== undefined)
    .sort((left, right) => right.at - left.at || right.name.localeCompare(left.name))
  const doomed = ordered.slice(keep)
  for (const entry of doomed) {
    try {
      await rm(join(root, entry.name), { recursive: true, force: true })
    } catch (err) {
      logger?.warn(`cannot remove old run directory ${entry.name}: ${describeError(err)}`)
    }
  }
  if (doomed.length > 0) logger?.info(`removed ${doomed.length} old run director(ies)`)
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
