/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Owns the workspace catalog: which folders are registered, their config stores and
 *  hot-reload subscriptions, the RoutedTrigger view (composite key + fingerprint), and
 *  the remote-ssh lifecycle (attach only while connected + a window holds the folder,
 *  offline snapshots, reconnect reloads with clock-injected backoff).
 *  TriggerMainService consumes it through `allTriggers` / `findTrigger`; the scheduler,
 *  run ledger and window hub are driven from here so attach/detach stays one path.
 *--------------------------------------------------------------------------------------------*/

import { stat } from 'node:fs/promises'
import {
  DisposableStore,
  localize,
  normalizeRemoteAuthority,
  URI,
  type IFileService,
  type ILogger,
} from '@universe-editor/platform'
import type { TriggerSourceConfig, TriggersConfig } from '../../../shared/triggers/types.js'
import { nextBackoffMs } from '../../../shared/triggers/backoff.js'
import { forget, prune } from '../../../shared/triggers/dedupe.js'
import { parseWorkspaceUri } from '../../../shared/triggers/configParse.js'
import { JsonConfigFileStore, type JsonConfigFileState } from '../jsonConfig/jsonConfigFileStore.js'
import type {
  IRemoteConnectionService,
  IRemoteConnectionStateChange,
} from '../remote/remoteConnectionMainService.js'
import {
  createEmptyTriggersConfig,
  readTriggersConfigFile,
  serializeTriggersConfig,
  workspaceTriggersConfigLocation,
  workspaceTriggersConfigPath,
  workspaceTriggersConfigUri,
} from './triggersConfigFile.js'
import {
  isRemoteWorkspaceUri,
  type RemoteTriggerConfigStoreOptions,
  type TriggerConfigStore,
} from './triggerConfigStore.js'
import { TriggerWorkspaceRegistry } from './triggerWorkspaceRegistry.js'
import { triggerFingerprint } from './triggerFingerprint.js'
import {
  canonicalTriggerKey,
  parseTriggerKey,
  triggerKeyBelongsToWorkspace,
  triggerKeyFor,
  workspaceComparisonKey,
} from './triggerIdentity.js'
import type { TriggerStateRepository } from './triggerStateRepository.js'
import type { TriggerClock, TriggerTimerHandle } from './triggerClock.js'
import { RemoteIoUnavailableError } from './triggerErrors.js'
import { workspaceAuthorityOf, type TriggerExecutionBackend } from './triggerExecutionBackend.js'
import type { RoutedTrigger } from './triggerTypes.js'
import type { TriggerScheduler } from './triggerScheduler.js'
import type { TriggerRunLedger } from './triggerRunLedger.js'
import type { TriggerWindowHub } from './triggerWindowHub.js'

/** Retry cap for a remote config read that failed for a non-"missing" reason. */
const REMOTE_RELOAD_MAX_DELAY_MS = 5 * 60_000

/** Filesystem-visible prefixes owned by a single trigger source. */
const PREFETCHED_KEY_PREFIXES = ['poll:', 'swarm:'] as const

export interface WorkspaceEntry {
  /** Workspace URI string; the identity shared with the renderer and state keys. */
  readonly workspace: string
  readonly workspaceUri: URI
  readonly key: string
  /** Set for remote-ssh workspaces; undefined for local folders. */
  readonly authority: string | undefined
  readonly store: TriggerConfigStore
  /** Owns the store and its subscriptions; detach disposes exactly this entry. */
  readonly disposables: DisposableStore
  config: TriggersConfig
  /**
   * Remote workspace whose connection left `connected`. The config snapshot stays
   * listable (so the user still sees the definitions) but the store and watcher are
   * gone and nothing is scheduled until the connection returns.
   */
  offline: boolean
}

export interface TriggerCatalogOptions {
  readonly logger: ILogger
  readonly clock: TriggerClock
  readonly registry: TriggerWorkspaceRegistry
  readonly stateRepo: TriggerStateRepository
  readonly scheduler: TriggerScheduler
  readonly ledger: TriggerRunLedger
  readonly windowHub: TriggerWindowHub
  readonly fileService: IFileService | undefined
  readonly remoteConnections: IRemoteConnectionService | undefined
  readonly createRemoteConfigStore: (options: RemoteTriggerConfigStoreOptions) => TriggerConfigStore
  readonly fireChange: () => void
  readonly awaitReady: () => Promise<void>
  readonly isDisposed: () => boolean
  readonly isGateOpen: () => boolean
  readonly replayPendingRuns: () => void
  readonly backendForWorkspace: (workspaceUri: URI) => TriggerExecutionBackend
}

