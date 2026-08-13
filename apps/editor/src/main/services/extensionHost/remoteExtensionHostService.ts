/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Remote ExtensionHostService — the IExtensionHostService implementation that
 *  runs the host on a remote server. `start(spec)` (with `spec.authority`) opens
 *  an ExtensionHost tunnel and maps its raw byte pipe onto the same
 *  writeStdin/onStdout/onExit surface the local service exposes, so the renderer
 *  RPC peer is oblivious to where the host lives. stderr stays on the server
 *  (routed to the daemon log); onStdout carries the newline-framed RPC wire.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import {
  createNamedLogger,
  Disposable,
  DisposableStore,
  Emitter,
  ILoggerService,
  type ILogger,
} from '@universe-editor/platform'
import type {
  ExtHostExitEvent,
  ExtHostStartResult,
  ExtHostStartSpec,
  ExtHostStdioChunk,
  IExtensionHostService,
} from '../../../shared/ipc/extensionHostService.js'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'
import type { IRemoteExtensionHostTunnel } from '../remote/remoteExtensionHostTunnel.js'

interface TunnelEntry {
  readonly tunnel: IRemoteExtensionHostTunnel
  readonly store: DisposableStore
  readonly stdoutDecoder: StringDecoder
  exited: boolean
}

export class RemoteExtensionHostService extends Disposable implements IExtensionHostService {
  declare readonly _serviceBrand: undefined

  private readonly _onStdout = this._register(new Emitter<ExtHostStdioChunk>())
  readonly onStdout = this._onStdout.event

  private readonly _onStderr = this._register(new Emitter<ExtHostStdioChunk>())
  readonly onStderr = this._onStderr.event

  private readonly _onExit = this._register(new Emitter<ExtHostExitEvent>())
  readonly onExit = this._onExit.event

  private readonly _entries = new Map<string, TunnelEntry>()
  private readonly _logger: ILogger

  constructor(
    @IRemoteConnectionService private readonly _connections: IRemoteConnectionService,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'remoteExtensionHost',
      name: 'Remote Extension Host',
    })
  }

  async start(spec?: ExtHostStartSpec): Promise<ExtHostStartResult> {
    const authority = spec?.authority
    if (!authority) {
      throw new Error('RemoteExtensionHostService.start requires a spec authority')
    }
    const handle = randomUUID()
    // Forward the spec's host-independent fields (workspace root, locale, disabled
    // ids) as host env over the ExtensionHost handshake. Server-resolved path fills
    // (builtin/user extensions dirs, global storage, TS server) are added by the
    // daemon before forking — it knows the bundle + data-dir layout, the client
    // does not.
    const env: Record<string, string> = {}
    if (spec?.workspaceRoot !== undefined) env.UNIVERSE_WORKSPACE_ROOT = spec.workspaceRoot
    if (spec?.locale !== undefined) env.UNIVERSE_DISPLAY_LOCALE = spec.locale
    if (spec?.disabledIds && spec.disabledIds.length > 0) {
      env.UNIVERSE_DISABLED_EXTENSIONS = spec.disabledIds.join(',')
    }
    const tunnel = await this._connections.openExtensionHostConnection(authority, { env })

    const store = new DisposableStore()
    const entry: TunnelEntry = {
      tunnel,
      store,
      stdoutDecoder: new StringDecoder('utf8'),
      exited: false,
    }
    this._entries.set(handle, entry)

    store.add(
      tunnel.onData((data) => {
        this._onStdout.fire({ handle, data: entry.stdoutDecoder.write(Buffer.from(data)) })
      }),
    )
    store.add(tunnel.onExit(({ code }) => this._settleExit(handle, entry, code, null)))
    store.add(tunnel.onDidClose(() => this._settleExit(handle, entry, null, null)))

    this._logger.info(`start handle=${handle} authority=${authority}`)
    return { handle }
  }

  private _settleExit(
    handle: string,
    entry: TunnelEntry,
    code: number | null,
    signal: string | null,
  ): void {
    if (entry.exited) return
    entry.exited = true
    this._entries.delete(handle)
    this._onExit.fire({ handle, code, signal })
    entry.store.dispose()
  }

  writeStdin(handle: string, data: string): Promise<void> {
    const entry = this._entries.get(handle)
    if (!entry || entry.exited) {
      return Promise.reject(new Error(`ExtensionHost: unknown or exited handle ${handle}`))
    }
    entry.tunnel.send(new TextEncoder().encode(data))
    return Promise.resolve()
  }

  stop(handle: string): Promise<void> {
    const entry = this._entries.get(handle)
    if (!entry) return Promise.resolve()
    entry.exited = true
    this._entries.delete(handle)
    // Sends a Disconnect frame, which tells the daemon to graceful-stop the child.
    entry.tunnel.dispose()
    entry.store.dispose()
    return Promise.resolve()
  }

  stopAll(): Promise<void> {
    for (const [handle, entry] of this._entries) {
      if (entry.exited) continue
      entry.exited = true
      this._entries.delete(handle)
      entry.tunnel.dispose()
      entry.store.dispose()
    }
    this._entries.clear()
    return Promise.resolve()
  }

  hasUserExtensions(): Promise<boolean> {
    // Remote user extensions are not synchronized this phase.
    return Promise.resolve(false)
  }

  override dispose(): void {
    for (const [, entry] of this._entries) {
      entry.exited = true
      entry.tunnel.dispose()
      entry.store.dispose()
    }
    this._entries.clear()
    super.dispose()
  }
}
