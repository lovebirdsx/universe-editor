/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PersistedStateBase — workspace-first / global-fallback storage template.
 *
 *  Owns the lifecycle pieces shared by `AcpSessionHistoryService` and
 *  `AcpAgentDefaultsService`:
 *    - cold-start "wait for first workspace-scope event or short timeout"
 *    - workspace swap: flush to old bucket, reset, reload from new bucket
 *    - debounced writes with synchronous flush on dispose
 *
 *  Subclasses provide the state shape (serialize/deserialize/empty) and a
 *  hook to push state into their observables after each replacement.
 *
 *  Not intended for single-scope persisters like `AcpChatLocationService`,
 *  which has only one bucket and doesn't need the workspace-swap machinery.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  type ILogger,
  type ILoggerService,
  type IStorageService,
  type ITelemetryService,
  type IWorkspaceService,
  StorageScope,
} from '@universe-editor/platform'

export interface PersistedStateOptions {
  /** IStorageService key. */
  readonly storageKey: string
  readonly loggerId: string
  readonly loggerName: string
  /** Telemetry event name for persist failures. */
  readonly persistFailureEvent: string
  /**
   * Cold-start fallback for empty windows: how long to wait for the first
   * workspace-scope event before loading from GLOBAL anyway. Default 500ms.
   */
  readonly initialLoadTimeoutMs?: number
  /** Debounce window between mutating call and storage write. Default 100ms. */
  readonly writeDebounceMs?: number
}

export abstract class PersistedStateBase<TState> extends Disposable {
  protected _state: TState
  protected readonly _logger: ILogger
  private readonly _storageKey: string
  private readonly _persistFailureEvent: string
  private readonly _initialLoadTimeoutMs: number
  private readonly _writeDebounceMs: number
  private _loaded = false
  private _loadPromise: Promise<void> | undefined
  private _writeTimer: ReturnType<typeof setTimeout> | undefined
  /** Set while `_reload` is mid-swap so the debounced write doesn't fire into a half-built state. */
  private _writeSuspended = false
  /** The scope our current `_state` snapshot was loaded from; flush writes go here. */
  private _currentLoadedScope: StorageScope | undefined

  constructor(
    protected readonly _storage: IStorageService,
    protected readonly _workspace: IWorkspaceService,
    protected readonly _telemetry: ITelemetryService,
    loggerService: ILoggerService,
    options: PersistedStateOptions,
  ) {
    super()
    this._storageKey = options.storageKey
    this._persistFailureEvent = options.persistFailureEvent
    this._initialLoadTimeoutMs = options.initialLoadTimeoutMs ?? 500
    this._writeDebounceMs = options.writeDebounceMs ?? 100
    this._logger = loggerService.createLogger({ id: options.loggerId, name: options.loggerName })
    this._state = this._emptyState()
    this._register(this._storage.onDidChangeWorkspaceScope(() => void this._reload()))
  }

  /** Idempotent: safe to call multiple times. */
  initialize(): Promise<void> {
    if (this._loaded) return Promise.resolve()
    if (this._loadPromise) return this._loadPromise
    this._loadPromise = this._scheduleInitialLoad()
    return this._loadPromise
  }

