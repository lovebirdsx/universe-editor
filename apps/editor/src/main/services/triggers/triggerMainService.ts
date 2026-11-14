/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Application-singleton trigger scheduler. Owns one config store per registered
 *  workspace (`<workspace>/.universe-editor/triggers.json`), the machine-local
 *  dedupe/backoff state, one wake-up timer, poll fetching, run queueing and the
 *  window routing that hands a run to a renderer's ITriggerRunHost.
 *  Design: docs/development/triggers.md
 *
 *  Identity: a trigger id is unique only inside its workspace, so state keys, queue
 *  entries, pending records and public API arguments all use the composite key.
 *
 *  Logging rule: trigger id / workspace / event key / runId / sessionId only — never
 *  an event payload, prompt, verdict summary or command output.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  Disposable,
  DisposableStore,
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
  isElevatedModeId,
  MAX_TRIGGER_REPORT_BYTES,
  TRIGGER_DEFAULTS,
  type TriggerConfig,
  type TriggerEvent,
  type TriggerPayloadValue,
  type TriggerRunEnd,
  type TriggerRunReportReadResult,
  type TriggerRunRequest,
  type TriggerSourceConfig,
  type TriggerStatus,
  type TriggerSummary,
  type TriggersConfig,
  type TriggerWorkspaceSummary,
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
import { parseWorkspaceUri } from '../../../shared/triggers/configParse.js'
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
  normalizeMaxConcurrentRuns,
  readTriggersConfigFile,
  serializeTriggersConfig,
  triggersDirectory,
  workspaceTriggersConfigPath,
} from './triggersConfigFile.js'
import { TriggerWorkspaceRegistry } from './triggerWorkspaceRegistry.js'
import { triggerFingerprint } from './triggerFingerprint.js'
import {
  canonicalTriggerKey,
  parseTriggerKey,
  triggerKeyBelongsToWorkspace,
  triggerKeyFor,
  workspaceComparisonKey,
} from './triggerIdentity.js'
import {
  createEmptyTriggerStateFile,
  DEFAULT_TRIGGER_RUNTIME_STATE,
  TriggerStateStore,
  type PendingRunRecord,
  type TriggerRuntimeState,
  type TriggerStateFile,
} from './triggerStateStore.js'
import { createPollCommandFetcher, type PollCommandFetcher } from './pollCommandFetcher.js'
import { SessionReportReader } from './runReportReader.js'

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
  readonly startRunTimeoutMs?: number
  readonly stateDebounceMs?: number
  readonly maxRunDirectories?: number
  /** `triggers.maxConcurrentRuns` from the user settings; defaults to the constant. */
  readonly readMaxConcurrentRuns?: () => Promise<number>
  /** Re-read the user setting when the config directory moves. */
  readonly configDirChanged?: Event<string>
  /** Machine-local trusted-folder probe used before running a poll command. */
  readonly isWorkspaceTrusted?: (workspace: string) => Promise<boolean>
}

/** A trigger config resolved against the workspace entry that owns it. */
export interface RoutedTrigger extends TriggerConfig {
  /** Composite workspace + id; the only identity used for state and the public API. */
  readonly key: string
  /** Workspace URI string (`file:///…` / `remote-ssh://…`). */
  readonly workspace: string
  readonly workspaceUri: URI
  /** Fingerprint of the bare config; confirmations bind to this. */
  readonly fingerprint: string
}

interface WorkspaceEntry {
  /** Workspace URI string; the identity shared with the renderer and state keys. */
  readonly workspace: string
  readonly workspaceUri: URI
  readonly key: string
  readonly store: JsonConfigFileStore<TriggersConfig>
  /** Owns the store and its subscriptions; detach disposes exactly this entry. */
  readonly disposables: DisposableStore
  config: TriggersConfig
}

/** Mirrors `RunQueueItem`; the queue only needs runId + triggerKey. */
interface PendingRun {
  readonly runId: string
  readonly triggerKey: string
  /** Bare trigger id (prompt fence, logs, audit). */
  readonly triggerId: string
  /** Workspace URI string (logs / audit only). */
  readonly workspace: string
  readonly eventKey: string
  readonly firedAt: number
}

interface ActiveRun extends PendingRun {
  phase: 'starting' | 'running'
  windowId?: number
  sessionId?: string
  watchdogTimer?: TriggerTimerHandle
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
/** Beyond the configured budget before a silent renderer is presumed stuck. */
const WATCHDOG_GRACE_MS = 10 * 60_000

/** Filesystem-visible prefixes owned by a single trigger source. */
const PREFETCHED_KEY_PREFIXES = ['poll:', 'swarm:'] as const

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
  private readonly _startRunTimeoutMs: number
  private readonly _maxRunDirectories: number
  private readonly _dir: string
  private readonly _runsDir: string
  private readonly _pendingDir: string
  private readonly _reportReader: SessionReportReader
  private readonly _auditLog: AuditLog
  private readonly _registry: TriggerWorkspaceRegistry
  private readonly _stateStore: TriggerStateStore
  private readonly _readMaxConcurrentRuns: () => Promise<number>
  private readonly _isWorkspaceTrusted: ((workspace: string) => Promise<boolean>) | undefined
  private readonly _queue = new RunQueue<PendingRun>(TRIGGER_DEFAULTS.maxConcurrentRuns)
  private readonly _onDidChangeTriggers = this._register(new Emitter<readonly TriggerSummary[]>())
  readonly onDidChangeTriggers: Event<readonly TriggerSummary[]> = this._onDidChangeTriggers.event

  private readonly _workspaces = new Map<string, WorkspaceEntry>()
  private readonly _attaching = new Map<string, Promise<void>>()
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
  private _replaying = false
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
    this._startRunTimeoutMs = Math.max(
      0,
      options.startRunTimeoutMs ?? TRIGGER_DEFAULTS.startRunTimeoutMs,
    )
    this._maxRunDirectories = Math.max(1, options.maxRunDirectories ?? DEFAULT_MAX_RUN_DIRECTORIES)
    this._dir = triggersDirectory(options.userDataDir)
    this._runsDir = join(this._dir, 'runs')
    this._pendingDir = join(this._dir, 'pending')
    this._readMaxConcurrentRuns =
      options.readMaxConcurrentRuns ?? (() => Promise.resolve(TRIGGER_DEFAULTS.maxConcurrentRuns))
    this._isWorkspaceTrusted = options.isWorkspaceTrusted
    if (options.configDirChanged !== undefined) {
      this._register(options.configDirChanged(() => void this._reloadMaxConcurrentRuns()))
    }
    this._reportReader = new SessionReportReader({
      runsDir: this._runsDir,
      maxBytes: MAX_TRIGGER_REPORT_BYTES,
      logger: options.logger,
    })
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
    this._registry = new TriggerWorkspaceRegistry({
      file: join(this._dir, 'workspaces.json'),
      logger: options.logger,
    })
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