export class TriggerCatalog {
  private readonly _logger: ILogger
  private readonly _clock: TriggerClock
  private readonly _registry: TriggerWorkspaceRegistry
  private readonly _stateRepo: TriggerStateRepository
  private readonly _scheduler: TriggerScheduler
  private readonly _ledger: TriggerRunLedger
  private readonly _windowHub: TriggerWindowHub
  private readonly _fileService: IFileService | undefined
  private readonly _remoteConnections: IRemoteConnectionService | undefined
  private readonly _createRemoteConfigStore: (
    options: RemoteTriggerConfigStoreOptions,
  ) => TriggerConfigStore
  private readonly _fireChange: () => void
  private readonly _awaitReady: () => Promise<void>
  private readonly _isDisposed: () => boolean
  private readonly _isGateOpen: () => boolean
  private readonly _replayPendingRuns: () => void
  private readonly _backendForWorkspace: (workspaceUri: URI) => TriggerExecutionBackend

  private readonly _workspaces = new Map<string, WorkspaceEntry>()
  private readonly _attaching = new Map<string, Promise<void>>()
  private readonly _reloading = new Map<string, Promise<void>>()
  /** Invalidates an in-flight attach when its workspace is detached / removed. */
  private readonly _workspaceEpochs = new Map<string, number>()
  private readonly _remoteReloadTimers = new Map<string, TriggerTimerHandle>()
  private readonly _remoteReloadAttempts = new Map<string, number>()

  constructor(options: TriggerCatalogOptions) {
    this._logger = options.logger
    this._clock = options.clock
    this._registry = options.registry
    this._stateRepo = options.stateRepo
    this._scheduler = options.scheduler
    this._ledger = options.ledger
    this._windowHub = options.windowHub
    this._fileService = options.fileService
    this._remoteConnections = options.remoteConnections
    this._createRemoteConfigStore = options.createRemoteConfigStore
    this._fireChange = options.fireChange
    this._awaitReady = options.awaitReady
    this._isDisposed = options.isDisposed
    this._isGateOpen = options.isGateOpen
    this._replayPendingRuns = options.replayPendingRuns
    this._backendForWorkspace = options.backendForWorkspace
  }

  /** Register a folder and start watching its trigger file (when it exists). */
  async discover(folder: URI | null): Promise<void> {
    if (folder === null) return
    const uri = parseWorkspaceUri(folder.toString())
    if (uri === undefined) {
      this._logger.info(`trigger workspace discovery skipped (unsupported folder): ${folder}`)
      return
    }
    if (isRemoteWorkspaceUri(uri) && !this.remoteIoAllowed(uri.authority)) {
      // Not connected (yet): deferred discovery runs from onDidChangeState.
      this._logger.info(
        `trigger workspace discovery deferred (remote '${uri.authority}' is not connected): ${uri}`,
      )
      return
    }
    // Window hosts register before the registry/state load completes; waiting keeps
    // discovery from being overwritten by the in-flight `load()` snapshot.
    await this._awaitReady()
    await this._registerDiscoveredWorkspace(uri.toString())
  }

  attach(workspace: string, previous?: WorkspaceEntry): Promise<void> {
    const uri = parseWorkspaceUri(workspace)
    if (uri === undefined) return Promise.resolve()
    const key = workspaceComparisonKey(workspace)
    const pending = this._attaching.get(key)
    if (pending !== undefined) return pending
    const epoch = this._workspaceEpochs.get(key) ?? 0
    const task = this._doAttachWorkspace(workspace, uri, key, epoch, previous).finally(() =>
      this._attaching.delete(key),
    )
    this._attaching.set(key, task)
    return task
  }

