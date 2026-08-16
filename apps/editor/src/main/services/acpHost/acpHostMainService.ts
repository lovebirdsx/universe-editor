/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side ACP agent process host — a thin shell over the Electron-free
 *  AcpHostService core in node-services. It adds the local/remote split:
 *
 *    - `spec.authority` set → the server's AcpHost channel for that authority;
 *      the agent process spawns on the remote host and stdio bytes flow back
 *      through the channel's events.
 *    - otherwise → the local core (Electron's own node for `runAsNode`).
 *
 *  Handles are opaque UUIDs produced by whichever host spawns, so they pass
 *  through un-rewritten; a `handle → authority` map routes writeStdin/stop back
 *  to the right service.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import { app } from 'electron'
import {
  Disposable,
  Emitter,
  ILoggerService,
  ProxyChannel,
  RemoteChannels,
  createNamedLogger,
  type IDisposable,
  type ILogger,
} from '@universe-editor/platform'
import {
  AcpHostService,
  type AcpCommandLookup,
  type AcpSpawner,
  type NodeEntryResolver,
} from '@universe-editor/node-services'
import type {
  AcpExitEvent,
  AcpLaunchSpec,
  AcpStartResult,
  AcpStdioChunk,
  IAcpHostService,
} from '@universe-editor/platform'
import { processRoleRegistry } from '../process/processRoleRegistry.js'
import { resolveFromRepo } from '../../repoPaths.js'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'

export type { AcpCommandLookup, AcpSpawner, NodeEntryResolver }

const BUNDLED_CLAUDE_ENTRY_DEV = 'vendor/claude-agent-acp/dist/index.js'
const BUNDLED_CLAUDE_ENTRY_PACKAGED = 'claude-agent-acp/dist/index.js'
const BUNDLED_CODEX_ENTRY_DEV = 'vendor/codex-acp/dist/index.js'
const BUNDLED_CODEX_ENTRY_PACKAGED = 'codex-acp/dist/index.js'

function defaultResolveNodeEntry(entry: 'claude' | 'codex'): string {
  const dev = entry === 'codex' ? BUNDLED_CODEX_ENTRY_DEV : BUNDLED_CLAUDE_ENTRY_DEV
  const packaged = entry === 'codex' ? BUNDLED_CODEX_ENTRY_PACKAGED : BUNDLED_CLAUDE_ENTRY_PACKAGED
  return app.isPackaged ? path.join(process.resourcesPath, packaged) : resolveFromRepo(dev)
}

export class AcpHostMainService extends Disposable implements IAcpHostService {
  declare readonly _serviceBrand: undefined

  private readonly _onStdout = this._register(new Emitter<AcpStdioChunk>())
  readonly onStdout = this._onStdout.event

  private readonly _onStderr = this._register(new Emitter<AcpStdioChunk>())
  readonly onStderr = this._onStderr.event

  private readonly _onExit = this._register(new Emitter<AcpExitEvent>())
  readonly onExit = this._onExit.event

  private readonly _local: AcpHostService

  private readonly _logger: ILogger

  private readonly _remoteServices = new Map<string, IAcpHostService>()
  private readonly _remotePromises = new Map<string, Promise<IAcpHostService>>()
  private readonly _remoteSubs = new Map<string, IDisposable[]>()
  /** handle → authority (remote handles only). */
  private readonly _remoteByHandle = new Map<string, string>()

  constructor(
    spawn?: AcpSpawner,
    lookup?: AcpCommandLookup,
    resolveNodeEntry?: NodeEntryResolver,
    @ILoggerService loggerService?: ILoggerService,
    @IRemoteConnectionService private readonly _connections?: IRemoteConnectionService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'acpHost', name: 'ACP Host' })
    this._local = this._register(
      new AcpHostService({
        ...(spawn !== undefined ? { spawn } : {}),
        ...(lookup !== undefined ? { lookup } : {}),
        resolveNodeEntry: resolveNodeEntry ?? defaultResolveNodeEntry,
        // The local shell always runs under Electron, so a `runAsNode` launch
        // uses `process.execPath` (Electron's node) and must re-add the flag the
        // agent's self re-spawn inherits. The server's core auto-detects its own
        // runtime instead (plain Node → no flag); this shell pins the Electron case.
        runAsNodeEnv: () => ({ ELECTRON_RUN_AS_NODE: '1' }),
        ...(loggerService !== undefined ? { logger: loggerService } : {}),
        onSpawned: (pid, label) => processRoleRegistry.register(pid, { role: 'acp-agent', label }),
      }),
    )
    this._register(this._local.onStdout((e) => this._onStdout.fire(e)))
    this._register(this._local.onStderr((e) => this._onStderr.fire(e)))
    this._register(this._local.onExit((e) => this._onExit.fire(e)))
  }

  async start(spec: AcpLaunchSpec): Promise<AcpStartResult> {
    if (spec.authority) {
      const service = await this._remoteService(spec.authority)
      const { authority: _authority, ...rest } = spec
      const result = await service.start(rest)
      this._remoteByHandle.set(result.handle, spec.authority)
      return result
    }
    if (process.platform === 'win32' && spec.cwd?.startsWith('/')) {
      // POSIX cwd reaching the local spawn means a remote session lost its
      // authority — the spawn would ENOENT on Windows.
      this._logger.warn(
        `acpHost start: POSIX cwd '${spec.cwd}' reached the local spawn — a remote session likely lost its authority`,
      )
    }
    return this._local.start(spec)
  }

  writeStdin(handle: string, data: string): Promise<void> {
    const authority = this._remoteByHandle.get(handle)
    if (authority) {
      const service = this._remoteServices.get(authority)
      return service
        ? service.writeStdin(handle, data)
        : Promise.reject(new Error(`AcpHost: unknown handle ${handle}`))
    }
    return this._local.writeStdin(handle, data)
  }

  stop(handle: string): Promise<void> {
    const authority = this._remoteByHandle.get(handle)
    if (authority) {
      this._remoteByHandle.delete(handle)
      const service = this._remoteServices.get(authority)
      return service ? service.stop(handle) : Promise.resolve()
    }
    return this._local.stop(handle)
  }

  async probe(command: string): Promise<boolean> {
    // PATH probing stays local: the renderer's agent registry detects local
    // agents here; a remote agent is declared on the remote host instead.
    return this._local.probe(command)
  }

  override dispose(): void {
    this._remoteSubs.clear()
    this._remoteServices.clear()
    this._remotePromises.clear()
    this._remoteByHandle.clear()
    super.dispose()
  }

  private _remoteService(authority: string): Promise<IAcpHostService> {
    const cached = this._remoteServices.get(authority)
    if (cached) return Promise.resolve(cached)
    const inflight = this._remotePromises.get(authority)
    if (inflight) return inflight
    if (!this._connections) {
      throw new Error('acpHost: remote connection service not available')
    }
    const promise = this._connectRemote(authority).finally(() => {
      if (this._remotePromises.get(authority) === promise) this._remotePromises.delete(authority)
    })
    this._remotePromises.set(authority, promise)
    return promise
  }

  private async _connectRemote(authority: string): Promise<IAcpHostService> {
    const conn = await this._connections!.getConnection(authority)
    const service = ProxyChannel.toService<IAcpHostService>(conn.getChannel(RemoteChannels.AcpHost))
    const subs: IDisposable[] = [
      service.onStdout((e) => this._onStdout.fire(e)),
      service.onStderr((e) => this._onStderr.fire(e)),
      service.onExit((e) => {
        this._remoteByHandle.delete(e.handle)
        this._onExit.fire(e)
      }),
      conn.onDidClose(() => this._dropRemote(authority)),
    ]
    if (this._store.isDisposed) {
      for (const s of subs) s.dispose()
      throw new Error('acpHost: service disposed while connecting')
    }
    for (const s of subs) this._register(s)
    this._remoteServices.set(authority, service)
    this._remoteSubs.set(authority, subs)
    return service
  }

  private _dropRemote(authority: string): void {
    const subs = this._remoteSubs.get(authority)
    if (subs) {
      for (const s of subs) this._store.delete(s)
      this._remoteSubs.delete(authority)
    }
    this._remoteServices.delete(authority)
    for (const [handle, a] of [...this._remoteByHandle]) {
      if (a !== authority) continue
      this._remoteByHandle.delete(handle)
      // The agent died with the connection but its exit status is unknowable —
      // a bare exit lets renderer sessions close instead of waiting forever.
      this._onExit.fire({ handle, code: null, signal: null })
    }
  }
}