  async listWorkspaces(): Promise<readonly TriggerWorkspaceSummary[]> {
    await this._awaitReady()
    return this._registry.list().map((workspace) => {
      const entry = this._workspaces.get(workspaceComparisonKey(workspace))
      return {
        workspace,
        name: workspaceFolderName(workspace),
        configPath: workspaceTriggersConfigPath(workspaceFsPath(workspace)),
        available: entry !== undefined,
        triggerCount: entry?.config.triggers.length ?? 0,
      }
    })
  }

  /** Machine-local run directory (`<userData>/triggers/runs`). */
  async getRunsDir(): Promise<string> {
    await this._awaitReady()
    return this._runsDir
  }

  async setMaxConcurrentRuns(limit: number): Promise<void> {
    await this._awaitReady()
    const normalized = normalizeMaxConcurrentRuns(limit)
    for (const item of this._queue.setGlobalLimit(normalized)) this._beginQueuedRun(item)
    this._logger.info(`trigger concurrency limit: ${normalized} (settings change)`)
  }

  async runNow(triggerKey: string): Promise<void> {
    await this._awaitReady()
    const trigger = this._requireTrigger(triggerKey)
    if (this._state.pausedAll) {
      throw new Error(localize('triggers.error.allPaused', 'All triggers are paused'))
    }
    if (this._stateFor(trigger.key).paused) {
      throw new Error(localize('triggers.error.triggerPaused', 'This trigger is paused'))
    }
    if (!this._isActivated(trigger)) {
      throw new Error(
        localize(
          'triggers.error.needsActivation',
          'Confirm this trigger before running it (it comes from a workspace configuration file)',
        ),
      )
    }
    if (this._needsElevatedConfirmation(trigger)) {
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
    this._logger.info(`trigger ${trigger.id} (${trigger.workspace}): manual event ${event.key}`)
    // A user-initiated run is an explicit override of the failure backoff.
    await this._acceptEvent(trigger, event, { ignoreBackoff: true })
  }

  async setPaused(triggerKey: string, paused: boolean): Promise<void> {
    await this._awaitReady()
    const trigger = this._requireTrigger(triggerKey)
    this._setTriggerState(
      trigger.key,
      paused
        ? { paused: true, lastError: undefined }
        : { paused: false, consecutiveFailures: 0, backoffUntil: undefined, lastError: undefined },
    )
    if (paused) {
      // Pausing is the final gate: queued events are dropped (their keys forgotten
      // so they can fire again after resume) and no new timing is armed.
      this._queue.clear(trigger.key)
      for (const pending of [...this._queued.values()]) {
        if (pending.triggerKey === trigger.key) this._dropPending(pending)
      }
      this._armedSchedule.delete(trigger.key)
      this._nextPoll.delete(trigger.key)
    }
    this._logger.info(`trigger ${trigger.id}: ${paused ? 'paused' : 'resumed'} by the user`)
    this._audit(
      paused ? 'trigger-paused' : 'trigger-resumed',
      'success',
      `trigger=${trigger.id} workspace=${trigger.workspace}`,
    )
    this._syncTiming(this._clock.now())
    if (!paused) void this._replayPendingRuns()
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
      void this._replayPendingRuns()
    }
    this._logger.info(`all triggers ${paused ? 'paused' : 'resumed'} by the user`)
    this._audit(paused ? 'all-paused' : 'all-resumed', 'success')
    this._fireChange()
  }

  /**
   * Workspace-defined triggers are never run before the user confirms them once on
   * this machine; the confirmation is bound to the config fingerprint, so editing
   * the trigger (including in a git pull) invalidates it.
   */
  async confirmActivation(triggerKey: string): Promise<void> {
    await this._awaitReady()
    const trigger = this._requireTrigger(triggerKey)
    this._setTriggerState(trigger.key, { activationConfirmed: trigger.fingerprint })
    this._logger.info(
      `trigger ${trigger.id} (${trigger.workspace}): activation confirmed fingerprint=${trigger.fingerprint}`,
    )
    this._audit(
      'confirm-activation',
      'success',
      `trigger=${trigger.id} workspace=${trigger.workspace} fingerprint=${trigger.fingerprint}`,
    )
    this._syncTiming(this._clock.now())
    void this._replayPendingRuns()
    this._fireChange()
  }

  async confirmElevatedMode(triggerKey: string): Promise<void> {
    await this._awaitReady()
    const trigger = this._requireTrigger(triggerKey)
    if (!isElevatedModeId(trigger.session.mode)) {
      throw new Error(
        localize('triggers.error.notElevatedMode', 'This trigger does not use a bypass-class mode'),
      )
    }
    this._setTriggerState(trigger.key, { elevatedConfirmed: trigger.fingerprint })
    this._logger.info(
      `trigger ${trigger.id}: elevated mode confirmed fingerprint=${trigger.fingerprint}`,
    )
    this._audit(
      'confirm-elevated-mode',
      'success',
      `trigger=${trigger.id} workspace=${trigger.workspace} fingerprint=${trigger.fingerprint}`,
    )
    void this._replayPendingRuns()
    this._fireChange()
  }

  async confirmAutoApprove(triggerKey: string): Promise<void> {
    await this._awaitReady()
    const trigger = this._requireTrigger(triggerKey)
    if (!trigger.allowedActions.includes('swarm.approve')) {
      throw new Error(
        localize(
          'triggers.error.approveNotAllowed',
          'This trigger does not allow the swarm.approve action',
        ),
      )
    }
    this._setTriggerState(trigger.key, { approveConfirmed: trigger.fingerprint })
    this._logger.info(
      `trigger ${trigger.id}: automatic approve confirmed fingerprint=${trigger.fingerprint}`,
    )
    this._audit(
      'confirm-auto-approve',
      'success',
      `trigger=${trigger.id} workspace=${trigger.workspace} fingerprint=${trigger.fingerprint}`,
    )
    void this._replayPendingRuns()
    this._fireChange()
  }

  /**
   * Create `<workspace>/.universe-editor/triggers.json` with the example when absent,
   * register the workspace and start watching it. The caller supplies the window's
   * current folder — main has no way to tell which window issued the command.
   */
  async ensureConfigFile(workspaceFolder?: string): Promise<string> {
    await this._awaitReady()
    const folder = parseWorkspaceUri(workspaceFolder)
    // Remote definitions land with the remote config store; this phase stays local.
    if (folder === undefined || folder.scheme !== 'file') {
      throw new Error(
        localize(
          'triggers.error.noLocalWorkspace',
          'Open a local folder workspace first — triggers live inside a workspace',
        ),
      )
    }
    const file = workspaceTriggersConfigPath(folder.fsPath)
    try {
      const created = await ensureTriggersConfigFile(file)
      if (created) this._logger.info(`created the example trigger config in ${folder.toString()}`)
    } catch (err) {
      this._logger.warn(`failed to create ${file}: ${describeError(err)}`)
      throw new Error(
        localize(
          'triggers.error.configWriteFailed',
          'Could not create the trigger configuration file',
        ),
      )
    }
    const workspace = folder.toString()
    await this._registry.register(workspace)
    await this._attachWorkspace(workspace)
    return URI.file(file).toString()
  }