  /**
   * Stop scheduling a workspace; its queued events are dropped, running runs finish.
   * `keepPending` is for a remote workspace whose last window closed: accepted
   * events stay durable so reopening the window (while connected) replays them.
   */
  detach(key: string, options: { keepPending?: boolean } = {}): void {
    // Invalidate any attach that is still loading this workspace's config.
    this._workspaceEpochs.set(key, (this._workspaceEpochs.get(key) ?? 0) + 1)
    const entry = this._workspaces.get(key)
    if (entry === undefined) return
    const keepPending = options.keepPending === true
    const triggerKeys = new Set<string>()
    for (const trigger of entry.config.triggers) {
      triggerKeys.add(triggerKeyFor(entry.workspace, trigger.id))
    }
    for (const invalid of entry.config.invalid) {
      triggerKeys.add(triggerKeyFor(entry.workspace, invalid.id))
    }
    for (const record of this._stateRepo.pendingRecords()) {
      if (triggerKeyBelongsToWorkspace(record.triggerKey, key)) triggerKeys.add(record.triggerKey)
    }
    for (const pendingKey of this._ledger.queuedTriggerKeys((triggerKey) =>
      triggerKeyBelongsToWorkspace(triggerKey, key),
    )) {
      triggerKeys.add(pendingKey)
    }
    this._backendForWorkspace(entry.workspaceUri).detachWorkspace(entry)
    this._workspaces.delete(key)
    entry.disposables.dispose()
    for (const triggerKey of triggerKeys) {
      this._ledger.clearTriggerQueue(triggerKey)
      this._scheduler.forgetTrigger(triggerKey)
    }
    this._ledger.dropQueuedForWorkspace(
      (triggerKey) => triggerKeyBelongsToWorkspace(triggerKey, key),
      keepPending,
    )
    if (!keepPending) this._stateRepo.dropPendingForWorkspace(key)
    this._scheduler.pruneTiming()
    this._scheduler.rescheduleWake()
  }

  /** Remote definitions live only while one of their windows is open. */
  detachRemoteWorkspacesWithoutWindow(): void {
    for (const [key, entry] of [...this._workspaces]) {
      if (entry.authority === undefined || this._windowHub.hasOpenWindowFor(key)) continue
      this._logger.info(`remote trigger workspace detached (no window open): ${entry.workspace}`)
      this.detach(key, { keepPending: true })
    }
    this._fireChange()
  }

  /** The hard gate for every remote read / watcher start (never triggers bring-up). */
  remoteIoAllowed(authority: string): boolean {
    if (this._fileService === undefined || this._remoteConnections === undefined) return false
    return this._remoteConnected(authority)
  }

  /**
   * Run one remote I/O call. The gate is synchronous and re-checked immediately
   * before the call, so a `connected` -> `reconnecting` transition during an
   * earlier await aborts instead of dialling the host.
   */
  async withRemote<T>(authority: string, call: () => Promise<T>): Promise<T> {
    if (!this.remoteIoAllowed(authority)) throw new RemoteIoUnavailableError(authority)
    return call()
  }

  /**
   * `true` / `false` are definitive; `undefined` means the check itself failed
   * (transport / IO), which must not be mistaken for "the file was deleted".
   */
  async remoteConfigExists(workspaceUri: URI): Promise<boolean | undefined> {
    const fileService = this._fileService
    if (fileService === undefined) return undefined
    try {
      return await fileService.exists(workspaceTriggersConfigUri(workspaceUri))
    } catch (err) {
      this._logger.debug(
        `cannot stat the remote trigger config of ${workspaceUri}: ${describeError(err)}`,
      )
      return undefined
    }
  }

  onConnectionStateChange(change: IRemoteConnectionStateChange): void {
    if (this._isDisposed()) return
    const authority = normalizeRemoteAuthority(change.authority)
    if (change.state === 'connected') {
      const candidates = new Map<string, string>()
      for (const workspace of this._windowHub.remoteWorkspacesForAuthority(authority)) {
        candidates.set(workspaceComparisonKey(workspace), workspace)
      }
      // An offline entry (e.g. opened via `openConfig`) reloads even if the
      // window mapping was not recorded for it.
      for (const [key, entry] of this._workspaces) {
        if (entry.authority === authority && entry.offline) candidates.set(key, entry.workspace)
      }
      for (const workspace of candidates.values()) {
        const entry = this._workspaces.get(workspaceComparisonKey(workspace))
        if (entry !== undefined && !entry.offline) continue
        void this._reloadRemoteWorkspace(workspace)
      }
      return
    }
    // Leaving `connected` (reconnecting / failed / idle): stop remote I/O now.
    // The definitions stay listable as an offline snapshot.
    for (const entry of [...this._workspaces.values()]) {
      if (entry.authority !== authority || entry.offline) continue
      this._setWorkspaceOffline(entry)
    }
  }

