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
 *  Not intended for single-scope persisters like `AcpSessionFilterService`,
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
  /** In-flight `_writeNow`; new schedules must not stack IPC writes on top of it. */
  private _writeInFlight: Promise<void> | undefined
  /** Set when state changed while a write was in flight → one follow-up write. */
  private _writeDirty = false
  /** Set while `_reload` is mid-swap so the debounced write doesn't fire into a half-built state. */
  private _writeSuspended = false
  /** The scope our current `_state` snapshot was loaded from; flush writes go here. */
  private _currentLoadedScope: StorageScope | undefined
  /**
   * Serializes the initial load and every reload. Scope events can arrive faster
   * than a bucket read completes; letting two swaps overlap lets the older read
   * publish onto the newer scope (and persist it into that scope's bucket), so
   * one load must finish before the next begins.
   */
  private _loadChain: Promise<void> = Promise.resolve()
  /**
   * Bumped by every reload. A load captures it and only publishes when it is
   * still the latest — a read superseded while suspended must not overwrite the
   * state a newer reload is already working with.
   */
  private _loadGeneration = 0
  /**
   * State reset by a reload that has not published a load result yet. Mutations
   * made during that window (writes are suspended, so they cannot be debounced)
   * live here; if the load is superseded, the next reload carries them into the
   * new scope instead of dropping them on the next reset.
   */
  private _pendingLoadState: TState | undefined
  /** Callers of `initialize()` waiting for the first *accepted* load. A scope
   *  event can supersede the initial read, so awaiting only that read would
   *  report success before any state was loaded. */
  private _loadedWaiters: Array<() => void> = []

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
    const generation = this._loadGeneration
    const initial = this._enqueueLoad(() => this._scheduleInitialLoad(generation))
    this._loadPromise = (async () => {
      await initial
      // A reload can supersede the read we just awaited (it is queued behind
      // us); wait for whichever load is finally accepted before reporting ready.
      while (!this._loaded) {
        await new Promise<void>((resolve) => this._loadedWaiters.push(resolve))
      }
    })()
    return this._loadPromise
  }

  override dispose(): void {
    const hadTimer = this._writeTimer !== undefined
    if (this._writeTimer) {
      clearTimeout(this._writeTimer)
      this._writeTimer = undefined
    }
    // A trailing edit can be waiting as a dirty flag behind an in-flight write
    // (no timer then), so dispose must drain that path too — not only the
    // debounce timer. flush() also waits for the in-flight write instead of
    // stacking a second one on top of it.
    if (this._writeInFlight || this._writeDirty) {
      void this.flush()
    } else if (hadTimer) {
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
   * Read and parse the state for `scope`. Default: one `storage.get` plus
   * `_deserialize` (unchanged behaviour). Subclasses that persist elsewhere
   * override this; returning undefined still means "no parseable state", not
   * "the read failed and the store is empty".
   */
  protected async _loadFromStorage(scope: StorageScope): Promise<TState | undefined> {
    const raw = await this._storage.get<unknown>(this._storageKey, scope)
    if (raw === undefined) return undefined
    const parsed = this._deserialize(raw)
    if (parsed === undefined) {
      this._logger.warn(`ignoring ${this._storageKey} (unrecognized shape)`)
    }
    return parsed
  }

  /**
   * Persist `state` for `scope`. Default: one whole-state `storage.set`
   * (unchanged behaviour). Subclasses may write only what changed, but must
   * still honour the debounce/backpressure lifecycle owned here.
   */
  protected async _persistToStorage(state: TState, scope: StorageScope): Promise<void> {
    await this._storage.set(this._storageKey, this._serialize(state), scope)
  }

  /**
   * Called after pending writes for the outgoing scope have drained, and before
   * the state is reset for the incoming scope. Subclasses that bound a bucket
   * at load time release it here so nothing queued for it can leak into the
   * next scope.
   */
  protected async _onBeforeScopeChange(): Promise<void> {}

  /**
   * Called once the swap has completed and writes are allowed again. Dirty
   * state accumulated while the new scope was loading had its `_scheduleWrite`
   * suppressed; subclasses use this to retry it (and anything pinned to the
   * outgoing bucket) now.
   */
  protected _onAfterScopeChange(): void {}

  /**
   * Drain the debounce, the in-flight write and any final dirty state. The
   * default write path is one whole-state set; subclasses with incremental
   * persistence decide what "dirty" means inside `_persistToStorage`.
   *
   * A mutation that lands while a flush write is on the wire is only marked
   * dirty; its completion must therefore be followed by another pass in this
   * same flush, or the caller would be told "drained" before that edit landed.
   * A failed write ends the loop instead of retrying forever: the state stays
   * dirty (and any debounce scheduled by the failure still retries later), and
   * the caller's next flush/mutation redrives it.
   */
  async flush(): Promise<void> {
    await this._drainWrites()
  }

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
  private async _scheduleInitialLoad(generation: number): Promise<void> {
    if (this._loaded) return
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
    await this._loadFromScope(this._currentScope(), generation)
  }

  private _enqueueLoad(run: () => Promise<void>): Promise<void> {
    const next = this._loadChain.then(run, run)
    this._loadChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * Workspace switched: flush any pending write to the OLD bucket, clear state,
   * and load from the NEW bucket. Writes are suspended in between so the
   * debounced timer can't deposit half-built state into the wrong scope.
   *
   * Reloads are serialized with the initial load: the newest request owns the
   * swap, and any load that was superseded while suspended neither publishes
   * its (now stale) result nor clears state a newer reload is about to use.
   */
  private _reload(): Promise<void> {
    const generation = ++this._loadGeneration
    return this._enqueueLoad(() => this._reloadNow(generation))
  }

  private async _reloadNow(generation: number): Promise<void> {
    // A newer event already queued behind us — it will do the swap against the
    // latest scope; touching state here would only add a pointless reset.
    if (generation !== this._loadGeneration) return
    this._writeSuspended = true
    try {
      if (this._writeTimer !== undefined || this._writeDirty) {
        // Flush to the OLD scope using _currentLoadedScope (set by the previous load).
        await this._drainWrites()
      }
      // Drain a write that was already on the wire before the swap, then let the
      // subclass retire whatever still belongs to the outgoing bucket. Without
      // this a tail write can land after the new state is loaded and be mistaken
      // for a change belonging to the new scope.
      while (this._writeInFlight) await this._writeInFlight
      if (generation !== this._loadGeneration) return
      await this._onBeforeScopeChange()
      if (generation !== this._loadGeneration) return
      // Carry edits made while a superseded load was suspended: they were never
      // debounced (writes are suspended during a swap), so resetting would drop
      // them, and the new scope is the only place they can still be persisted.
      const carried = this._pendingLoadState
      this._state = carried ?? this._emptyState()
      this._pendingLoadState = this._state
      this._currentLoadedScope = undefined
      this._loaded = false
      this._loadPromise = undefined
      this._onStateReplaced(this._state)
      await this._loadFromScope(this._currentScope(), generation)
    } finally {
      if (generation === this._loadGeneration) {
        this._writeSuspended = false
        this._onAfterScopeChange()
      }
    }
  }

  private async _loadFromScope(scope: StorageScope, generation: number): Promise<void> {
    if (generation !== this._loadGeneration) return
    try {
      const parsed = await this._loadFromStorage(scope)
      // The workspace changed again while this read was suspended. Publishing
      // now would put the old scope's state on top of the newer scope's load —
      // and a subsequent write would persist it into the newer bucket.
      if (generation !== this._loadGeneration) return
      if (parsed !== undefined) {
        this._state = this._mergeOnLoad(parsed, this._state)
        this._logger.info(
          `${this._storageKey} loaded from ${StorageScope[scope]}: ${this._describeState()}`,
        )
        this._onStateReplaced(this._state)
      }
    } catch (err) {
      this._logger.warn(`failed to load ${this._storageKey}: ${(err as Error).message}`)
      if (generation !== this._loadGeneration) return
    }
    this._pendingLoadState = undefined
    this._currentLoadedScope = scope
    this._markLoaded()
  }

  /** Record that an accepted load landed, and release `initialize()` callers. */
  private _markLoaded(): void {
    this._loaded = true
    const waiters = this._loadedWaiters
    this._loadedWaiters = []
    for (const resolve of waiters) resolve()
  }

  /**
   * Clear the debounce and write until no timer/dirty flag remains. Each pass
   * writes the whole current state, so a mutation that arrived mid-write is
   * covered by the next pass. Returns false when a write failed; pending state
   * is left for a later retry rather than spinning here.
   */
  private async _drainWrites(): Promise<boolean> {
    for (;;) {
      if (this._writeTimer !== undefined) {
        clearTimeout(this._writeTimer)
        this._writeTimer = undefined
      }
      while (this._writeInFlight) await this._writeInFlight
      if (!this._loaded) return true
      const ok = await this._writeNow()
      while (this._writeInFlight) await this._writeInFlight
      if (!ok) return false
      if (!this._writeDirty && this._writeTimer === undefined) return true
    }
  }

  protected _scheduleWrite(): void {
    if (this._writeSuspended) return
    // Backpressure: a write is already on the wire. Mark dirty and let its
    // completion schedule exactly one follow-up — otherwise a hot producer
    // (e.g. ACP session state) stacks unbounded set() IPC calls on main.
    if (this._writeInFlight) {
      this._writeDirty = true
      return
    }
    if (this._writeTimer) return
    this._writeTimer = setTimeout(() => {
      this._writeTimer = undefined
      if (this._writeInFlight) {
        this._writeDirty = true
        return
      }
      void this._writeNow()
    }, this._writeDebounceMs)
  }

  private async _writeNow(): Promise<boolean> {
    const scope = this._currentLoadedScope ?? this._currentScope()
    let ok = true
    const write = (async () => {
      try {
        await this._persistToStorage(this._state, scope)
      } catch (err) {
        ok = false
        this._telemetry.publicLogError(this._persistFailureEvent, {
          error: (err as Error).message,
        })
        this._logger.warn(`failed to persist ${this._storageKey}: ${(err as Error).message}`)
      }
    })()
    this._writeInFlight = write
    try {
      await write
    } finally {
      this._writeInFlight = undefined
      if (this._writeDirty) {
        this._writeDirty = false
        this._scheduleWrite()
      }
    }
    return ok
  }
}
