/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IFileSystemProvider for the `remote-ssh` scheme. Resources are forwarded to the
 *  server's IFileService channel VERBATIM — the server's per-connection codec
 *  translates remote-ssh <-> file, so this provider never mutates URIs. It caches
 *  one IRemoteFileStreamService proxy per authority and drops the entry when the
 *  connection closes so a reconnect resolves a fresh proxy.
 *
 *  File reads are always streamed: `readFile` starts a multiplexed read stream
 *  (chunks arrive on the shared `onReadStreamData` event, dispatched by
 *  streamId), acks each chunk fire-and-forget, and reassembles the buffer once
 *  `size` bytes have arrived. A single large file therefore never blocks the
 *  tunnel behind one multi-MB response frame.
 *--------------------------------------------------------------------------------------------*/

import {
  createNamedLogger,
  Disposable,
  IUriIdentityService,
  ProxyChannel,
  REMOTE_SCHEME,
  RemoteChannels,
  URI,
  type IDirectoryEntry,
  type IDisposable,
  type IFileStat,
  type IFileSystemProvider,
  type IFileSystemProviderCapabilities,
  type ILogger,
  ILoggerService,
  type IRemoteFileStreamEvent,
  type IRemoteFileStreamService,
} from '@universe-editor/platform'
import type { IRemoteConnection, IRemoteConnectionService } from './remoteConnectionMainService.js'

interface RemoteFileStream {
  readonly chunks: Uint8Array[]
  received: number
  readonly size: number
  expectedSeq: number
  readonly resolve: (data: Uint8Array) => void
  readonly reject: (err: Error) => void
}

interface AuthorityEntry {
  readonly service: IRemoteFileStreamService
  readonly streams: Map<number, RemoteFileStream>
  /** Events that arrived before the streamId was registered (startReadStream RPC resolves after the first chunks are pushed). */
  readonly early: Map<number, IRemoteFileStreamEvent[]>
  readonly dispose: IDisposable
  readonly onClose: IDisposable
}

function streamError(e: { message: string; code?: string }): Error {
  const err = new Error(e.message) as Error & { code?: string }
  if (e.code !== undefined) err.code = e.code
  return err
}

