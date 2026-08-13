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
  type IDisposable,
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

  private readonly _remoteServices = new Map<string, IAcpHostService>()
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
    for (const subs of this._remoteSubs.values()) {
      for (const s of subs) s.dispose()
    }
    this._remoteSubs.clear()
    this._remoteServices.clear()
    this._remoteByHandle.clear()
    super.dispose()
  }

  private async _remoteService(authority: string): Promise<IAcpHostService> {
    const cached = this._remoteServices.get(authority)
    if (cached) return cached
    if (!this._connections) {
      throw new Error('acpHost: remote connection service not available')
    }
    const conn = await this._connections.getConnection(authority)
    const service = ProxyChannel.toService<IAcpHostService>(conn.getChannel(RemoteChannels.AcpHost))
    this._remoteServices.set(authority, service)
    const subs: IDisposable[] = [
      service.onStdout((e) => this._onStdout.fire(e)),
      service.onStderr((e) => this._onStderr.fire(e)),
      service.onExit((e) => {
        this._remoteByHandle.delete(e.handle)
        this._onExit.fire(e)
      }),
    ]
    this._remoteSubs.set(authority, subs)
    return service
  }
}