  /** Stop watching a workspace and drop its queued events; running sessions finish. */
  async removeWorkspace(workspace: string): Promise<void> {
    await this._awaitReady()
    const removed = await this._registry.remove(workspace)
    const key = workspaceComparisonKey(workspace)
    this._detachWorkspace(key)
    if (removed) {
      this._logger.info(`trigger workspace removed from the registry: ${workspace}`)
      this._audit('workspace-removed', 'success', `workspace=${workspace}`)
    }
    this._fireChange()
  }

  async reportRunEnd(end: TriggerRunEnd): Promise<void> {
    await this._awaitReady()
    const entry = this._active.get(end.runId)
    if (entry === undefined) {
      this._logger.warn(`run ${end.runId}: end report ignored (not tracked)`)
      return
    }
    this._clearWatchdog(entry)
    this._active.delete(end.runId)
    this._releaseSlot(end.runId)

    const now = this._clock.now()
    const failed = end.outcome === 'failed'
    const message = failed
      ? (end.error ?? localize('triggers.error.runFailed', 'The automated run failed'))
      : undefined
    const detail = [
      `trigger=${entry.triggerId}`,
      `workspace=${entry.workspace}`,
      `key=${entry.eventKey}`,
      `run=${end.runId}`,
      `session=${end.sessionId ?? '-'}`,
      `outcome=${end.outcome}`,
      `verdict=${end.verdict ?? '-'}`,
      `actions=${formatActions(end)}`,
    ].join(' ')
    this._audit('run-end', failed ? 'failure' : 'success', detail)
    for (const action of end.actions) {
      // One line per executed / rejected action. `reason` is a validation or
      // execution error only — never the comment body the action carried.
      this._audit(
        'action',
        action.result === 'ok' ? 'success' : 'failure',
        [
          `trigger=${entry.triggerId}`,
          `key=${entry.eventKey}`,
          `run=${end.runId}`,
          `session=${end.sessionId ?? '-'}`,
          `type=${action.type}`,
          `target=${action.target}`,
          `result=${action.result}`,
          ...(action.reason === undefined ? [] : [`reason=${sanitizeAuditReason(action.reason)}`]),
        ].join(' '),
      )
    }
    this._logger.info(
      `run ${end.runId}: ended trigger=${entry.triggerId} key=${entry.eventKey} outcome=${end.outcome}`,
    )

    if (end.outcome === 'completed') {
      this._setTriggerState(entry.triggerKey, {
        lastRunAt: now,
        consecutiveFailures: 0,
        backoffUntil: undefined,
        lastError: undefined,
      })
      this._fireChange()
      return
    }
    if (failed) {
      const trigger = this._findTrigger(entry.triggerKey)
      if (trigger !== undefined) this._recordFailure(trigger, message ?? '', now)
      else this._setTriggerState(entry.triggerKey, { lastRunAt: now, lastError: message })
    } else {
      this._setTriggerState(entry.triggerKey, { lastRunAt: now })
    }
    this._fireChange()
  }

  async readRunReport(runId: string): Promise<TriggerRunReportReadResult> {
    const result = await this._reportReader.read(runId)
    if (!result.ok) {
      return { kind: result.reason === 'too_large' ? 'too-large' : 'not-found' }
    }
    return {
      kind: 'ok',
      text: Buffer.from(result.bytes).toString('utf8'),
      runDir: result.runDir,
      modifiedAt: result.modifiedAt,
    }
  }

  async reportSwarmNeedsAction(
    reviews: readonly SwarmNeedsActionReview[],
    workspaceFolder: string,
  ): Promise<void> {
    await this._awaitReady()
    const folder = parseWorkspaceUri(workspaceFolder)
    if (folder === undefined) {
      this._logger.warn(`swarm report ignored: not a workspace uri (${workspaceFolder})`)
      return
    }
    // A swarm trigger belongs to the workspace whose window reported the reviews;
    // another open workspace must not consume them (or seed its baseline with them).
    // A remote workspace simply matches nothing until discovery supports it.
    const reporterKey = workspaceComparisonKey(folder.toString())
    const now = this._clock.now()
    // Concurrent reports (two windows) can interleave; the persistent key check is
    // authoritative, but de-duplicating the batch also keeps one report from
    // enqueueing the same review twice.
    const seen = new Set<string>()
    const unique = reviews.filter((review) => {
      if (seen.has(review.reviewId)) return false
      seen.add(review.reviewId)
      return true
    })
    for (const trigger of this._allTriggers()) {
      if (!trigger.enabled || trigger.source.type !== 'swarm-review') continue
      if (workspaceComparisonKey(trigger.workspace) !== reporterKey) continue
      // Unconfirmed triggers must not consume the baseline: the first report after
      // confirmation has to seed it, otherwise every historical review fires.
      if (!this._isActivated(trigger)) continue
      const state = this._stateFor(trigger.key)
      if (!state.baselineDone) {
        let processed = state.processed
        for (const review of unique) {
          processed = markStarted(processed, `swarm:${review.reviewId}`, now)
        }
        this._setTriggerState(trigger.key, {
          processed: prune(processed, now, PRUNE_OPTIONS),
          baselineDone: true,
        })
        this._logger.info(`trigger ${trigger.id}: swarm baseline recorded reviews=${unique.length}`)
        continue
      }
      for (const review of unique) {
        const event = swarmReviewEvent(trigger.id, review, now)
        if (isProcessed(this._stateFor(trigger.key).processed, event.key)) continue
        await this._acceptEvent(trigger, event)
      }
    }
    this._fireChange()
  }

  // ---- main-internal wiring ------------------------------------------------

  registerWindowHost(
    windowId: number,
    host: ITriggerRunHost,
    workspaceFolder: URI | null = null,
  ): void {
    // A renderer reload re-registers on the same window id; its previous sessions
    // are gone, so nobody will ever report their end. Fail them instead of leaking
    // the slot (a fresh app-level window registration has no previous host).
    const reloaded = this._hosts.has(windowId)
    this._hosts.set(windowId, host)
    this._logger.info(`window host registered id=${windowId}`)
    if (reloaded) {
      const message = localize(
        'triggers.error.windowReloaded',
        'The window running this trigger reloaded',
      )
      for (const entry of [...this._active.values()]) {
        if (entry.windowId !== windowId) continue
        this._logger.warn(
          `run ${entry.runId}: failed trigger=${entry.triggerId} key=${entry.eventKey} (window reloaded)`,
        )
        this._failActiveRun(entry.runId, message)
      }
    }
    if (this._gateOpen) {
      void this._discoverWorkspace(workspaceFolder)
      return
    }
    if (this._firstHostAt === undefined) {
      this._firstHostAt = this._clock.now()
      const deadline = this._firstHostAt + this._startupGraceMs
      if (this._gateDeadline === undefined || deadline > this._gateDeadline) {
        this._armGateTimer(deadline)
      }
    }
    void this._discoverWorkspace(workspaceFolder)
  }

