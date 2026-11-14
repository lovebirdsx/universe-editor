/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Trigger config stores. Local workspaces keep using JsonConfigFileStore exactly
 *  as before; a remote workspace reads/watches the same file through IFileService
 *  and the tunnelled watcher host.
 *
 *  Every remote call is gated on `IRemoteConnectionService.getState(authority) ===
 *  'connected'` — reading the file, checking the directory, creating the watcher
 *  transport, re-subscribing after a watcher restart. Disposing this store must
 *  never dial the remote host: cleanup is skipped unless the connection is still
 *  connected, and the WatcherProcessClient is disposed synchronously so its
 *  crash replay cannot spawn a fresh transport (which would bring SSH up).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  normalizeRemoteAuthority,
  REMOTE_SCHEME,
  URI,
  type Event,
  type IDisposable,
  type IFileService,
  type ILogger,
} from '@universe-editor/platform'
import { WatcherProcessClient } from '@universe-editor/node-services'
import {
  TRIGGERS_WORKSPACE_CONFIG_FILE,
  type TriggersConfig,
} from '../../../shared/triggers/types.js'
import { RemoteWatcherTransport } from '../remote/remoteWatcherTransport.js'
import type { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'
import { remoteFsPathToUri, remotePathFromUri } from '../remote/remoteUri.js'
import type { JsonConfigFileState } from '../jsonConfig/jsonConfigFileStore.js'
import {
  createEmptyTriggersConfig,
  parseTriggersConfigText,
  serializeTriggersConfig,
  workspaceTriggersConfigDirUri,
  workspaceTriggersConfigUri,
} from './triggersConfigFile.js'

/** The slice of JsonConfigFileStore the scheduler consumes; both implementations match. */
export interface TriggerConfigStore extends IDisposable {
  readonly onDidChangeExternal: Event<JsonConfigFileState<TriggersConfig>>
  load(): Promise<JsonConfigFileState<TriggersConfig>>
  reload(): Promise<JsonConfigFileState<TriggersConfig>>
}

const DEFAULT_DEBOUNCE_MS = 200

/** Same parcel ignore set the shared file watcher uses when no excludes are given. */
const WATCH_IGNORE: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.vs/**',
  '**/dist/**',
  '**/out/**',
  '**/.turbo/**',
]

/** The watcher path the store is currently subscribed to. */
interface WatchTarget {
  readonly path: string
  readonly directory: boolean
}

export interface RemoteTriggerConfigStoreOptions {
  readonly workspaceUri: URI
  readonly logger: ILogger
  readonly fileService: IFileService
  readonly connections: IRemoteConnectionService
  readonly debounceMs?: number
  /** Test seam: the default tunnels over a RemoteWatcherTransport. */
  readonly createWatcherClient?: () => WatcherProcessClient
}

/**
 * Remote `<workspace>/.universe-editor/triggers.json` via the scheme-routed
 * IFileService (RemoteFileSystemProvider) plus a tunnelled watcher. Watches
 * `.universe-editor` once it exists and falls back to the workspace root so a
 * first-time creation of the directory is still observed.
 */
export class RemoteTriggerConfigStore extends Disposable implements TriggerConfigStore {
  private readonly _onDidChangeExternal = this._register(
    new Emitter<JsonConfigFileState<TriggersConfig>>(),
  )
  readonly onDidChangeExternal: Event<JsonConfigFileState<TriggersConfig>> =
    this._onDidChangeExternal.event

  private readonly _workspaceUri: URI
  private readonly _fileUri: URI
  private readonly _dirUri: URI
  private readonly _authority: string
  private readonly _logger: ILogger
  private readonly _fileService: IFileService
  private readonly _connections: IRemoteConnectionService
  private readonly _debounceMs: number
  private readonly _createWatcherClient: () => WatcherProcessClient

  private _state: JsonConfigFileState<TriggersConfig> = { value: createEmptyTriggersConfig() }
  private _serial: Promise<void> = Promise.resolve()
  private _client: WatcherProcessClient | undefined
  private _watchId: number | undefined
  private _watchTarget: WatchTarget | undefined
  private _watchSubs: IDisposable[] = []
  private _reloadTimer: NodeJS.Timeout | undefined
  private _disposed = false

  constructor(options: RemoteTriggerConfigStoreOptions) {
    super()
    this._workspaceUri = options.workspaceUri
    this._authority = normalizeRemoteAuthority(options.workspaceUri.authority)
    this._fileUri = workspaceTriggersConfigUri(options.workspaceUri)
    this._dirUri = workspaceTriggersConfigDirUri(options.workspaceUri)
    this._logger = options.logger
    this._fileService = options.fileService
    this._connections = options.connections
    this._debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this._createWatcherClient =
      options.createWatcherClient ??
      (() =>
        new WatcherProcessClient(
          () => new RemoteWatcherTransport(this._authority, this._connections, this._logger),
        ))
  }

  get state(): JsonConfigFileState<TriggersConfig> {
    return this._state
  }

  load(): Promise<JsonConfigFileState<TriggersConfig>> {
    return this._enqueue(async () => {
      const next = await this._read('startup')
      this._state = next
      this._startWatching()
      return next
    })
  }

  reload(): Promise<JsonConfigFileState<TriggersConfig>> {
    return this._enqueue(async () => {
      const next = await this._read('runtime')
      if (!sameState(next, this._state)) {
        this._state = next
        this._onDidChangeExternal.fire(next)
      }
      return next
    })
  }

  override dispose(): void {
    this._disposed = true
    if (this._reloadTimer !== undefined) {
      clearTimeout(this._reloadTimer)
      this._reloadTimer = undefined
    }
    const client = this._client
    const watchId = this._watchId
    this._client = undefined
    this._watchId = undefined
    this._watchTarget = undefined
    for (const sub of this._watchSubs.splice(0)) sub.dispose()
    if (client !== undefined) {
      // Only speak to the server while the tunnel is known to be alive; cleanup
      // must never be the thing that brings a remote connection up.
      if (watchId !== undefined && this._isConnected()) {
        void client.unwatch(watchId).catch(() => undefined)
      }
      // Synchronous, so the client's crash-replay timer cannot spawn a new
      // transport after the caller already decided this authority is offline.
      client.dispose()
    }
    super.dispose()
  }

  private _enqueue<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    const run = this._serial.then(task, task)
    this._serial = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private _isConnected(): boolean {
    return this._connections.getState(this._authority) === 'connected'
  }

  private async _read(mode: 'startup' | 'runtime'): Promise<JsonConfigFileState<TriggersConfig>> {
    if (!this._isConnected()) {
      this._logger.debug(`remote trigger config read skipped (${this._authority} is not connected)`)
      return mode === 'startup' ? { value: createEmptyTriggersConfig() } : this._state
    }
    let text: string
    try {
      text = await this._fileService.readFileText(this._fileUri)
    } catch (err) {
      if (isNotFound(err)) return { value: createEmptyTriggersConfig() }
      return this._invalidRead(mode, describeError(err))
    }
    const parsed = parseTriggersConfigText(text)
    if (parsed.kind === 'ok') return { value: parsed.value }
    if (parsed.kind === 'missing') return { value: createEmptyTriggersConfig() }
    return this._invalidRead(mode, parsed.error)
  }

  private _invalidRead(
    mode: 'startup' | 'runtime',
    error: string,
  ): JsonConfigFileState<TriggersConfig> {
    if (mode === 'startup') {
      this._logger.warn(
        `remote ${TRIGGERS_WORKSPACE_CONFIG_FILE} is invalid; using defaults: ${error}`,
      )
      return { value: createEmptyTriggersConfig(), error }
    }
    this._logger.warn(
      `remote ${TRIGGERS_WORKSPACE_CONFIG_FILE} is invalid; keeping the last valid config: ${error}`,
    )
    return { value: this._state.value, error }
  }

  private _startWatching(): void {
    if (this._disposed || !this._isConnected() || this._client !== undefined) return
    void this._ensureWatcher().catch((err) => {
      this._logger.warn(
        `[remote:${this._authority}] trigger config watcher failed: ${describeError(err)}`,
      )
    })
  }

  private async _ensureWatcher(): Promise<void> {
    if (this._disposed || !this._isConnected() || this._client !== undefined) return
    const client = this._createWatcherClient()
    const watchId = client.allocateId()
    const subs = [
      client.onFileEvents((msg) => {
        if (msg.id !== watchId) return
        for (const event of msg.events) {
          let uri: URI
          try {
            uri = remoteFsPathToUri(event.path, this._authority)
          } catch {
            continue
          }
          if (uri.path === this._fileUri.path) this._scheduleReload()
        }
      }),
      client.onWatchError((msg) => {
        if (msg.id === watchId) {
          this._logger.warn(`[remote:${this._authority}] trigger config watcher error`, msg.error)
        }
      }),
      // The tunnelled host restarted and replayed its subscriptions; events during
      // the gap are lost, so re-read instead of trusting the current snapshot.
      client.onDidRestart(() => this._scheduleReload()),
    ]
    this._client = client
    this._watchId = watchId
    this._watchSubs = subs
    await this._syncWatchTarget()
  }

  /** Prefer `.universe-editor`; fall back to the workspace root while it is missing. */
  private async _syncWatchTarget(): Promise<void> {
    const client = this._client
    const watchId = this._watchId
    if (client === undefined || watchId === undefined || this._disposed || !this._isConnected()) {
      return
    }
    let directory = false
    try {
      directory = await this._fileService.exists(this._dirUri)
    } catch (err) {
      this._logger.debug(
        `[remote:${this._authority}] cannot check the trigger config directory: ${describeError(err)}`,
      )
    }
    if (this._disposed || this._client !== client || !this._isConnected()) return
    const targetUri = directory ? this._dirUri : this._workspaceUri
    const path = remotePathFromUri(targetUri)
    if (this._watchTarget?.path === path) return
    this._watchTarget = { path, directory }
    try {
      await client.watch(watchId, path, WATCH_IGNORE)
      this._logger.info(`[remote:${this._authority}] watching trigger config in ${path}`)
    } catch (err) {
      this._logger.warn(`[remote:${this._authority}] cannot watch ${path}: ${describeError(err)}`)
    }
  }

  private _scheduleReload(): void {
    if (this._disposed || this._reloadTimer !== undefined) return
    const timer = setTimeout(() => {
      this._reloadTimer = undefined
      void this._reloadAfterEvent()
    }, this._debounceMs)
    timer.unref()
    this._reloadTimer = timer
  }

  private async _reloadAfterEvent(): Promise<void> {
    if (this._disposed || !this._isConnected()) return
    try {
      await this.reload()
    } catch (err) {
      this._logger.warn(
        `[remote:${this._authority}] trigger config reload failed: ${describeError(err)}`,
      )
    }
    if (this._disposed) return
    // The `.universe-editor` directory may have appeared or disappeared with this
    // edit; move the subscription to the cheaper target (or back to the root).
    await this._syncWatchTarget()
  }
}

function sameState(
  a: JsonConfigFileState<TriggersConfig>,
  b: JsonConfigFileState<TriggersConfig>,
): boolean {
  return (
    a.error === b.error &&
    JSON.stringify(serializeTriggersConfig(a.value)) ===
      JSON.stringify(serializeTriggersConfig(b.value))
  )
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Local workspaces keep the exact JsonConfigFileStore implementation. */
export function isRemoteWorkspaceUri(uri: URI): boolean {
  return uri.scheme === REMOTE_SCHEME && uri.authority.length > 0
}
