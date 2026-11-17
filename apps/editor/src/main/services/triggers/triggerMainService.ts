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

import { basename, join } from 'node:path'
import {
  Disposable,
  Emitter,
  generateUuid,
  localize,
  normalizeRemoteAuthority,
  REMOTE_SCHEME,
  URI,
  type Event,
  type IFileService,
  type ILogger,
} from '@universe-editor/platform'
import type {
  ITriggerMainService,
  ITriggerRunHost,
  TriggerManualEvent,
  TriggerPollPreview,
  TriggerPollPreviewItem,
} from '../../../shared/ipc/triggerService.js'
import {
  isElevatedModeId,
  MAX_TRIGGER_REPORT_BYTES,
  TRIGGER_DEFAULTS,
  type TriggerEvent,
  type TriggerRunEnd,
  type TriggerRunFilter,
  type TriggerRunHistoryEntry,
  type TriggerRunReportReadResult,
  type TriggerSessionSurface,
  type TriggerStatus,
  type TriggerSummary,
  type TriggerWorkspaceSummary,
} from '../../../shared/triggers/types.js'
import { isProcessed, markStarted, prune } from '../../../shared/triggers/dedupe.js'
import { nextBackoffMs, shouldAutoPause } from '../../../shared/triggers/backoff.js'
import { parseWorkspaceUri, TRIGGERS_CONFIG_EXAMPLE } from '../../../shared/triggers/configParse.js'
import { AuditLog } from '../mobileGateway/auditLog.js'
import {
  ensureTriggersConfigFile,
  normalizeMaxConcurrentRuns,
  triggersDirectory,
  workspaceTriggersConfigDirUri,
  workspaceTriggersConfigLocation,
  workspaceTriggersConfigPath,
  workspaceTriggersConfigUri,
} from './triggersConfigFile.js'
import {
  RemoteTriggerConfigStore,
  isRemoteWorkspaceUri,
  type RemoteTriggerConfigStoreOptions,
  type TriggerConfigStore,
} from './triggerConfigStore.js'
import { TriggerWorkspaceRegistry } from './triggerWorkspaceRegistry.js'
import { parseTriggerKey, triggerKeyFor, workspaceComparisonKey } from './triggerIdentity.js'
import type { TriggerRuntimeState } from './triggerStateStore.js'
import { TriggerStateRepository, type RuntimeStatePatch } from './triggerStateRepository.js'
import { systemTriggerClock, type TriggerClock } from './triggerClock.js'
import { TriggerWindowHub, type TriggerWindowProvider } from './triggerWindowHub.js'
import { PollRunner } from './pollRunner.js'
import { TriggerScheduler } from './triggerScheduler.js'
import { TriggerRunLedger } from './triggerRunLedger.js'
import { TriggerCatalog } from './triggerCatalog.js'
import { TriggerEventSourceRegistry, type TriggerEventSourceItem } from './triggerEventSources.js'
import { createSwarmTriggerEventSource } from './swarmTriggerEventSource.js'
import { RemoteIoUnavailableError } from './triggerErrors.js'
import {
  LocalExecutionBackend,
  RemoteExecutionBackend,
  workspaceAuthorityOf,
  type BackendPollOutcome,
  type TriggerExecutionBackend,
} from './triggerExecutionBackend.js'
import type { RoutedTrigger } from './triggerTypes.js'
import { createPollCommandFetcher, type PollCommandFetcher } from './pollCommandFetcher.js'
import { sanitizeManualPayload, sanitizeManualSourceKey } from './triggerManualPayload.js'
import { SessionReportReader } from './runReportReader.js'
import { TriggerHistoryStore } from './triggerHistoryStore.js'
import { getMachineId } from '../host/machineId.js'
import { processLifecycle } from '../process/processLifecycle.js'
import type { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'

/**
 * The forward IPC channel is per window but the service instance is shared, so a
 * bare `markHostReady(workspace)` cannot tell which window acknowledged. Wrap the
 * singleton per channel and stamp the sender's window id; every other method is
 * delegated untouched.
 */
export function createWindowScopedTriggerMainService(
  service: TriggerMainService,
  windowId: number,
): ITriggerMainService {
  return new Proxy(service, {
    get(target, property, receiver) {
      if (property === 'markHostReady') {
        return (workspaceFolder: string) => target.markHostReady(workspaceFolder, windowId)
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

export { systemTriggerClock, type TriggerClock, type TriggerTimerHandle } from './triggerClock.js'
export type { TriggerWindowProvider } from './triggerWindowHub.js'

export interface TriggerMainServiceOptions {
  readonly userDataDir: string
  readonly logger: ILogger
  readonly clock?: TriggerClock
  /** Electron `Notification` in production; a spy in tests. */
  readonly notify?: (title: string, body: string) => void
  readonly fetchPollItems?: PollCommandFetcher
  readonly auditLog?: AuditLog
  /** Test seam for the run history file (default: `<userData>/triggers/history.jsonl`). */
  readonly historyStore?: TriggerHistoryStore
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
  readonly isWorkspaceTrusted?: (workspaceUri: string) => Promise<boolean>
  /** Scheme-routed filesystem gateway; remote workspace configs need it. */
  readonly fileService?: IFileService
  /** Gate and lifecycle source for remote workspace configs. */
  readonly remoteConnections?: IRemoteConnectionService
  /** Test seam: override the remote store (default: RemoteTriggerConfigStore). */
  readonly createRemoteConfigStore?: (
    options: RemoteTriggerConfigStoreOptions,
  ) => TriggerConfigStore
  /** This installation's id; namespaces its run directories on a shared remote host. */
  readonly clientId?: () => Promise<string>
  /** Extra wait on top of the poll command's own timeout before the RPC is abandoned. */
  readonly remotePollGraceMs?: number
  /** Hard cap on one trigger's dedupe keys (test seam; defaults to the production limit). */
  readonly processedKeyLimit?: number
}

const DEFAULT_MAX_RUN_DIRECTORIES = 200
const DEFAULT_HOST_WAIT_TIMEOUT_MS = 60_000
const DEFAULT_REMOTE_POLL_GRACE_MS = 10_000

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
  private readonly _reportReader: SessionReportReader
  private readonly _localBackend: LocalExecutionBackend
  private readonly _remoteBackends = new Map<string, RemoteExecutionBackend>()
  private readonly _auditLog: AuditLog
  private readonly _historyStore: TriggerHistoryStore
  private readonly _registry: TriggerWorkspaceRegistry
  private readonly _stateRepo: TriggerStateRepository
  private readonly _readMaxConcurrentRuns: () => Promise<number>
  private readonly _isWorkspaceTrusted: ((workspace: string) => Promise<boolean>) | undefined
  private readonly _fileService: IFileService | undefined
  private readonly _remoteConnections: IRemoteConnectionService | undefined
  private readonly _clientId: () => Promise<string>
  private readonly _remotePollGraceMs: number
  private readonly _processedKeyLimit: number
  private _clientIdPromise: Promise<string> | undefined
  private readonly _pollRunner: PollRunner
  private readonly _ledger: TriggerRunLedger
  private readonly _scheduler: TriggerScheduler
  private readonly _onDidChangeTriggers = this._register(new Emitter<readonly TriggerSummary[]>())
  readonly onDidChangeTriggers: Event<readonly TriggerSummary[]> = this._onDidChangeTriggers.event

  private readonly _windowHub: TriggerWindowHub
  private readonly _catalog: TriggerCatalog
  private readonly _eventSources = new TriggerEventSourceRegistry()
  private _changeScheduled = false
  private _lastChangeSignature: string | undefined
  private readonly _ready: Promise<void>
  private _disposed = false

  constructor(options: TriggerMainServiceOptions) {
    super()
    this._register(this._eventSources)
    this._register(this._eventSources.register(createSwarmTriggerEventSource()))
    this._logger = options.logger
    this._clock = options.clock ?? systemTriggerClock
    this._notify = options.notify ?? (() => undefined)
    this._fetchPollItems =
      options.fetchPollItems ??
      createPollCommandFetcher(options.logger, {
        lifecycle: { registry: processLifecycle },
      })
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
    this._readMaxConcurrentRuns =
      options.readMaxConcurrentRuns ?? (() => Promise.resolve(TRIGGER_DEFAULTS.maxConcurrentRuns))
    this._isWorkspaceTrusted = options.isWorkspaceTrusted
    this._fileService = options.fileService
    this._remoteConnections = options.remoteConnections
    const userDataDir = options.userDataDir
    this._clientId = options.clientId ?? (() => getMachineId(userDataDir))
    this._remotePollGraceMs = Math.max(0, options.remotePollGraceMs ?? DEFAULT_REMOTE_POLL_GRACE_MS)
    this._processedKeyLimit = Math.max(
      1,
      Math.floor(options.processedKeyLimit ?? TRIGGER_DEFAULTS.processedKeyLimit),
    )
    if (options.remoteConnections !== undefined) {
      this._register(
        options.remoteConnections.onDidChangeState((change) =>
          this._catalog?.onConnectionStateChange(change),
        ),
      )
    }
    if (options.configDirChanged !== undefined) {
      this._register(options.configDirChanged(() => void this._reloadMaxConcurrentRuns()))
    }
    this._reportReader = new SessionReportReader({
      runsDir: this._runsDir,
      maxBytes: MAX_TRIGGER_REPORT_BYTES,
      logger: options.logger,
    })
    this._localBackend = new LocalExecutionBackend({
      fetchPollItems: this._fetchPollItems,
      runsDir: this._runsDir,
      reportReader: this._reportReader,
      maxRunDirectories: this._maxRunDirectories,
      logger: options.logger,
    })
    this._auditLog =
      options.auditLog ??
      new AuditLog(join(this._dir, 'audit.jsonl'), { now: () => this._clock.now() })
    this._historyStore =
      options.historyStore ??
      new TriggerHistoryStore({
        file: join(this._dir, 'history.jsonl'),
        logger: options.logger,
      })
    this._stateRepo = new TriggerStateRepository({
      file: join(this._dir, 'state.json'),
      pendingDir: join(this._dir, 'pending'),
      logger: options.logger,
      clock: this._clock,
      ...(options.stateDebounceMs === undefined ? {} : { debounceMs: options.stateDebounceMs }),
      ...(options.processedKeyLimit === undefined
        ? {}
        : { processedKeyLimit: options.processedKeyLimit }),
    })
    this._registry = new TriggerWorkspaceRegistry({
      file: join(this._dir, 'workspaces.json'),
      logger: options.logger,
    })
    this._pollRunner = new PollRunner({
      logger: this._logger,
      clock: this._clock,
      processedKeyLimit: this._processedKeyLimit,
      findTrigger: (triggerKey) => this._catalog.findTrigger(triggerKey),
      isRunnable: (trigger, options) => this._isRunnable(trigger, options),
      isTrusted: (workspaceUri) => this._trustedForPoll(workspaceUri),
      backendFor: (trigger) => this._backendFor(trigger),
      stateFor: (triggerKey) => this._stateFor(triggerKey),
      setTriggerState: (triggerKey, patch) => this._setTriggerState(triggerKey, patch),
      pruneOptionsFor: (triggerKey) => this._stateRepo.pruneOptionsFor(triggerKey),
      raiseProcessedLimit: (triggerKey, limit) =>
        this._stateRepo.raiseProcessedLimit(triggerKey, limit),
      acceptEvent: (trigger, event) => this._ledger.acceptEvent(trigger, event),
      recordFailure: (trigger, message, now) => this._recordFailure(trigger, message, now),
      fireChange: () => this._fireChange(),
      onPollFinished: (triggerKey) => this._scheduler.finishPoll(triggerKey),
    })
    this._ledger = new TriggerRunLedger({
      logger: this._logger,
      clock: this._clock,
      uuid: this._uuid,
      startRunTimeoutMs: this._startRunTimeoutMs,
      findTrigger: (triggerKey) => this._catalog.findTrigger(triggerKey),
      isRunnable: (trigger, options) => this._isRunnable(trigger, options),
      isWorkspaceOffline: (trigger) => this._catalog.isWorkspaceOffline(trigger),
      remoteWindowMissing: (trigger) => this._catalog.remoteWindowMissing(trigger),
      resolveHost: (trigger) => this._windowHub.resolveHost(trigger),
      getHost: (windowId) => this._windowHub.getHost(windowId),
      backendFor: (trigger) => this._backendFor(trigger),
      workspaceAuthority: (workspaceUri) => this._workspaceAuthority(workspaceUri),
      authorityOfKey: (triggerKey) => this._authorityOfKey(triggerKey),
      stateFor: (triggerKey) => this._stateFor(triggerKey),
      isPausedAll: () => this._stateRepo.state.pausedAll,
      setTriggerState: (triggerKey, patch) => this._setTriggerState(triggerKey, patch),
      markProcessed: (triggerKey, eventKey, status) =>
        this._markProcessed(triggerKey, eventKey, status),
      forgetKey: (triggerKey, eventKey, runId) => this._forgetKey(triggerKey, eventKey, runId),
      removePendingRecord: (runId) => this._removePendingRecord(runId),
      pendingRecords: () => this._stateRepo.pendingRecords(),
      stateProtectedRunIds: () => this._stateRepo.protectedRunIds(),
      isGateOpen: () => this._scheduler.isGateOpen(),
      addPending: (record) => this._stateRepo.addPending(record),
      writePendingPayload: (runId, event) => this._stateRepo.writePendingPayload(runId, event),
      readPendingEvent: (pending) => this._stateRepo.readPendingEvent(pending),
      recordFailure: (trigger, message, now) => this._recordFailure(trigger, message, now),
      audit: (action, result, detail) => this._audit(action, result, detail),
      fireChange: () => this._fireChange(),
    })
    this._scheduler = new TriggerScheduler({
      logger: options.logger,
      clock: this._clock,
      startupGraceMs: this._startupGraceMs,
      pollRunner: this._pollRunner,
      allTriggers: () => this._catalog.allTriggers(),
      findTrigger: (triggerKey) => this._catalog.findTrigger(triggerKey),
      isRunnable: (trigger, options) => this._isRunnable(trigger, options),
      stateFor: (triggerKey) => this._stateFor(triggerKey),
      setTriggerState: (triggerKey, patch) => this._setTriggerState(triggerKey, patch),
      acceptEvent: (trigger, event) => this._ledger.acceptEvent(trigger, event),
      fireChange: () => this._fireChange(),
      replayPendingRuns: () => void this._ledger.replayPendingRuns(),
    })
    this._windowHub = new TriggerWindowHub({
      logger: options.logger,
      hostWaitTimeoutMs: this._hostWaitTimeoutMs,
      hostWaitPollMs: this._hostWaitPollMs,
      isRemoteIoAllowed: (authority) => this._catalog.remoteIoAllowed(authority),
      failRunsForWindow: (windowId, message) => this._ledger.failRunsForWindow(windowId, message),
      onWorkspaceFolder: (folder) => void this._catalog.discover(folder),
      onHostRegistered: () => this._scheduler.noteHostRegistered(),
      onHostReady: () => {
        if (this._scheduler.isGateOpen()) void this._ledger.replayPendingRuns()
      },
      onWindowFoldersChanged: () => this._catalog.detachRemoteWorkspacesWithoutWindow(),
    })
    this._catalog = new TriggerCatalog({
      logger: this._logger,
      clock: this._clock,
      registry: this._registry,
      stateRepo: this._stateRepo,
      scheduler: this._scheduler,
      ledger: this._ledger,
      windowHub: this._windowHub,
      fileService: options.fileService,
      remoteConnections: options.remoteConnections,
      createRemoteConfigStore:
        options.createRemoteConfigStore ??
        ((storeOptions) => new RemoteTriggerConfigStore(storeOptions)),
      fireChange: () => this._fireChange(),
      awaitReady: () => this._awaitReady(),
      isDisposed: () => this._disposed,
      isGateOpen: () => this._scheduler.isGateOpen(),
      replayPendingRuns: () => void this._ledger.replayPendingRuns(),
      backendForWorkspace: (workspaceUri) => this._backendForWorkspace(workspaceUri),
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
    // Persist a pending debounced write first so an observer that reads state.json
    // right after listing sees the same snapshot (tests and support diagnostics).
    await this._stateRepo.flushIfPending()
    return this._summaries()
  }

  async listWorkspaces(): Promise<readonly TriggerWorkspaceSummary[]> {
    await this._awaitReady()
    return this._registry.list().map((workspace) => {
      const entry = this._catalog.workspaceEntry(workspaceComparisonKey(workspace))
      return {
        workspace,
        name: workspaceFolderName(workspace),
        configPath: workspaceTriggersConfigLocation(workspace),
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
    this._ledger.setGlobalLimit(normalized)
    this._logger.info(`trigger concurrency limit: ${normalized} (settings change)`)
  }

  async runNow(triggerKey: string, manualEvent?: TriggerManualEvent): Promise<void> {
    await this._awaitReady()
    const trigger = this._catalog.requireTrigger(triggerKey)
    if (this._stateRepo.state.pausedAll) {
      throw new Error(localize('triggers.error.allPaused', 'All triggers are paused'))
    }
    if (this._catalog.isWorkspaceOffline(trigger)) {
      throw new Error(
        localize(
          'triggers.error.remoteNotConnected',
          'The remote host for this trigger is not connected. Reconnect and try again.',
        ),
      )
    }
    if (!this._isActivated(trigger)) {
      throw new Error(
        localize(
          'triggers.error.needsConfirmation',
          'Confirm this trigger before running it (it comes from a workspace configuration file)',
        ),
      )
    }
    const payload = sanitizeManualPayload(manualEvent?.payload)
    const sourceKey = sanitizeManualSourceKey(manualEvent?.sourceKey)
    if (manualEvent?.sourceKey !== undefined && sourceKey === undefined) {
      this._logger.debug(`trigger ${trigger.id}: ignored a malformed manual source key`)
    }
    const consumeKeys = trigger.source.type === 'poll' && sourceKey !== undefined ? [sourceKey] : []
    const event: TriggerEvent = {
      triggerId: trigger.id,
      key: `manual:${this._uuid()}`,
      payload,
      firedAt: this._clock.now(),
    }
    this._logger.info(
      `trigger ${trigger.id} (${trigger.workspace}): manual event ${event.key}` +
        (consumeKeys.length > 0 ? ` consume=${consumeKeys.length}` : ''),
    )
    // A user-initiated run is an explicit override of the failure backoff and of
    // this trigger's pause: pausing only stops automatic scheduling. The global
    // pause stays an emergency stop and still rejects it above.
    await this._ledger.acceptEvent(trigger, event, {
      ignoreBackoff: true,
      manual: true,
      ...(consumeKeys.length > 0 ? { consumeKeys } : {}),
    })
  }

  async previewPollEvents(triggerKey: string): Promise<TriggerPollPreview> {
    await this._awaitReady()
    const trigger = this._catalog.requireTrigger(triggerKey)
    const source = trigger.source
    if (source.type !== 'poll') return { kind: 'unsupported' }
    if (this._stateRepo.state.pausedAll) {
      return { kind: 'unavailable', reason: 'all-paused' }
    }
    if (this._catalog.isWorkspaceOffline(trigger)) {
      return { kind: 'unavailable', reason: 'offline' }
    }
    if (!this._isActivated(trigger)) {
      return { kind: 'unavailable', reason: 'needs-confirmation' }
    }
    if (this._catalog.remoteWindowMissing(trigger)) {
      return { kind: 'unavailable', reason: 'window-missing' }
    }
    // The preview actually spawns fetch.command with the user's privileges, so it
    // must pass the same trust gate as the automatic poll.
    if (!(await this._trustedForPoll(trigger.workspaceUri.toString()))) {
      return { kind: 'unavailable', reason: 'workspace-not-trusted' }
    }
    // Best effort: an automatic poll that starts right after this check can still
    // overlap. Fetch commands are expected to be read-only.
    if (this._pollRunner.isPolling(trigger.key)) {
      return { kind: 'unavailable', reason: 'poll-in-progress' }
    }

    let outcome: BackendPollOutcome
    try {
      outcome = await this._backendFor(trigger).fetchPoll(trigger, source)
    } catch (err) {
      const detail = describeError(err)
      this._logger.warn(`trigger ${trigger.id}: manual poll preview failed: ${detail}`)
      return { kind: 'unavailable', reason: 'poll-failed', detail }
    }
    if (outcome.kind === 'skipped') {
      this._logger.info(`trigger ${trigger.id}: manual poll preview skipped (${outcome.reason})`)
      return { kind: 'unavailable', reason: 'poll-skipped', detail: outcome.reason }
    }
    if (!outcome.result.ok) {
      this._logger.warn(
        `trigger ${trigger.id}: manual poll preview failed: ${outcome.result.error}`,
      )
      return { kind: 'unavailable', reason: 'poll-failed', detail: outcome.result.error }
    }

    // Read-only: neither baselineDone nor processed nor failure/backoff change
    // here. Only the item the user actually runs is consumed, by `runNow`.
    const processed = this._stateFor(trigger.key).processed
    let processedCount = 0
    const items: TriggerPollPreviewItem[] = outcome.result.items.map((item) => {
      const key = `poll:${item.key}`
      const alreadyProcessed = isProcessed(processed, key)
      if (alreadyProcessed) processedCount += 1
      const raw = item.payload[source.keyField]
      const title = item.payload['title']
      return {
        key,
        value: raw === undefined ? item.key : String(raw),
        ...(typeof title === 'string' ? { title } : {}),
        payload: item.payload,
        processed: alreadyProcessed,
      }
    })
    this._logger.info(
      `trigger ${trigger.id}: manual poll preview items=${items.length} processed=${processedCount}`,
    )
    return { kind: 'ok', items }
  }

  async setPaused(triggerKey: string, paused: boolean): Promise<void> {
    await this._awaitReady()
    const trigger = this._catalog.requireTrigger(triggerKey)
    this._setTriggerState(
      trigger.key,
      paused
        ? { paused: true, lastError: undefined }
        : {
            paused: false,
            autoPaused: undefined,
            consecutiveFailures: 0,
            backoffUntil: undefined,
            lastError: undefined,
          },
    )
    if (paused) {
      // Pausing stops automatic scheduling: queued automatic events are dropped
      // (their keys forgotten so they can fire again after resume). A manual run
      // is an explicit user action and survives the pause.
      this._ledger.dropAutomaticQueued(trigger.key)
      this._scheduler.forgetTrigger(trigger.key)
    }
    this._logger.info(`trigger ${trigger.id}: ${paused ? 'paused' : 'resumed'} by the user`)
    this._audit(
      paused ? 'trigger-paused' : 'trigger-resumed',
      'success',
      `trigger=${trigger.id} workspace=${trigger.workspace}`,
    )
    this._scheduler.syncTiming(this._clock.now())
    if (!paused) void this._ledger.replayPendingRuns()
    this._fireChange()
  }

  async setAllPaused(paused: boolean): Promise<void> {
    await this._awaitReady()
    this._stateRepo.setPausedAll(paused)
    if (paused) {
      this._ledger.dropAllQueued()
      this._scheduler.forgetAll()
    } else {
      this._scheduler.syncTiming(this._clock.now())
      void this._ledger.replayPendingRuns()
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
  async confirmActivation(triggerKey: string, fingerprint: string): Promise<void> {
    await this._awaitReady()
    const trigger = this._catalog.requireTrigger(triggerKey)
    // The dialog was built from a renderer snapshot: reject a grant that no longer
    // describes the current definition (it may now carry an unseen mode).
    if (fingerprint !== trigger.fingerprint) {
      throw new Error(
        localize(
          'triggers.error.definitionChanged',
          'The trigger definition changed. Review it again before confirming.',
        ),
      )
    }
    this._setTriggerState(trigger.key, { activationConfirmed: trigger.fingerprint })
    this._logger.info(
      `trigger ${trigger.id} (${trigger.workspace}): activation confirmed fingerprint=${trigger.fingerprint}`,
    )
    this._audit(
      'confirm-activation',
      'success',
      `trigger=${trigger.id} workspace=${trigger.workspace} fingerprint=${trigger.fingerprint}`,
    )
    this._scheduler.syncTiming(this._clock.now())
    void this._ledger.replayPendingRuns()
    this._fireChange()
  }

  /**
   * Create `<workspace>/.universe-editor/triggers.json` with the example when absent,
   * register the workspace and start watching it. The caller supplies the window's
   * current folder — main has no way to tell which window issued the command.
   * Remote folders go through IFileService and require a live connection.
   */
  async ensureConfigFile(workspaceFolder?: string): Promise<string> {
    await this._awaitReady()
    const folder = parseWorkspaceUri(workspaceFolder)
    if (folder === undefined) {
      throw new Error(
        localize(
          'triggers.error.noLocalWorkspace',
          'Open a folder workspace first — triggers live inside a workspace',
        ),
      )
    }
    if (folder.scheme === REMOTE_SCHEME) return this._ensureRemoteConfigFile(folder)
    if (!this._isKnownWorkspace(folder)) throw unknownWorkspaceError()
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
    await this._catalog.attach(workspace)
    return URI.file(file).toString()
  }

  /**
   * Re-run discovery for one workspace without touching its config file. Used by
   * the manager so a `triggers.json` added after the workspace opened (pull /
   * branch switch) gets registered without going through `ensureConfigFile`.
   */
  async rescanWorkspace(workspaceFolder: string): Promise<void> {
    const folder = parseWorkspaceUri(workspaceFolder)
    if (folder === undefined) return
    await this._catalog.discover(folder)
  }

  private async _ensureRemoteConfigFile(folder: URI): Promise<string> {
    const authority = this._workspaceAuthority(folder)
    const fileService = this._fileService
    if (
      fileService === undefined ||
      authority === undefined ||
      !this._catalog.remoteIoAllowed(authority)
    ) {
      throw new Error(remoteNotConnectedMessage())
    }
    // Connection state is checked first: an unknown remote URI must still surface
    // the actionable "not connected" error instead of a generic ownership error.
    if (!this._isKnownWorkspace(folder)) throw unknownWorkspaceError()
    const dirUri = workspaceTriggersConfigDirUri(folder)
    const fileUri = workspaceTriggersConfigUri(folder)
    let created = false
    try {
      if (!(await this._catalog.withRemote(authority, () => fileService.exists(fileUri)))) {
        await this._catalog.withRemote(authority, () => fileService.createDirectory(dirUri))
        // Creating the directory and writing are two round trips; re-check so a
        // file created concurrently is never overwritten.
        if (!(await this._catalog.withRemote(authority, () => fileService.exists(fileUri)))) {
          await this._catalog.withRemote(authority, () =>
            fileService.writeFile(fileUri, TRIGGERS_CONFIG_EXAMPLE),
          )
          created = true
        }
      }
    } catch (err) {
      if (err instanceof RemoteIoUnavailableError) throw new Error(remoteNotConnectedMessage())
      this._logger.warn(`failed to create ${fileUri.toString()}: ${describeError(err)}`)
      throw new Error(
        localize(
          'triggers.error.configWriteFailed',
          'Could not create the trigger configuration file',
        ),
      )
    }
    if (created) this._logger.info(`created the example trigger config in ${folder.toString()}`)
    const workspace = folder.toString()
    await this._registry.register(workspace)
    await this._catalog.attach(workspace)
    return fileUri.toString()
  }

  /**
   * A window may only create a config for a workspace main already knows: one held
   * by an open window or one persisted in the registry. The forward IPC channel
   * cannot identify the caller, so an arbitrary URI must not be able to create
   * files / register background watchers.
   */
  private _isKnownWorkspace(folder: URI): boolean {
    const key = workspaceComparisonKey(folder.toString())
    if (this._windowHub.hasOpenWindowFor(key)) return true
    return this._registry.list().some((entry) => workspaceComparisonKey(entry) === key)
  }

  /** Stop watching a workspace and drop its queued events; running sessions finish. */
  async removeWorkspace(workspace: string): Promise<void> {
    await this._awaitReady()
    const removed = await this._registry.remove(workspace)
    const key = workspaceComparisonKey(workspace)
    this._catalog.detach(key)
    if (removed) {
      this._logger.info(`trigger workspace removed from the registry: ${workspace}`)
      this._audit('workspace-removed', 'success', `workspace=${workspace}`)
    }
    this._fireChange()
  }

  async reportRunEnd(end: TriggerRunEnd): Promise<void> {
    await this._awaitReady()
    // A run can report its end before `_startRun` finished awaiting the host (the
    // renderer answered startRun and ended immediately). Clear the durable pending
    // record here too, so a restart never replays an event whose run already ended.
    this._removePendingRecord(end.runId)
    const entry = this._ledger.takeRun(end.runId)
    if (entry === undefined) {
      this._logger.warn(`run ${end.runId}: end report ignored (not tracked)`)
      return
    }

    const now = this._clock.now()
    const failed = end.outcome === 'failed'
    const lastRunError = end.error === undefined ? undefined : truncateText(end.error, 500)
    const message = failed
      ? (lastRunError ?? localize('triggers.error.runFailed', 'The automated run failed'))
      : undefined
    const detail = [
      `trigger=${entry.triggerId}`,
      `workspace=${entry.workspace}`,
      `key=${entry.eventKey}`,
      `run=${end.runId}`,
      `session=${end.sessionId ?? '-'}`,
      `outcome=${end.outcome}`,
      `verdict=${end.verdict ?? '-'}`,
    ].join(' ')
    this._audit('run-end', failed ? 'failure' : 'success', detail)
    this._logger.info(
      `run ${end.runId}: ended trigger=${entry.triggerId} key=${entry.eventKey} outcome=${end.outcome}`,
    )

    const trigger = this._catalog.findTrigger(entry.triggerKey)
    const lastRunSummary = end.summary === undefined ? undefined : truncateText(end.summary, 200)
    try {
      await this._historyStore.append({
        runId: end.runId,
        triggerKey: entry.triggerKey,
        triggerId: entry.triggerId,
        // The definition may have been deleted / renamed while the run was active.
        triggerName: trigger?.name ?? entry.triggerId,
        workspace: entry.workspace,
        workspaceName: workspaceFolderName(entry.workspace),
        ...(end.sessionId === undefined ? {} : { sessionId: end.sessionId }),
        startedAt: entry.startedAt ?? entry.firedAt,
        endedAt: now,
        outcome: end.outcome,
        ...(end.verdict === undefined ? {} : { verdict: end.verdict }),
        ...(lastRunSummary === undefined ? {} : { summary: lastRunSummary }),
        ...(lastRunError === undefined ? {} : { error: lastRunError }),
        ...(end.costUsd === undefined ? {} : { costUsd: end.costUsd }),
        ...(end.durationMs === undefined ? {} : { durationMs: end.durationMs }),
      })
    } catch (err) {
      this._logger.warn(`run ${end.runId}: cannot append run history: ${describeError(err)}`)
    }

    // Persisted per-trigger synopsis; explicit undefined clears a field that the
    // previous run set (e.g. a verdict) — `_setTriggerState` deletes those keys.
    const lastRunPatch: RuntimeStatePatch = {
      lastRunId: end.runId,
      lastSessionId: end.sessionId,
      lastRunOutcome: end.outcome,
      lastRunVerdict: end.verdict,
      lastRunSummary,
      lastRunCostUsd: end.costUsd,
      lastRunDurationMs: end.durationMs,
    }

    if (end.outcome === 'completed') {
      this._setTriggerState(entry.triggerKey, {
        lastRunAt: now,
        consecutiveFailures: 0,
        backoffUntil: undefined,
        lastError: undefined,
        autoPaused: undefined,
        ...lastRunPatch,
      })
      this._fireChange()
      return
    }
    this._setTriggerState(entry.triggerKey, { lastRunAt: now, ...lastRunPatch })
    if (failed) {
      if (trigger !== undefined) this._recordFailure(trigger, message ?? '', now)
      else this._setTriggerState(entry.triggerKey, { lastError: message })
    }
    this._fireChange()
  }

  async listRuns(filter?: TriggerRunFilter): Promise<readonly TriggerRunHistoryEntry[]> {
    await this._awaitReady()
    return this._historyStore.recent(filter)
  }

  async readRunReport(runId: string, authority?: string): Promise<TriggerRunReportReadResult> {
    // Reading must never dial the remote host: only an already connected tunnel
    // can answer, otherwise the report tab / phone shows "unavailable".
    return authority === undefined
      ? this._localBackend.readReport(runId)
      : this._backendForAuthority(authority).readReport(runId)
  }

  async reportTriggerEvents(
    eventName: string,
    items: readonly unknown[],
    workspaceUri: string,
  ): Promise<void> {
    await this._awaitReady()
    const source = this._eventSources.get(eventName)
    if (source === undefined) {
      this._logger.warn(`trigger event report ignored: unknown source (${eventName})`)
      return
    }
    const folder = parseWorkspaceUri(workspaceUri)
    if (folder === undefined) {
      this._logger.warn(`trigger event report ignored: not a workspace uri (${workspaceUri})`)
      return
    }
    // Normalize once so malformed IPC items never enter the baseline and two items
    // with the same key cannot both enqueue in one batch. The persistent per-trigger
    // check below remains authoritative across reports and restarts.
    const unique = new Map<string, TriggerEventSourceItem>()
    for (const item of items) {
      const normalized = source.normalize(item)
      if (normalized !== undefined && !unique.has(normalized.key)) {
        unique.set(normalized.key, normalized)
      }
    }
    if (unique.size !== items.length) {
      this._logger.debug(
        `trigger event ${eventName}: normalized ${items.length} item(s) to ${unique.size}`,
      )
    }
    // A trigger belongs to the workspace whose window reported the events; another
    // open workspace must not consume them (or seed its baseline with them).
    const reporterKey = workspaceComparisonKey(folder.toString())
    const now = this._clock.now()
    for (const trigger of this._catalog.allTriggers()) {
      if (!trigger.enabled || trigger.source.type !== 'event' || trigger.source.event !== eventName)
        continue
      if (workspaceComparisonKey(trigger.workspace) !== reporterKey) continue
      // Offline remote workspaces must not seed a baseline from items that arrive
      // while nothing can run; the first report after reconnect seeds it.
      if (this._catalog.isWorkspaceOffline(trigger)) continue
      // Unconfirmed triggers must not consume the baseline: the first report after
      // confirmation has to seed it, otherwise every historical item fires.
      if (!this._isActivated(trigger)) continue
      const state = this._stateFor(trigger.key)
      if (!state.baselineDone) {
        let processed = state.processed
        for (const item of unique.values()) {
          processed = markStarted(processed, item.key, now)
        }
        this._setTriggerState(trigger.key, {
          processed: prune(processed, now, this._stateRepo.pruneOptions()),
          baselineDone: true,
        })
        this._logger.info(
          `trigger ${trigger.id}: ${eventName} baseline recorded items=${unique.size}`,
        )
        continue
      }
      for (const item of unique.values()) {
        if (isProcessed(this._stateFor(trigger.key).processed, item.key)) continue
        const event: TriggerEvent = {
          triggerId: trigger.id,
          key: item.key,
          payload: item.payload,
          firedAt: now,
        }
        await this._ledger.acceptEvent(trigger, event)
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
    this._windowHub.registerHost(windowId, host, workspaceFolder)
  }

  async markHostReady(workspaceFolder: string, windowId?: number): Promise<void> {
    this._windowHub.markHostReady(workspaceFolder, windowId)
  }

  failActiveRunsForWindow(windowId: number, reason: 'reloaded' | 'crashed'): void {
    this._windowHub.failActiveRunsForWindow(windowId, reason)
  }

  /**
   * A window opened (or switched to) `folder`. Best-effort: a folder with
   * `.universe-editor/triggers.json` is registered for scheduling. `windowId` is
   * optional for backward compatibility, but remote attach/detach needs it to know
   * when the last window for a workspace went away.
   */
  noteWindowWorkspace(folder: URI | null, windowId?: number): void {
    this._windowHub.noteWindowWorkspace(folder, windowId)
  }

  unregisterWindowHost(windowId: number): void {
    this._windowHub.unregisterHost(windowId)
  }

  setWindowProvider(provider: TriggerWindowProvider): void {
    this._windowHub.setProvider(provider)
  }

  override dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._scheduler.dispose()
    this._remoteBackends.clear()
    this._windowHub.dispose()
    this._ledger.dispose()
    this._catalog.dispose()
    void this._historyStore
      .flush()
      .catch((err) => this._logger.warn(`run history flush failed: ${describeError(err)}`))
    this._stateRepo.dispose()
    super.dispose()
  }

  // ---- initialization / gating --------------------------------------------

  private async _initialize(): Promise<void> {
    try {
      await this._stateRepo.load()
    } catch (err) {
      this._logger.warn(`trigger state load failed; starting empty: ${describeError(err)}`)
    }
    await this._reloadMaxConcurrentRuns()
    let registered: readonly string[] = []
    try {
      registered = await this._registry.load()
    } catch (err) {
      this._logger.warn(`trigger workspace registry load failed: ${describeError(err)}`)
    }
    // Machine-local state outlives configurations; drop keys whose workspace left
    // the registry plus pending payloads nothing references.
    await this._stateRepo.startupSweep(
      new Set(registered.map((workspace) => workspaceComparisonKey(workspace))),
    )
    for (const workspace of registered) {
      // Remote workspaces attach only while one of their windows is open; a
      // restored registry entry must not start a background watcher (or SSH).
      const uri = parseWorkspaceUri(workspace)
      if (uri !== undefined && isRemoteWorkspaceUri(uri)) {
        this._logger.info(`registered remote trigger workspace ${workspace} waits for a window`)
        continue
      }
      await this._catalog.attach(workspace)
    }
    this._scheduler.armStartupGate()
  }

  private async _reloadMaxConcurrentRuns(): Promise<void> {
    let limit: number = TRIGGER_DEFAULTS.maxConcurrentRuns
    try {
      limit = await this._readMaxConcurrentRuns()
    } catch (err) {
      this._logger.warn(`cannot read the maxConcurrentRuns setting: ${describeError(err)}`)
    }
    this._ledger.setGlobalLimit(limit)
    this._logger.info(`trigger concurrency limit: ${limit}`)
  }

  // ---- workspace discovery / config stores --------------------------------

  /** Register a folder and start watching its trigger file (when it exists). */
  /** Local backend, or the remote backend of the trigger's authority. */
  private _backendFor(trigger: RoutedTrigger): TriggerExecutionBackend {
    return this._backendForWorkspace(trigger.workspaceUri)
  }

  private _backendForWorkspace(workspaceUri: URI): TriggerExecutionBackend {
    const authority = workspaceAuthorityOf(workspaceUri)
    return authority === undefined ? this._localBackend : this._backendForAuthority(authority)
  }

  private _backendForAuthority(authority: string): RemoteExecutionBackend {
    const normalized = normalizeRemoteAuthority(authority)
    let backend = this._remoteBackends.get(normalized)
    if (backend === undefined) {
      const connections = this._remoteConnections
      if (connections === undefined) {
        throw new Error('triggers: the remote connection service is not available')
      }
      backend = new RemoteExecutionBackend({
        authority: normalized,
        logger: this._logger,
        clock: this._clock,
        connections,
        clientId: () => this._resolveClientId(),
        maxRunDirectories: this._maxRunDirectories,
        pollGraceMs: this._remotePollGraceMs,
        protectedRunIdsForAuthority: () => this._protectedRunIdsForAuthority(normalized),
      })
      this._remoteBackends.set(normalized, backend)
    }
    return backend
  }

  private _resolveClientId(): Promise<string> {
    this._clientIdPromise ??= this._clientId()
    return this._clientIdPromise
  }

  private _workspaceAuthority(workspaceUri: URI): string | undefined {
    return workspaceAuthorityOf(workspaceUri)
  }

  /** Run ids a per-client remote prune must never delete, for one authority. */
  private _protectedRunIdsForAuthority(authority: string): readonly string[] {
    return this._ledger.protectedRunIdsForAuthority(authority)
  }

  /**
   * Authority of a trigger key's workspace. Derived from the key itself — its
   * workspace part is already the normalized URI — so ids stay protected even
   * after the workspace entry was detached while its records remain.
   */
  private _authorityOfKey(triggerKey: string): string | undefined {
    const parsed = parseTriggerKey(triggerKey)
    if (parsed === undefined) return undefined
    const workspaceUri = parseWorkspaceUri(parsed.workspaceKey)
    return workspaceUri === undefined ? undefined : this._workspaceAuthority(workspaceUri)
  }

  // ---- scheduling ---------------------------------------------------------

  /**
   * `ignoreBackoff` is for callers that must still advance their own cadence while
   * the trigger is cooling down (schedule skip accounting, poll re-arming).
   * `manual` is a user-initiated run: like `runNow` it neither requires `enabled`
   * nor honours the backoff or the per-trigger pause, but the global pause and the
   * activation confirmation still apply.
   */
  private _isRunnable(
    trigger: RoutedTrigger,
    options: { ignoreBackoff?: boolean; manual?: boolean } = {},
  ): boolean {
    // A remote workspace without a live connection is "missed time": nothing is
    // consumed and no cadence advances until it is back.
    if (this._catalog.isWorkspaceOffline(trigger)) return false
    // Remote work is never headless: a workspace whose window is gone stays a
    // snapshot until a window holds it again.
    if (this._catalog.remoteWindowMissing(trigger)) return false
    if ((!trigger.enabled && !options.manual) || this._stateRepo.state.pausedAll) return false
    const state = this._stateFor(trigger.key)
    if (state.paused && options.manual !== true) return false
    if (!options.ignoreBackoff && !options.manual) {
      const backoffUntil = state.backoffUntil
      if (backoffUntil !== undefined && this._clock.now() < backoffUntil) return false
    }
    return !this._needsConfirmation(trigger)
  }

  /** Unknown checker (tests / embedding) keeps the pre-existing behavior. */
  private async _trustedForPoll(workspaceUri: string): Promise<boolean> {
    const check = this._isWorkspaceTrusted
    if (check === undefined) return true
    try {
      return await check(workspaceUri)
    } catch (err) {
      this._logger.warn(`workspace trust check failed for ${workspaceUri}: ${describeError(err)}`)
      return false
    }
  }

  // ---- persistence --------------------------------------------------------

  private _stateFor(triggerId: string): TriggerRuntimeState {
    return this._stateRepo.stateFor(triggerId)
  }

  private _setTriggerState(triggerId: string, patch: RuntimeStatePatch): void {
    this._stateRepo.setTriggerState(triggerId, patch)
  }

  private _markProcessed(triggerId: string, key: string, status: 'queued' | 'started'): void {
    this._stateRepo.markProcessed(triggerId, key, status)
  }

  private _forgetKey(triggerId: string, key: string, runId?: string): void {
    this._stateRepo.forgetKey(triggerId, key, runId)
  }

  private _removePendingRecord(runId: string): void {
    this._stateRepo.removePending(runId)
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
      ...(autoPause ? { paused: true, autoPaused: true } : {}),
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
            '"{name}" failed {count} times in a row and was paused. Run "Triggers: Open Manager" to review it and resume it.',
            { name: trigger.name, count: consecutiveFailures },
          ),
        )
      } catch (err) {
        this._logger.warn(`trigger ${trigger.id}: notification failed: ${describeError(err)}`)
      }
      this._scheduler.pruneTiming()
      this._scheduler.rescheduleWake()
    }
  }

  // ---- summaries ----------------------------------------------------------

  private _isActivated(trigger: RoutedTrigger): boolean {
    return this._stateFor(trigger.key).activationConfirmed === trigger.fingerprint
  }

  private _needsConfirmation(trigger: RoutedTrigger): boolean {
    return !this._isActivated(trigger)
  }

  private _summaries(): readonly TriggerSummary[] {
    const summaries: TriggerSummary[] = []
    for (const trigger of this._catalog.allTriggers()) {
      const state = this._stateFor(trigger.key)
      const stats = this._ledger.stats(trigger.key)
      const fingerprint = trigger.fingerprint
      const activationConfirmed = state.activationConfirmed === fingerprint
      const paused = state.paused || this._stateRepo.state.pausedAll
      const needsConfirmation = !activationConfirmed
      const session: TriggerSessionSurface = {
        ...(trigger.session.agent === undefined ? {} : { agent: trigger.session.agent }),
        ...(trigger.session.mode === undefined ? {} : { mode: trigger.session.mode }),
        ...(trigger.session.skill === undefined ? {} : { skill: trigger.session.skill }),
        ...(trigger.session.mcpServers === undefined
          ? {}
          : { mcpServers: trigger.session.mcpServers }),
      }
      const status: TriggerStatus = paused
        ? 'paused'
        : needsConfirmation
          ? 'needs-confirmation'
          : stats.running > 0
            ? 'running'
            : !trigger.enabled
              ? 'disabled'
              : 'idle'
      const nextRunAt = this._scheduler.nextRunAt(trigger, paused)
      summaries.push({
        key: trigger.key,
        id: trigger.id,
        name: trigger.name,
        fingerprint,
        workspace: trigger.workspace,
        workspaceName: workspaceFolderName(trigger.workspace),
        sourceType: trigger.source.type,
        status,
        offline: this._catalog.isWorkspaceOffline(trigger),
        enabled: trigger.enabled,
        paused,
        pausedAll: this._stateRepo.state.pausedAll,
        autoPaused: state.autoPaused === true,
        source: trigger.source,
        activationConfirmed,
        elevatedMode: isElevatedModeId(trigger.session.mode),
        session,
        running: stats.running,
        queued: stats.queued,
        consecutiveFailures: state.consecutiveFailures,
        ...(state.lastRunAt === undefined ? {} : { lastRunAt: state.lastRunAt }),
        ...(nextRunAt === undefined ? {} : { nextRunAt }),
        ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
        ...(state.lastRunId === undefined ? {} : { lastRunId: state.lastRunId }),
        ...(state.lastSessionId === undefined ? {} : { lastSessionId: state.lastSessionId }),
        ...(state.lastRunOutcome === undefined ? {} : { lastRunOutcome: state.lastRunOutcome }),
        ...(state.lastRunVerdict === undefined ? {} : { lastRunVerdict: state.lastRunVerdict }),
        ...(state.lastRunSummary === undefined ? {} : { lastRunSummary: state.lastRunSummary }),
        ...(state.lastRunCostUsd === undefined ? {} : { lastRunCostUsd: state.lastRunCostUsd }),
        ...(state.lastRunDurationMs === undefined
          ? {}
          : { lastRunDurationMs: state.lastRunDurationMs }),
      })
    }
    for (const entry of this._catalog.entries()) {
      for (const invalid of entry.config.invalid) {
        summaries.push({
          key: triggerKeyFor(entry.workspace, invalid.id),
          id: invalid.id,
          name: invalid.id,
          fingerprint: '',
          workspace: entry.workspace,
          workspaceName: workspaceFolderName(entry.workspace),
          sourceType: 'unknown',
          status: 'invalid',
          offline: entry.offline,
          enabled: false,
          paused: false,
          pausedAll: this._stateRepo.state.pausedAll,
          autoPaused: false,
          activationConfirmed: false,
          elevatedMode: false,
          running: 0,
          queued: 0,
          consecutiveFailures: 0,
          errors: invalid.errors,
          issues: invalid.issues,
        })
      }
    }
    return summaries
  }

  /**
   * Coalesced change notification: one synchronous burst (config apply, queue
   * drain, run end) yields a single event, and an unchanged summary snapshot is
   * never emitted. The signature is only computed on the flush, after coalescing.
   */
  private _fireChange(): void {
    if (this._disposed || this._changeScheduled) return
    this._changeScheduled = true
    queueMicrotask(() => {
      this._changeScheduled = false
      if (this._disposed) return
      const summaries = this._summaries()
      const signature = JSON.stringify(summaries)
      if (signature === this._lastChangeSignature) return
      this._lastChangeSignature = signature
      this._onDidChangeTriggers.fire(summaries)
    })
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

function truncateText(text: string, max: number): string {
  return text.slice(0, max)
}

function unknownWorkspaceError(): Error {
  return new Error(
    localize(
      'triggers.error.unknownWorkspace',
      'That workspace is not open in any window and is not registered. Open the folder in a window first.',
    ),
  )
}

function remoteNotConnectedMessage(): string {
  return localize(
    'triggers.error.remoteNotConnected',
    'The remote host for this trigger is not connected. Reconnect and try again.',
  )
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
  if (isRemoteWorkspaceUri(uri)) {
    return name.length > 0 ? `${name} (${uri.authority})` : `${uri.authority}`
  }
  return name.length > 0 ? name : workspace
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