  /**
   * A window opened (or switched to) `folder`. Best-effort: a local folder with
   * `.universe-editor/triggers.json` is registered for background scheduling.
   */
  noteWindowWorkspace(folder: URI | null): void {
    void this._discoverWorkspace(folder)
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
    for (const run of this._active.values()) this._clearWatchdog(run)
    for (const entry of this._workspaces.values()) entry.disposables.dispose()
    this._workspaces.clear()
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
    await this._reloadMaxConcurrentRuns()
    let registered: readonly string[] = []
    try {
      registered = await this._registry.load()
    } catch (err) {
      this._logger.warn(`trigger workspace registry load failed: ${describeError(err)}`)
    }
    for (const workspace of registered) await this._attachWorkspace(workspace)
    this._armGate()
  }

  private async _reloadMaxConcurrentRuns(): Promise<void> {
    let limit: number = TRIGGER_DEFAULTS.maxConcurrentRuns
    try {
      limit = await this._readMaxConcurrentRuns()
    } catch (err) {
      this._logger.warn(`cannot read the maxConcurrentRuns setting: ${describeError(err)}`)
    }
    for (const item of this._queue.setGlobalLimit(limit)) this._beginQueuedRun(item)
    this._logger.info(`trigger concurrency limit: ${limit}`)
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

  // ---- workspace discovery / config stores --------------------------------

  /** Register a local folder and start watching its trigger file (when it exists). */
  private async _discoverWorkspace(folder: URI | null): Promise<void> {
    if (folder === null) return
    // Remote discovery lands with the remote config store; this phase stays local.
    if (folder.scheme !== 'file' || folder.authority.length > 0) {
      this._logger.info(`trigger workspace discovery skipped (not a local folder): ${folder}`)
      return
    }
    // Window hosts register before the registry/state load completes; waiting keeps
    // discovery from being overwritten by the in-flight `load()` snapshot.
    await this._awaitReady()
    await this._registerDiscoveredWorkspace(folder.toString())
  }

  private async _registerDiscoveredWorkspace(workspace: string): Promise<void> {
    const uri = parseWorkspaceUri(workspace)
    if (uri === undefined) return
    try {
      const file = workspaceTriggersConfigPath(uri.fsPath)
      if (!(await fileExists(file))) return
      await this._registry.register(workspace)
      await this._attachWorkspace(workspace)
    } catch (err) {
      this._logger.warn(
        `trigger workspace discovery failed for ${workspace}: ${describeError(err)}`,
      )
    }
  }

  private _attachWorkspace(workspace: string): Promise<void> {
    const uri = parseWorkspaceUri(workspace)
    if (uri === undefined) return Promise.resolve()
    const key = workspaceComparisonKey(workspace)
    const pending = this._attaching.get(key)
    if (pending !== undefined) return pending
    const task = this._doAttachWorkspace(workspace, uri, key).finally(() =>
      this._attaching.delete(key),
    )
    this._attaching.set(key, task)
    return task
  }

  private async _doAttachWorkspace(
    workspace: string,
    workspaceUri: URI,
    key: string,
  ): Promise<void> {
    if (this._disposed || this._workspaces.has(key)) return
    const file = workspaceTriggersConfigPath(workspaceUri.fsPath)
    if (!(await fileExists(file))) {
      this._logger.warn(`trigger workspace skipped (no ${file}); it stays registered until removed`)
      return
    }
    const store = new JsonConfigFileStore<TriggersConfig>({
      file,
      logger: this._logger,
      directoryLabel: 'workspace trigger config',
      createDefault: createEmptyTriggersConfig,
      read: readTriggersConfigFile,
      serialize: serializeTriggersConfig,
    })
    if (this._disposed) {
      store.dispose()
      return
    }
    const entry: WorkspaceEntry = {
      workspace,
      workspaceUri,
      key,
      store,
      disposables: new DisposableStore(),
      config: createEmptyTriggersConfig(),
    }
    this._workspaces.set(key, entry)
    entry.disposables.add(store)
    entry.disposables.add(
      store.onDidChangeExternal((state) => {
        if (this._workspaces.get(key) !== entry) return
        this._applyWorkspaceConfig(entry, state)
      }),
    )
    const state = await store.load()
    if (this._workspaces.get(key) !== entry) return
    this._applyWorkspaceConfig(entry, state)
    this._logger.info(`trigger workspace attached: ${workspace}`)
  }

  /** Stop scheduling a workspace; its queued events are dropped, running runs finish. */
  private _detachWorkspace(key: string): void {
    const entry = this._workspaces.get(key)
    if (entry === undefined) return
    const triggerKeys = new Set<string>()
    for (const trigger of entry.config.triggers) {
      triggerKeys.add(triggerKeyFor(entry.workspace, trigger.id))
    }
    for (const invalid of entry.config.invalid) {
      triggerKeys.add(triggerKeyFor(entry.workspace, invalid.id))
    }
    for (const record of this._state.pending) {
      if (triggerKeyBelongsToWorkspace(record.triggerKey, key)) triggerKeys.add(record.triggerKey)
    }
    for (const pending of this._queued.values()) {
      if (triggerKeyBelongsToWorkspace(pending.triggerKey, key)) triggerKeys.add(pending.triggerKey)
    }
    this._workspaces.delete(key)
    entry.disposables.dispose()
    for (const triggerKey of triggerKeys) {
      this._queue.clear(triggerKey)
      this._armedSchedule.delete(triggerKey)
      this._nextPoll.delete(triggerKey)
    }
    for (const pending of [...this._queued.values()]) {
      if (triggerKeyBelongsToWorkspace(pending.triggerKey, key)) this._dropPending(pending)
    }
    this._dropPendingRecordsForWorkspace(key)
    this._pruneTiming()
    this._rescheduleWake()
  }

  /** removeWorkspace drops every queued event: pending payload files included. */
  private _dropPendingRecordsForWorkspace(key: string): void {
    const removed = this._state.pending.filter((record) =>
      triggerKeyBelongsToWorkspace(record.triggerKey, key),
    )
    if (removed.length === 0) return
    this._state = {
      ...this._state,
      pending: this._state.pending.filter(
        (record) => !triggerKeyBelongsToWorkspace(record.triggerKey, key),
      ),
    }
    this._stateStore.set(this._state)
    for (const record of removed) {
      void rm(this._pendingPayloadPath(record.runId), { force: true }).catch(() => undefined)
    }
  }

  // ---- config -------------------------------------------------------------

  private _applyWorkspaceConfig(
    entry: WorkspaceEntry,
    state: JsonConfigFileState<TriggersConfig>,
  ): void {
    entry.config = state.value
    if (state.error !== undefined) {
      this._logger.warn(
        `${workspaceTriggersConfigPath(entry.workspaceUri.fsPath)} is invalid: ${state.error}`,
      )
    }
    if (entry.config.invalid.length > 0) {
      this._logger.warn(
        `${workspaceTriggersConfigPath(entry.workspaceUri.fsPath)}: ${entry.config.invalid.length} invalid trigger entr(ies)`,
      )
    }
    for (const trigger of this._routedTriggers(entry)) this._syncSourceFingerprint(trigger)
    // Schedule/poll cadence is config-derived: drop this workspace's wake anchors so
    // an edited cron or interval takes effect immediately (the persisted
    // lastScheduledAt still drives missed-slot handling).
    for (const triggerKey of [...this._armedSchedule.keys()]) {
      if (parseTriggerKey(triggerKey)?.workspaceKey === entry.key) {
        this._armedSchedule.delete(triggerKey)
      }
    }
    for (const triggerKey of [...this._nextPoll.keys()]) {
      if (parseTriggerKey(triggerKey)?.workspaceKey === entry.key) this._nextPoll.delete(triggerKey)
    }
    if (this._gateOpen) this._syncTiming(this._clock.now())
    else this._rescheduleWake()
    this._fireChange()
  }

  private _routedTriggers(entry: WorkspaceEntry): RoutedTrigger[] {
    return entry.config.triggers.map((config) => ({
      ...config,
      key: triggerKeyFor(entry.workspace, config.id),
      workspace: entry.workspace,
      workspaceUri: entry.workspaceUri,
      fingerprint: triggerFingerprint(config),
    }))
  }

  private _allTriggers(): RoutedTrigger[] {
    const result: RoutedTrigger[] = []
    for (const entry of this._workspaces.values()) result.push(...this._routedTriggers(entry))
    return result
  }

  private _findTrigger(triggerKey: string): RoutedTrigger | undefined {
    const canonical = canonicalTriggerKey(triggerKey)
    if (canonical === undefined) return undefined
    const parsed = parseTriggerKey(canonical)
    if (parsed === undefined) return undefined
    const entry = this._workspaces.get(parsed.workspaceKey)
    if (entry === undefined) return undefined
    const config = entry.config.triggers.find((trigger) => trigger.id === parsed.triggerId)
    if (config === undefined) return undefined
    return {
      ...config,
      key: canonical,
      workspace: entry.workspace,
      workspaceUri: entry.workspaceUri,
      fingerprint: triggerFingerprint(config),
    }
  }

  /**
   * A poll / swarm baseline (and its dedupe keys) only makes sense for the exact
   * source it was seeded from: changing `keyField` / command / interval must seed
   * again, otherwise every new item would look "already seen".
   */
  private _syncSourceFingerprint(trigger: RoutedTrigger): void {
    const runtime = this._stateFor(trigger.key)
    const next = sourceFingerprintOf(trigger.source)
    if (runtime.sourceFingerprint === next) return
    if (runtime.sourceFingerprint === undefined) {
      // State written before the fingerprint existed: adopt it without discarding
      // the dedupe keys the user already accumulated.
      this._setTriggerState(trigger.key, { sourceFingerprint: next })
      return
    }
    let processed = runtime.processed
    for (const key of Object.keys(processed)) {
      if (PREFETCHED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        processed = forget(processed, key)
      }
    }
    const now = this._clock.now()
    this._setTriggerState(trigger.key, {
      processed: prune(processed, now, PRUNE_OPTIONS),
      baselineDone: false,
      sourceFingerprint: next,
    })
    this._logger.info(`trigger ${trigger.id}: source changed; baseline and dedupe keys reset`)
  }

  private _requireTrigger(triggerKey: string): RoutedTrigger {
    const trigger = this._findTrigger(triggerKey)
    if (trigger !== undefined) return trigger
    const parsed = canonicalTriggerKey(triggerKey)
    const canonical = parsed === undefined ? undefined : parseTriggerKey(parsed)
    const entry = canonical === undefined ? undefined : this._workspaces.get(canonical.workspaceKey)
    const invalid =
      entry === undefined || canonical === undefined
        ? undefined
        : entry.config.invalid.find((item) => item.id === canonical.triggerId)
    if (invalid !== undefined) {
      throw new Error(
        localize('triggers.error.triggerInvalid', 'Invalid trigger configuration: {errors}', {
          errors: invalid.errors.join('; '),
        }),
      )
    }
    throw new Error(
      localize('triggers.error.triggerNotFound', 'Trigger not found: {id}', {
        id: canonical?.triggerId ?? triggerKey,
      }),
    )
  }

  // ---- scheduling ---------------------------------------------------------

  /**
   * `ignoreBackoff` is for callers that must still advance their own cadence while
   * the trigger is cooling down (schedule skip accounting, poll re-arming).
   * `manual` is a user-initiated run: like `runNow` it neither requires `enabled`
   * nor honours the backoff, but pause and confirmation still gate it.
   */
  private _isRunnable(
    trigger: RoutedTrigger,
    options: { ignoreBackoff?: boolean; manual?: boolean } = {},
  ): boolean {
    if ((!trigger.enabled && !options.manual) || this._state.pausedAll) return false
    const state = this._stateFor(trigger.key)
    if (state.paused) return false
    if (!options.ignoreBackoff && !options.manual) {
      const backoffUntil = state.backoffUntil
      if (backoffUntil !== undefined && this._clock.now() < backoffUntil) return false
    }
    return !this._needsConfirmation(trigger)
  }

  private _syncTiming(now: number): void {
    this._pruneTiming()
    if (!this._gateOpen || this._disposed) return
    for (const trigger of this._allTriggers()) {
      if (trigger.source.type !== 'poll' || !this._isRunnable(trigger, { ignoreBackoff: true }))
        continue
      if (this._nextPoll.has(trigger.key)) continue
      // The first poll right after the startup grace seeds the baseline; a trigger
      // already cooling down waits for the end of its backoff.
      const backoffUntil = this._stateFor(trigger.key).backoffUntil ?? now
      this._nextPoll.set(trigger.key, Math.max(now, backoffUntil))
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
        // Backoff must not delete the anchor: the wake-up still has to happen so
        // the slot can be counted as skipped and the next one armed.
        !this._isRunnable(trigger, { ignoreBackoff: true })
      ) {
        this._armedSchedule.delete(triggerId)
      }
    }
    for (const triggerId of [...this._nextPoll.keys()]) {
      const trigger = this._findTrigger(triggerId)
      if (
        trigger === undefined ||
        trigger.source.type !== 'poll' ||
        !this._isRunnable(trigger, { ignoreBackoff: true })
      ) {
        this._nextPoll.delete(triggerId)
      }
    }
  }