  workspaceEntry(key: string): WorkspaceEntry | undefined {
    return this._workspaces.get(key)
  }

  entries(): Iterable<WorkspaceEntry> {
    return this._workspaces.values()
  }

  isWorkspaceOffline(trigger: RoutedTrigger): boolean {
    const parsed = parseTriggerKey(trigger.key)
    return parsed !== undefined && this._workspaces.get(parsed.workspaceKey)?.offline === true
  }

  /** Remote definitions never run (or schedule) without a window holding them. */
  remoteWindowMissing(trigger: RoutedTrigger): boolean {
    return (
      isRemoteWorkspaceUri(trigger.workspaceUri) &&
      !this._windowHub.hasOpenWindowFor(workspaceComparisonKey(trigger.workspace))
    )
  }

  allTriggers(): RoutedTrigger[] {
    const result: RoutedTrigger[] = []
    for (const entry of this._workspaces.values()) result.push(...this._routedTriggers(entry))
    return result
  }

  findTrigger(triggerKey: string): RoutedTrigger | undefined {
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

  requireTrigger(triggerKey: string): RoutedTrigger {
    const trigger = this.findTrigger(triggerKey)
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
          errors: invalid.issues.map((issue) => issue.message).join('; '),
        }),
      )
    }
    throw new Error(
      localize('triggers.error.triggerNotFound', 'Trigger not found: {id}', {
        id: canonical?.triggerId ?? triggerKey,
      }),
    )
  }

  dispose(): void {
    for (const timer of this._remoteReloadTimers.values()) this._clock.clearTimeout(timer)
    this._remoteReloadTimers.clear()
    this._remoteReloadAttempts.clear()
    for (const entry of this._workspaces.values()) entry.disposables.dispose()
    this._workspaces.clear()
  }

  private _remoteConnected(authority: string): boolean {
    return this._remoteConnections?.getState(authority) === 'connected'
  }

  private async _registerDiscoveredWorkspace(
    workspace: string,
    previous?: WorkspaceEntry,
  ): Promise<void> {
    const uri = parseWorkspaceUri(workspace)
    if (uri === undefined) return
    try {
      if (isRemoteWorkspaceUri(uri)) {
        if (!this.remoteIoAllowed(uri.authority)) {
          this._logger.info(
            `trigger workspace discovery skipped (remote '${uri.authority}' is not connected): ${workspace}`,
          )
          return
        }
        const exists = await this.remoteConfigExists(uri)
        if (exists === false) {
          // A missing file is definitive: drop a stale offline snapshot instead
          // of keeping definitions that no longer exist.
          this._discardWorkspaceWithoutConfig(workspace)
          return
        }
        if (exists === undefined) {
          this._logger.warn(
            `trigger workspace discovery could not verify ${workspace}; keeping its snapshot`,
          )
          this._scheduleRemoteReloadRetry(workspace)
          return
        }
      } else {
        const file = workspaceTriggersConfigPath(uri.fsPath)
        if (!(await fileExists(file))) return
      }
      await this._registry.register(workspace)
      await this.attach(workspace, previous)
      const key = workspaceComparisonKey(workspace)
      // A remote workspace only becomes startable again once it is attached,
      // connected and held by a window: then deferred events can replay.
      if (
        isRemoteWorkspaceUri(uri) &&
        this._workspaces.has(key) &&
        this._windowHub.hasOpenWindowFor(key)
      ) {
        this._replayDeferredEvents(workspace)
      }
    } catch (err) {
      this._logger.warn(
        `trigger workspace discovery failed for ${workspace}: ${describeError(err)}`,
      )
      if (isRemoteWorkspaceUri(uri)) this._scheduleRemoteReloadRetry(workspace)
    }
  }

  private async _doAttachWorkspace(
    workspace: string,
    workspaceUri: URI,
    key: string,
    epoch: number,
    requestedPrevious?: WorkspaceEntry,
  ): Promise<void> {
    if (this._isDisposed()) return
    // A rescan passes no `previous`, but an existing *offline* entry must still
    // be re-read: that is how reconnect / rescan revives it. An online entry is
    // already attached, so a repeated rescan stays a no-op.
    const previous = requestedPrevious ?? this._workspaces.get(key)
    if (requestedPrevious === undefined && previous !== undefined && !previous.offline) return
    const authority = workspaceAuthorityOf(workspaceUri)
    let store: TriggerConfigStore
    if (authority === undefined) {
      const file = workspaceTriggersConfigPath(workspaceUri.fsPath)
      if (!(await fileExists(file))) {
        this._logger.warn(
          `trigger workspace skipped (no ${file}); it stays registered until removed`,
        )
        return
      }
      store = new JsonConfigFileStore<TriggersConfig>({
        file,
        logger: this._logger,
        directoryLabel: 'workspace trigger config',
        createDefault: createEmptyTriggersConfig,
        read: readTriggersConfigFile,
        serialize: serializeTriggersConfig,
      })
    } else {
      // Hard gate: every remote read / watcher start below requires a live tunnel.
      if (!this.remoteIoAllowed(authority)) {
        this._logger.info(
          `trigger workspace skipped (remote '${authority}' is not connected): ${workspace}`,
        )
        return
      }
      const exists = await this.remoteConfigExists(workspaceUri)
      if (exists === false) {
        this._discardWorkspaceWithoutConfig(workspace)
        return
      }
      if (exists === undefined) {
        this._scheduleRemoteReloadRetry(workspace)
        return
      }
      if (this._isDisposed() || !this.remoteIoAllowed(authority)) return
      const fileService = this._fileService
      const connections = this._remoteConnections
      if (fileService === undefined || connections === undefined) return
      store = this._createRemoteConfigStore({
        workspaceUri,
        logger: this._logger,
        fileService,
        connections,
        clock: this._clock,
      })
    }
    if (this._isDisposed()) {
      store.dispose()
      return
    }
    const entry: WorkspaceEntry = {
      workspace,
      workspaceUri,
      key,
      authority,
      store,
      disposables: new DisposableStore(),
      config: createEmptyTriggersConfig(),
      offline: false,
    }
    entry.disposables.add(store)
    entry.disposables.add(
      store.onDidChangeExternal((state) => {
        if (this._workspaces.get(key) !== entry) return
        this._applyWorkspaceConfig(entry, state)
      }),
    )
    const state = await store.load()
    if (this._isDisposed() || (this._workspaceEpochs.get(key) ?? 0) !== epoch) {
      entry.disposables.dispose()
      return
    }
    if (state.readFailed === true) {
      // Not "the file disappeared": keep the caller's snapshot (already visible
      // as offline) and retry with backoff instead of wiping the definitions.
      entry.disposables.dispose()
      this._logger.warn(
        `remote trigger config read failed for ${workspace}; keeping the last snapshot`,
      )
      if (
        previous !== undefined &&
        this._workspaces.get(key) === previous &&
        authority !== undefined
      ) {
        this._setWorkspaceOffline(previous)
      }
      this._scheduleRemoteReloadRetry(workspace)
      return
    }
    if (state.missing === true) {
      entry.disposables.dispose()
      this._discardWorkspaceWithoutConfig(workspace)
      return
    }
    if (
      authority !== undefined &&
      (!this.remoteIoAllowed(authority) || !this._windowHub.hasOpenWindowFor(key))
    ) {
      // The window closed or the link dropped while the config was loading: drop
      // the fresh entry rather than keep one that polls without a window. A
      // failed reload leaves the caller's previous offline snapshot in place.
      entry.disposables.dispose()
      if (
        previous !== undefined &&
        this._workspaces.get(key) === previous &&
        !this.remoteIoAllowed(authority)
      ) {
        this._setWorkspaceOffline(previous)
      }
      return
    }
    // Swap in the freshly loaded entry only now: a failed reload keeps the old
    // snapshot (and its already-visible definitions) instead of losing it.
    this._workspaces.set(key, entry)
    this._backendForWorkspace(entry.workspaceUri).attachWorkspace(entry)
    this._clearRemoteReloadRetry(key)
    previous?.disposables.dispose()
    this._applyWorkspaceConfig(entry, state)
    this._logger.info(`trigger workspace attached: ${workspace}`)
  }

  /**
   * Detach the remote store/watcher but keep the last config snapshot so the
   * trigger list still shows the definitions with an "offline" marker.
   */
  private _setWorkspaceOffline(entry: WorkspaceEntry): void {
    if (entry.offline) return
    entry.offline = true
    entry.disposables.dispose()
    // No remote I/O while offline: a retry timer waiting now is meaningless; the
    // reconnect event starts a fresh reload attempt.
    this._clearRemoteReloadRetry(entry.key)
    this._scheduler.forgetWorkspace(entry.key)
    this._logger.info(`remote trigger workspace offline: ${entry.workspace}`)
    this._scheduler.pruneTiming()
    this._scheduler.rescheduleWake()
    this._fireChange()
  }

  /**
   * Re-run the pending-event pass now that a remote workspace is attached,
   * connected and held by a window. Events deferred earlier (accepted, then
   * disconnected / window gone) are re-enqueued by the normal replay path.
   */
  private _replayDeferredEvents(workspace: string): void {
    if (!this._isGateOpen() || this._isDisposed()) return
    this._logger.info(`replaying pending trigger events for ${workspace}`)
    this._replayPendingRuns()
  }

  /** Re-read a remote workspace after reconnecting (also revives the offline entry). */
  private _reloadRemoteWorkspace(workspace: string): Promise<void> {
    const key = workspaceComparisonKey(workspace)
    this._cancelRemoteReloadTimer(key)
    const pending = this._reloading.get(key)
    if (pending !== undefined) return pending
    const task = this._doReloadRemoteWorkspace(workspace, key).finally(() =>
      this._reloading.delete(key),
    )
    this._reloading.set(key, task)
    return task
  }

  /**
   * A remote read that failed for a non-"missing" reason keeps the last snapshot
   * and is retried with the same backoff curve as run failures. The timer is
   * clock-injected so tests run on the fake clock; it never fires while the
   * authority is disconnected (the reconnect event reloads instead).
   */
  private _scheduleRemoteReloadRetry(workspace: string): void {
    const uri = parseWorkspaceUri(workspace)
    if (uri === undefined || !isRemoteWorkspaceUri(uri) || this._isDisposed()) return
    if (!this.remoteIoAllowed(uri.authority)) return
    const key = workspaceComparisonKey(workspace)
    if (this._remoteReloadTimers.has(key)) return
    const attempt = (this._remoteReloadAttempts.get(key) ?? 0) + 1
    this._remoteReloadAttempts.set(key, attempt)
    const delay = Math.min(nextBackoffMs(attempt), REMOTE_RELOAD_MAX_DELAY_MS)
    this._remoteReloadTimers.set(
      key,
      this._clock.setTimeout(() => {
        this._remoteReloadTimers.delete(key)
        if (this._isDisposed() || !this.remoteIoAllowed(uri.authority)) return
        void this._reloadRemoteWorkspace(workspace)
      }, delay),
    )
    this._logger.warn(`remote trigger workspace ${workspace}: read failed; retrying in ${delay}ms`)
  }

  private _cancelRemoteReloadTimer(key: string): void {
    const timer = this._remoteReloadTimers.get(key)
    if (timer === undefined) return
    this._clock.clearTimeout(timer)
    this._remoteReloadTimers.delete(key)
  }

  private _clearRemoteReloadRetry(key: string): void {
    this._cancelRemoteReloadTimer(key)
    this._remoteReloadAttempts.delete(key)
  }

  /** Definitive absence: the file is gone, so the snapshot (and its pending) goes too. */
  private _discardWorkspaceWithoutConfig(workspace: string): void {
    const key = workspaceComparisonKey(workspace)
    this._clearRemoteReloadRetry(key)
    if (!this._workspaces.has(key)) return
    this._logger.info(`remote trigger workspace detached (config file is gone): ${workspace}`)
    this.detach(key)
  }

  private async _doReloadRemoteWorkspace(workspace: string, key: string): Promise<void> {
    await this._awaitReady()
    if (this._isDisposed()) return
    // Keep the offline snapshot in place until the fresh entry has loaded: a
    // reconnect flap that fails again must not erase the visible definitions.
    const previous = this._workspaces.get(key)
    await this._registerDiscoveredWorkspace(workspace, previous)
    this._fireChange()
  }

  private _applyWorkspaceConfig(
    entry: WorkspaceEntry,
    state: JsonConfigFileState<TriggersConfig>,
  ): void {
    entry.config = state.value
    if (state.error !== undefined) {
      this._logger.warn(
        `${workspaceTriggersConfigLocation(entry.workspace)} is invalid: ${state.error}`,
      )
    }
    if (entry.config.invalid.length > 0) {
      this._logger.warn(
        `${workspaceTriggersConfigLocation(entry.workspace)}: ${entry.config.invalid.length} invalid trigger entr(ies)`,
      )
    }
    this._pauseFirstSeenTriggers(entry)
    for (const trigger of this._routedTriggers(entry)) this._syncSourceFingerprint(trigger)
    // Schedule/poll cadence is config-derived: drop this workspace's wake anchors so
    // an edited cron or interval takes effect immediately (the persisted
    // lastScheduledAt still drives missed-slot handling).
    this._scheduler.forgetWorkspace(entry.key)
    if (this._isGateOpen()) this._scheduler.syncTiming(this._clock.now())
    else this._scheduler.rescheduleWake()
    this._fireChange()
  }

  /**
   * First sighting of a trigger key on this machine starts it paused. Keys already
   * in `state.json` keep their persisted pause flag: a resumed trigger stays
   * resumed across restarts, and nothing is migrated. A key changes on a new
   * trigger, a cloned workspace config or a renamed id — all count as first seen.
   */
  private _pauseFirstSeenTriggers(entry: WorkspaceEntry): void {
    for (const trigger of this._routedTriggers(entry)) {
      if (this._stateRepo.state.triggers[trigger.key] !== undefined) continue
      this._stateRepo.setTriggerState(trigger.key, { paused: true })
      this._logger.info(
        `trigger ${trigger.id} (${trigger.workspace}): first seen on this machine; starting paused`,
      )
    }
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

  /**
   * A poll / swarm baseline (and its dedupe keys) only makes sense for the exact
   * source it was seeded from: changing `keyField` / command / interval must seed
   * again, otherwise every new item would look "already seen".
   */
  private _syncSourceFingerprint(trigger: RoutedTrigger): void {
    const runtime = this._stateRepo.stateFor(trigger.key)
    const next = sourceFingerprintOf(trigger.source)
    if (runtime.sourceFingerprint === next) return
    if (runtime.sourceFingerprint === undefined) {
      // State written before the fingerprint existed: adopt it without discarding
      // the dedupe keys the user already accumulated.
      this._stateRepo.setTriggerState(trigger.key, { sourceFingerprint: next })
      return
    }
    let processed = runtime.processed
    for (const key of Object.keys(processed)) {
      if (PREFETCHED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        processed = forget(processed, key)
      }
    }
    this._stateRepo.setTriggerState(trigger.key, {
      processed: prune(processed, this._clock.now(), this._stateRepo.pruneOptions()),
      baselineDone: false,
      sourceFingerprint: next,
    })
    this._logger.info(`trigger ${trigger.id}: source changed; baseline and dedupe keys reset`)
  }
}

/** Normalized source identity; changing it invalidates a poll / event baseline. */
function sourceFingerprintOf(source: TriggerSourceConfig): string {
  switch (source.type) {
    case 'poll':
      return `poll|${source.keyField}|${source.fetch.command}|${source.intervalSec}`
    case 'event':
      return `event|${source.event}`
    case 'schedule':
      return `schedule|${source.cron ?? ''}|${source.everyMin ?? ''}`
    case 'manual':
      return 'manual'
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