function concatBytes(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

export class RemoteFileSystemProvider extends Disposable implements IFileSystemProvider {
  private readonly _logger: ILogger
  private readonly _entries = new Map<string, AuthorityEntry>()
  private readonly _caseSensitiveByAuthority = new Map<string, boolean>()
  private readonly _capabilities = { pathCaseSensitive: true }
  private _caseRegistration: IDisposable | undefined
  private _didWarnConflict = false

  // Conservative default until the first connection delivers the real value.
  get capabilities(): IFileSystemProviderCapabilities {
    return this._capabilities
  }

  constructor(
    private readonly _connections: IRemoteConnectionService,
    @ILoggerService loggerService?: ILoggerService,
    // Renderer-side sync of the scheme case policy is deferred to the remote
    // workspace UI phase (R2); the main process has no IUriIdentityService
    // instance registered today, so this stays optional and no-ops there.
    @IUriIdentityService private readonly _uriIdentity?: IUriIdentityService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'remoteFileSystem',
      name: 'Remote File System',
    })
  }

  private async _entry(authority: string): Promise<AuthorityEntry> {
    const cached = this._entries.get(authority)
    if (cached) return cached
    const conn = await this._connections.getConnection(authority)
    const service = ProxyChannel.toService<IRemoteFileStreamService>(
      conn.getChannel(RemoteChannels.FileSystem),
    )
    const streams = new Map<number, RemoteFileStream>()
    const early = new Map<number, IRemoteFileStreamEvent[]>()
    const entry: AuthorityEntry = {
      service,
      streams,
      early,
      dispose: this._register(service.onReadStreamData((e) => this._onStreamEvent(entry, e))),
      onClose: this._register(conn.onDidClose(() => this._dropAuthority(authority))),
    }
    this._entries.set(authority, entry)
    this._applyConnectionEnv(authority, conn)
    this._logger.debug(`remote file system proxy ready authority=${authority}`)
    return entry
  }

  private async _service(authority: string): Promise<IRemoteFileStreamService> {
    return (await this._entry(authority)).service
  }

  private _dropAuthority(authority: string): void {
    const entry = this._entries.get(authority)
    if (!entry) return
    this._store.delete(entry.dispose)
    this._store.delete(entry.onClose)
    const err = new Error(`remote connection closed while reading '${authority}'`)
    for (const stream of entry.streams.values()) {
      stream.reject(err)
    }
    entry.streams.clear()
    entry.early.clear()
    this._entries.delete(authority)
  }

  private _onStreamEvent(entry: AuthorityEntry, e: IRemoteFileStreamEvent): void {
    const stream = entry.streams.get(e.streamId)
    if (!stream) {
      const pending = entry.early.get(e.streamId)
      if (pending) pending.push(e)
      else entry.early.set(e.streamId, [e])
      return
    }
    this._deliver(entry, e.streamId, stream, e)
  }

  private _deliver(
    entry: AuthorityEntry,
    streamId: number,
    stream: RemoteFileStream,
    e: IRemoteFileStreamEvent,
  ): void {
    if (e.error) {
      entry.streams.delete(streamId)
      stream.reject(streamError(e.error))
      return
    }
    if (e.done) {
      entry.streams.delete(streamId)
      if (stream.received !== stream.size) {
        stream.reject(
          new Error(
            `read stream ${streamId} ended early (${stream.received}/${stream.size} bytes)`,
          ),
        )
        return
      }
      stream.resolve(concatBytes(stream.chunks, stream.size))
      return
    }
    if (e.data !== undefined) {
      if (e.seq !== stream.expectedSeq) {
        entry.streams.delete(streamId)
        stream.reject(
          new Error(
            `read stream ${streamId} out-of-order seq ${e.seq} (expected ${stream.expectedSeq})`,
          ),
        )
        void entry.service.cancelReadStream(streamId).catch(() => undefined)
        return
      }
      stream.chunks.push(e.data)
      stream.received += e.data.length
      stream.expectedSeq++
      void entry.service.ackReadStream(streamId, e.seq).catch((err) => {
        this._logger.debug(
          `read stream ${streamId} ack ${e.seq} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }
  }

  private _applyConnectionEnv(authority: string, conn: IRemoteConnection): void {
    this._caseSensitiveByAuthority.set(authority, conn.env.pathCaseSensitive)
    const value = this._resolveCaseSensitivity()
    this._capabilities.pathCaseSensitive = value
    if (this._uriIdentity) {
      this._caseRegistration?.dispose()
      this._caseRegistration = this._uriIdentity.registerSchemeCaseSensitivity(REMOTE_SCHEME, value)
    }
  }

  private _resolveCaseSensitivity(): boolean {
    if (this._caseSensitiveByAuthority.size === 0) return true
    const values = new Set(this._caseSensitiveByAuthority.values())
    if (values.size > 1) {
      if (!this._didWarnConflict) {
        this._didWarnConflict = true
        this._logger.warn(
          'remote authorities disagree on path case sensitivity; using case-sensitive (true)',
        )
      }
      return true
    }
    return values.values().next().value as boolean
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    const entry = await this._entry(resource.authority)
    const { streamId, size } = await entry.service.startReadStream(resource)
    return new Promise<Uint8Array>((resolve, reject) => {
      const stream: RemoteFileStream = {
        chunks: [],
        received: 0,
        size,
        expectedSeq: 0,
        resolve,
        reject,
      }
      entry.streams.set(streamId, stream)
      const early = entry.early.get(streamId)
      if (early) {
        entry.early.delete(streamId)
        for (const e of early) {
          if (entry.streams.get(streamId) !== stream) break
          this._deliver(entry, streamId, stream, e)
        }
      }
    })
  }

  async readFileText(resource: URI, encoding?: 'utf8'): Promise<string> {
    const svc = await this._service(resource.authority)
    return svc.readFileText(resource, encoding)
  }

  async writeFile(resource: URI, content: Uint8Array | string): Promise<void> {
    const svc = await this._service(resource.authority)
    return svc.writeFile(resource, content)
  }

  async exists(resource: URI): Promise<boolean> {
    const svc = await this._service(resource.authority)
    return svc.exists(resource)
  }

  async stat(resource: URI): Promise<IFileStat> {
    const svc = await this._service(resource.authority)
    return svc.stat(resource)
  }

  async list(resource: URI): Promise<IDirectoryEntry[]> {
    const svc = await this._service(resource.authority)
    return svc.list(resource)
  }

  async realpath(resource: URI): Promise<URI> {
    const svc = await this._service(resource.authority)
    return svc.realpath!(resource)
  }

  async createDirectory(resource: URI): Promise<void> {
    const svc = await this._service(resource.authority)
    return svc.createDirectory(resource)
  }

  async delete(resource: URI, opts?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
    const svc = await this._service(resource.authority)
    return svc.delete(resource, opts)
  }

  async rename(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void> {
    const svc = await this._service(source.authority)
    return svc.rename(source, target, opts)
  }

  async copy(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void> {
    const svc = await this._service(source.authority)
    return svc.copy(source, target, opts)
  }

  async listRecursive(
    root: URI,
    options?: { ignore?: readonly string[]; maxFiles?: number; maxDepth?: number },
  ): Promise<URI[]> {
    const svc = await this._service(root.authority)
    return svc.listRecursive(root, options)
  }
}