  override dispose(): void {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer)
      this._writeTimer = undefined
      // Flush a final write synchronously so we don't lose the trailing edit.
      void this._writeNow()
    }
    super.dispose()
  }

  // -- subclass hooks --------------------------------------------------

  protected abstract _emptyState(): TState
  protected abstract _serialize(state: TState): unknown
  /** Return undefined on parse failure → caller falls back to empty state. */
  protected abstract _deserialize(raw: unknown): TState | undefined
  /** Replace observable-side state. Called after every state change. */
  protected abstract _onStateReplaced(state: TState): void

  /**
   * Bounded one-line summary for the load log. Never serializes a large state
   * wholesale: `JSON.stringify` of a hundred-MB state is itself an OOM hazard,
   * and the log line would be relayed to the main process over IPC.
   */
  protected _describeState(): string {
    const state: unknown = this._state
    if (state instanceof Map) return `${state.size} entries`
    if (Array.isArray(state)) return `${state.length} entries`
    const json = JSON.stringify(state) ?? ''
    return json.length <= 2048 ? json : `${json.slice(0, 2048)}…`
  }
  /**
   * Merge freshly-loaded state with whatever the subclass accumulated
   * in-memory before load completed. Default: prefer loaded. Subclasses with
   * id-keyed entries should override to merge by id with in-memory winning.
   */
  protected _mergeOnLoad(loaded: TState, _current: TState): TState {
    return loaded
  }

  // -- internals -------------------------------------------------------

  private _currentScope(): StorageScope {
    return this._workspace.current ? StorageScope.WORKSPACE : StorageScope.GLOBAL
  }

  /**
   * `RendererWorkspaceService.current` is `null` at construction time and gets
   * hydrated asynchronously; once hydrated, the storage layer fires
   * `onDidChangeWorkspaceScope`. To avoid reading the wrong bucket on cold
   * start we wait for either the first scope event or a short timeout (true
   * empty-window case), then load whichever scope is correct at that point.
   */
  private async _scheduleInitialLoad(): Promise<void> {
    if (!this._workspace.current) {
      await new Promise<void>((resolve) => {
        let resolved = false
        const settle = () => {
          if (resolved) return
          resolved = true
          subscription.dispose()
          clearTimeout(timer)
          resolve()
        }
        const subscription = this._register(this._storage.onDidChangeWorkspaceScope(settle))
        const timer = setTimeout(settle, this._initialLoadTimeoutMs)
      })
    }
    await this._loadFromScope(this._currentScope())
  }

  /**
   * Workspace switched: flush any pending write to the OLD bucket, clear state,
   * and load from the NEW bucket. Writes are suspended in between so the
   * debounced timer can't deposit half-built state into the wrong scope.
   */
  private async _reload(): Promise<void> {
    this._writeSuspended = true
    try {
      if (this._writeTimer) {
        clearTimeout(this._writeTimer)
        this._writeTimer = undefined
        // Flush to the OLD scope using _currentLoadedScope (set by the previous load).
        await this._writeNow()
      }
      this._state = this._emptyState()
      this._currentLoadedScope = undefined
      this._loaded = false
      this._loadPromise = undefined
      this._onStateReplaced(this._state)
      await this._loadFromScope(this._currentScope())
    } finally {
      this._writeSuspended = false
    }
  }

  private async _loadFromScope(scope: StorageScope): Promise<void> {
    try {
      const raw = await this._storage.get<unknown>(this._storageKey, scope)
      if (raw !== undefined) {
        const parsed = this._deserialize(raw)
        if (parsed !== undefined) {
          this._state = this._mergeOnLoad(parsed, this._state)
          this._logger.info(
            `${this._storageKey} loaded from ${StorageScope[scope]}: ${this._describeState()}`,
          )
          this._onStateReplaced(this._state)
        } else {
          this._logger.warn(`ignoring ${this._storageKey} (unrecognized shape)`)
        }
      }
    } catch (err) {
      this._logger.warn(`failed to load ${this._storageKey}: ${(err as Error).message}`)
    } finally {
      this._loaded = true
      this._currentLoadedScope = scope
    }
  }

  protected _scheduleWrite(): void {
    if (this._writeSuspended) return
    if (this._writeTimer) return
    this._writeTimer = setTimeout(() => {
      this._writeTimer = undefined
      void this._writeNow()
    }, this._writeDebounceMs)
  }

  private async _writeNow(): Promise<void> {
    const scope = this._currentLoadedScope ?? this._currentScope()
    try {
      await this._storage.set(this._storageKey, this._serialize(this._state), scope)
    } catch (err) {
      this._telemetry.publicLogError(this._persistFailureEvent, {
        error: (err as Error).message,
      })
      this._logger.warn(`failed to persist ${this._storageKey}: ${(err as Error).message}`)
    }
  }
}