  private _processDueSchedules(now: number): void {
    for (const trigger of this._allTriggers()) {
      if (trigger.source.type !== 'schedule') continue
      // Timing is evaluated even in backoff so the slot is consumed ("skipped")
      // instead of being replayed the moment the backoff ends.
      if (!this._isRunnable(trigger, { ignoreBackoff: true })) continue
      const armed = this._armedSchedule.get(trigger.key)
      if (armed !== undefined && armed > now) continue
      const backoffUntil = this._stateFor(trigger.key).backoffUntil
      if (backoffUntil !== undefined && now < backoffUntil) {
        this._logger.info(
          `trigger ${trigger.id}: schedule slot skipped (backoff until ${new Date(backoffUntil).toISOString()})`,
        )
      }
      this._evaluateSchedule(trigger, trigger.source, now)
    }
  }

  private _evaluateSchedule(
    trigger: RoutedTrigger,
    source: ScheduleSourceConfig,
    now: number,
  ): void {
    const state = this._stateFor(trigger.key)
    const decision = computeDue(source, state.lastScheduledAt, now, DEFAULT_MISSED_GRACE_MS)
    if (decision.skipped > 0) {
      this._logger.info(
        `trigger ${trigger.id}: skipped ${decision.skipped} missed schedule occurrence(s)`,
      )
    }
    const due = [...decision.due]
    let next = decision.next
    const armed = this._armedSchedule.get(trigger.key)
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
      this._setTriggerState(trigger.key, { lastScheduledAt: lastFired })
    }
    if (next === undefined) {
      this._armedSchedule.delete(trigger.key)
      if (due.length === 0) {
        this._logger.warn(`trigger ${trigger.id}: schedule has no next occurrence`)
      }
    } else {
      this._armedSchedule.set(trigger.key, next)
    }
  }

  private _processDuePolls(now: number): void {
    for (const trigger of this._allTriggers()) {
      if (trigger.source.type !== 'poll') continue
      if (!this._isRunnable(trigger, { ignoreBackoff: true })) continue
      const due = this._nextPoll.get(trigger.key)
      if (due === undefined || due > now) continue
      const backoffUntil = this._stateFor(trigger.key).backoffUntil
      if (backoffUntil !== undefined && now < backoffUntil) {
        // Do not fetch during backoff and do not leave the anchor in the past
        // (that would spin the wake timer); resume at the end of the backoff.
        this._nextPoll.set(trigger.key, backoffUntil)
        this._logger.info(`trigger ${trigger.id}: poll skipped (backoff)`)
        continue
      }
      void this._runPoll(trigger)
    }
  }

  private async _runPoll(trigger: RoutedTrigger): Promise<void> {
    if (trigger.source.type !== 'poll') return
    const source = trigger.source
    const intervalMs = source.intervalSec * 1000
    this._nextPoll.set(trigger.key, this._clock.now() + intervalMs)
    this._rescheduleWake()

    // The poll command runs in main with the user's privileges: never execute it
    // for an untrusted workspace, independently of the per-window trust check at
    // run start (a background window may not exist until a run actually starts).
    if (!(await this._trustedForPoll(trigger.workspaceUri.fsPath))) {
      this._logger.info(`trigger ${trigger.id}: poll skipped (workspace is not trusted)`)
      return
    }

    const result = await this._fetchPollItems({
      command: source.fetch.command,
      cwd: trigger.workspaceUri.fsPath,
      timeoutSec: source.fetch.timeoutSec,
      keyField: source.keyField,
    })
    const now = this._clock.now()
    const current = this._findTrigger(trigger.key)
    if (current === undefined || !this._isRunnable(current, { ignoreBackoff: true })) {
      this._logger.info(`trigger ${trigger.id}: poll result ignored (trigger no longer runnable)`)
      return
    }
    if (!result.ok) {
      this._logger.warn(`trigger ${trigger.id}: poll failed: ${result.error}`)
      this._recordFailure(current, result.error, now)
      if (this._isRunnable(current, { ignoreBackoff: true })) {
        const backoffUntil = this._stateFor(trigger.key).backoffUntil ?? now
        this._nextPoll.set(trigger.key, Math.max(now + intervalMs, backoffUntil))
      }
      this._rescheduleWake()
      return
    }

    const state = this._stateFor(trigger.key)
    if (!state.baselineDone) {
      let processed: ProcessedKeys = state.processed
      for (const item of result.items) {
        processed = markStarted(processed, `poll:${item.key}`, now)
      }
      this._setTriggerState(trigger.key, {
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
      await this._acceptEvent(this._findTrigger(trigger.key) ?? current, {
        triggerId: trigger.id,
        key: `poll:${item.key}`,
        payload: item.payload,
        firedAt: now,
      })
    }
    this._rescheduleWake()
  }

  /** Unknown checker (tests / embedding) keeps the pre-existing behavior. */
  private async _trustedForPoll(workspace: string): Promise<boolean> {
    const check = this._isWorkspaceTrusted
    if (check === undefined) return true
    try {
      return await check(workspace)
    } catch (err) {
      this._logger.warn(`workspace trust check failed for ${workspace}: ${describeError(err)}`)
      return false
    }
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

  private async _acceptEvent(
    trigger: RoutedTrigger,
    event: TriggerEvent,
    options: { ignoreBackoff?: boolean } = {},
  ): Promise<boolean> {
    if (this._disposed) return false
    const state = this._stateFor(trigger.key)
    if (this._state.pausedAll || state.paused) {
      this._logger.info(`trigger ${trigger.id}: event ${event.key} dropped (paused)`)
      return false
    }
    if (this._needsConfirmation(trigger)) {
      this._logger.info(`trigger ${trigger.id}: event ${event.key} dropped (needs confirmation)`)
      return false
    }
    const backoffUntil = state.backoffUntil
    if (!options.ignoreBackoff && backoffUntil !== undefined && this._clock.now() < backoffUntil) {
      // Swarm events in particular must stay unconsumed: no key is marked, so the
      // next report after the backoff ends triggers them normally.
      this._logger.info(`trigger ${trigger.id}: event ${event.key} dropped (backoff)`)
      return false
    }
    if (isProcessed(state.processed, event.key)) {
      this._logger.info(`trigger ${trigger.id}: duplicate event ${event.key} ignored`)
      return false
    }

    const pending: PendingRun = {
      runId: this._uuid(),
      triggerKey: trigger.key,
      triggerId: trigger.id,
      workspace: trigger.workspace,
      eventKey: event.key,
      firedAt: event.firedAt,
    }
    // Reserve the key synchronously, before the await below: two concurrent
    // reports must not both pass the dedupe check.
    this._markProcessed(trigger.key, event.key, 'queued')
    try {
      await writeJsonAtomic(this._pendingPayloadPath(pending.runId), event)
    } catch (err) {
      this._logger.warn(
        `trigger ${trigger.id}: cannot stage event ${event.key}: ${describeError(err)}`,
      )
      this._forgetKey(trigger.key, event.key)
      this._recordFailure(
        trigger,
        localize('triggers.error.pendingWriteFailed', 'Could not stage the trigger event on disk'),
      )
      return false
    }

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

  private _queueOptions(trigger: RoutedTrigger): RunQueueOptions {
    return {
      concurrency: trigger.concurrency,
      overflow: trigger.overflow,
      queueLimit: TRIGGER_DEFAULTS.queueLimit,
    }
  }

  private async _startRun(pending: PendingRun): Promise<void> {
    const trigger = this._findTrigger(pending.triggerKey)
    // Pause / disable / confirmation may have landed while the run sat in the queue:
    // those are not failures, so release the slot and forget the key quietly.
    const manual = pending.eventKey.startsWith('manual:')
    if (trigger === undefined || !this._isRunnable(trigger, { manual })) {
      this._logger.info(
        `run ${pending.runId}: not started trigger=${pending.triggerId} key=${pending.eventKey} (no longer runnable)`,
      )
      this._active.delete(pending.runId)
      this._releaseSlot(pending.runId)
      this._forgetKey(pending.triggerKey, pending.eventKey, pending.runId)
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
      const { host, windowId } = await this._resolveHost(trigger)
      const beforeStart = this._active.get(pending.runId)
      if (beforeStart === undefined) return
      beforeStart.windowId = windowId
      // Trust is checked before anything is written to disk for this run.
      const trusted = await host.isWorkspaceTrusted()
      if (!trusted) {
        throw new Error(
          localize('triggers.error.workspaceUntrusted', 'The workspace is not trusted'),
        )
      }
      const runDir = await this._createRunDir(pending.runId)
      const request = this._buildRunRequest(trigger, pending, event, runDir)
      const result = await this._startHostRun(host, request, pending.runId)
      if (result === undefined) {
        throw new Error(
          localize(
            'triggers.error.startRunTimeout',
            'The editor window did not start the run in time',
          ),
        )
      }
      if (!this._active.has(pending.runId)) {
        void host.cancelRun(pending.runId).catch(() => undefined)
        return
      }
      this._markProcessed(trigger.key, pending.eventKey, 'started')
      this._removePendingRecord(pending.runId)
      const active = this._active.get(pending.runId)
      if (active !== undefined) {
        active.phase = 'running'
        active.sessionId = result.sessionId
        this._armWatchdog(active, trigger)
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

  /**
   * A renderer that dies without closing its window (reload loop, OOM without a
   * clean unload) never reports its run end. Past the configured budget plus a
   * grace period the run is failed and the host is asked to cancel.
   */
  private _armWatchdog(run: ActiveRun, trigger: RoutedTrigger): void {
    this._clearWatchdog(run)
    const budgetMs =
      (trigger.session.budget.timeoutMin + trigger.session.budget.approvalTimeoutMin) * 60_000
    const deadline = this._clock.now() + Math.max(0, budgetMs) + WATCHDOG_GRACE_MS
    run.watchdogTimer = this._clock.setTimeout(
      () => {
        run.watchdogTimer = undefined
        this._onWatchdog(run.runId)
      },
      Math.max(0, deadline - this._clock.now()),
    )
  }

  private _clearWatchdog(run: ActiveRun): void {
    if (run.watchdogTimer !== undefined) {
      this._clock.clearTimeout(run.watchdogTimer)
      run.watchdogTimer = undefined
    }
  }

  private _onWatchdog(runId: string): void {
    const entry = this._active.get(runId)
    if (entry === undefined) return
    const trigger = this._findTrigger(entry.triggerKey)
    const budget = trigger?.session.budget ?? TRIGGER_DEFAULTS.budget
    this._logger.warn(
      `run ${runId}: no end report after ${budget.timeoutMin + budget.approvalTimeoutMin}min budget + ${WATCHDOG_GRACE_MS}ms grace trigger=${entry.triggerId} key=${entry.eventKey}`,
    )
    const host = entry.windowId === undefined ? undefined : this._hosts.get(entry.windowId)
    if (host !== undefined) {
      void host.cancelRun(runId).catch((err: unknown) => {
        this._logger.warn(`run ${runId}: watchdog cancel failed: ${describeError(err)}`)
      })
    }
    this._failActiveRun(
      runId,
      localize('triggers.error.runWatchdog', 'The automated run did not report its end in time'),
    )
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
      timer = this._clock.setTimeout(() => {
        timedOut = true
        resolve(undefined)
      }, this._startRunTimeoutMs)
    })
    const started = host.startRun(request).then(
      (result) => {
        if (timedOut) {
          this._logger.warn(`run ${runId}: renderer started it after the timeout; cancelling`)
          void host.cancelRun(runId).catch((err: unknown) => {
            this._logger.warn(`run ${runId}: late cancel failed: ${describeError(err)}`)
          })
          return undefined
        }
        return result
      },
      (err: unknown) => {
        if (timedOut) {
          this._logger.warn(`run ${runId}: renderer reported a start failure after the timeout`)
          return undefined
        }
        throw err
      },
    )
    const result = await Promise.race([started, timeout])
    if (timer !== undefined) this._clock.clearTimeout(timer)
    return result
  }

  private async _resolveHost(
    trigger: RoutedTrigger,
  ): Promise<{ host: ITriggerRunHost; windowId: number }> {
    const target = { folder: trigger.workspace }
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
        await provider.openWindowForFolderInBackground(trigger.workspaceUri)
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
    trigger: RoutedTrigger,
    pending: PendingRun,
    event: TriggerEvent,
    runDir: string,
  ): TriggerRunRequest {
    const session = trigger.session
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
    const state = this._stateFor(trigger.key)
    const elevated = isElevatedModeId(session.mode) && state.elevatedConfirmed === fingerprint
    const approve =
      trigger.allowedActions.includes('swarm.approve') && state.approveConfirmed === fingerprint
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
      cwd: join(trigger.workspaceUri.fsPath, session.cwd ?? ''),
      ...(session.mode === undefined ? {} : { mode: session.mode }),
      allowElevatedMode: elevated,
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(session.mcpServers === undefined ? {} : { mcpServerNames: session.mcpServers }),
      prompt,
      promptForSystemContract,
      runDir,
      budget: session.budget,
      allowedActions: trigger.allowedActions,
      approveConfirmed: approve,
      payload: event.payload,
      sourceType: trigger.source.type,
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
    // Retention must never delete a directory whose run is still alive.
    const protectedRunIds = new Set<string>([
      ...this._active.keys(),
      ...this._queued.keys(),
      ...this._state.pending.map((record) => record.runId),
    ])
    await pruneRunDirectories(this._runsDir, this._maxRunDirectories, this._logger, protectedRunIds)
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
    const trigger = this._findTrigger(item.triggerKey)
    const manual = item.eventKey.startsWith('manual:')
    if (trigger === undefined || !this._isRunnable(trigger, { manual })) {
      // Paused / disabled while queued: not a failure, just drop the reservation.
      this._logger.info(
        `run ${item.runId}: dropped trigger=${item.triggerId} key=${item.eventKey} (no longer runnable)`,
      )
      this._forgetKey(item.triggerKey, item.eventKey, item.runId)
      this._releaseSlot(item.runId)
      this._fireChange()
      return
    }
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
    this._forgetKey(pending.triggerKey, pending.eventKey, pending.runId)
  }

  private _failActiveRun(runId: string, message: string): void {
    const entry = this._active.get(runId)
    if (entry === undefined) return
    this._clearWatchdog(entry)
    this._active.delete(runId)
    this._releaseSlot(runId)
    this._forgetKey(entry.triggerKey, entry.eventKey, runId)
    const trigger = this._findTrigger(entry.triggerKey)
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
    if (!this._gateOpen || this._disposed || this._replaying) return
    this._replaying = true
    try {
      for (const record of [...this._state.pending]) {
        if (this._queued.has(record.runId) || this._active.has(record.runId)) continue
        const entry = this._stateFor(record.triggerKey).processed[record.eventKey]
        if (entry === undefined || entry.status !== 'queued') {
          // Already started before the restart: never replay.
          this._removePendingRecord(record.runId)
          continue
        }
        const trigger = this._findTrigger(record.triggerKey)
        const manual = record.eventKey.startsWith('manual:')
        if (trigger === undefined || !this._isRunnable(trigger, { manual })) {
          // Keep the record untouched: a later resume / confirmation / backoff
          // expiry replays it.
          this._logger.info(
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
        if ((await this._readPendingEvent(pending)) === undefined) {
          this._logger.warn(`pending run ${record.runId}: payload missing, forgetting the event`)
          this._forgetKey(record.triggerKey, record.eventKey, record.runId)
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
        this._logger.info(
          `pending run ${record.runId}: re-enqueued trigger=${parseTriggerKey(record.triggerKey)?.triggerId ?? record.triggerKey}`,
        )
      }
    } finally {
      this._replaying = false
    }
  }

  // ---- failures / notifications -------------------------------------------

  private _recordFailure(trigger: RoutedTrigger, message: string, now = this._clock.now()): void {
    const state = this._stateFor(trigger.key)
    const consecutiveFailures = state.consecutiveFailures + 1
    const backoffUntil = now + nextBackoffMs(consecutiveFailures)
    const autoPause = shouldAutoPause(consecutiveFailures) && !state.paused
    this._setTriggerState(trigger.key, {
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

  private _isActivated(trigger: RoutedTrigger): boolean {
    return this._stateFor(trigger.key).activationConfirmed === trigger.fingerprint
  }

  private _needsElevatedConfirmation(trigger: RoutedTrigger): boolean {
    if (!isElevatedModeId(trigger.session.mode)) return false
    return this._stateFor(trigger.key).elevatedConfirmed !== trigger.fingerprint
  }

  private _needsConfirmation(trigger: RoutedTrigger): boolean {
    return !this._isActivated(trigger) || this._needsElevatedConfirmation(trigger)
  }

  private _summaries(): readonly TriggerSummary[] {
    const summaries: TriggerSummary[] = []
    for (const trigger of this._allTriggers()) {
      const state = this._stateFor(trigger.key)
      const stats = this._queue.stats(trigger.key)
      const fingerprint = trigger.fingerprint
      const activationConfirmed = state.activationConfirmed === fingerprint
      const elevatedMode = isElevatedModeId(trigger.session.mode)
      const elevatedModeConfirmed = elevatedMode && state.elevatedConfirmed === fingerprint
      const approveAction = trigger.allowedActions.includes('swarm.approve')
      const approveConfirmed = approveAction && state.approveConfirmed === fingerprint
      const paused = state.paused || this._state.pausedAll
      const needsConfirmation = !activationConfirmed || (elevatedMode && !elevatedModeConfirmed)
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
        key: trigger.key,
        id: trigger.id,
        name: trigger.name,
        workspace: trigger.workspace,
        workspaceName: workspaceFolderName(trigger.workspace),
        sourceType: trigger.source.type,
        status,
        enabled: trigger.enabled,
        paused,
        activationConfirmed,
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
    for (const entry of this._workspaces.values()) {
      for (const invalid of entry.config.invalid) {
        summaries.push({
          key: triggerKeyFor(entry.workspace, invalid.id),
          id: invalid.id,
          name: invalid.id,
          workspace: entry.workspace,
          workspaceName: workspaceFolderName(entry.workspace),
          sourceType: 'unknown',
          status: 'invalid',
          enabled: false,
          paused: false,
          activationConfirmed: false,
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
    }
    return summaries
  }

  private _nextRunAt(trigger: RoutedTrigger, paused: boolean): number | undefined {
    if (!trigger.enabled || paused) return undefined
    if (trigger.source.type === 'schedule') return this._armedSchedule.get(trigger.key)
    if (trigger.source.type === 'poll') return this._nextPoll.get(trigger.key)
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
    triggerKey: pending.triggerKey,
    eventKey: pending.eventKey,
    firedAt: pending.firedAt,
  }
}

function formatActions(end: TriggerRunEnd): string {
  if (end.actions.length === 0) return '-'
  return end.actions.map((action) => `${action.type}@${action.target}=${action.result}`).join(',')
}

/** Audit details are single-line; action reasons are validation/error text only. */
function sanitizeAuditReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** Normalized source identity; changing it invalidates a poll / swarm baseline. */
function sourceFingerprintOf(source: TriggerSourceConfig): string {
  switch (source.type) {
    case 'poll':
      return `poll|${source.keyField}|${source.fetch.command}|${source.intervalSec}`
    case 'swarm-review':
      return 'swarm-review'
    case 'schedule':
      return `schedule|${source.cron ?? ''}|${source.everyMin ?? ''}`
    case 'manual':
      return 'manual'
  }
}

/** Keeps the newest `keep` run directories (by mtime) and deletes the rest. */
export async function pruneRunDirectories(
  root: string,
  keep: number,
  logger?: ILogger,
  protectedRunIds: ReadonlySet<string> = new Set<string>(),
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
  const doomed = ordered.filter((entry) => !protectedRunIds.has(entry.name)).slice(keep)
  for (const entry of doomed) {
    try {
      await rm(join(root, entry.name), { recursive: true, force: true })
    } catch (err) {
      logger?.warn(`cannot remove old run directory ${entry.name}: ${describeError(err)}`)
    }
  }
  if (doomed.length > 0) logger?.info(`removed ${doomed.length} old run director(ies)`)
}

function workspaceFsPath(workspace: string): string {
  return parseWorkspaceUri(workspace)?.fsPath ?? workspace
}

function workspaceFolderName(workspace: string): string {
  const uri = parseWorkspaceUri(workspace)
  const name = uri === undefined ? basename(workspace) : basename(uri.path)
  return name.length > 0 ? name : workspace
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}
