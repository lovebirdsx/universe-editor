/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side ACP terminal pool — a thin shell over the Electron-free
 *  AcpTerminalService core in node-services. Routes each terminal to the host
 *  that runs it: `spec.authority` → the server's AcpTerminal channel for that
 *  authority; otherwise the local core. Terminal ids are opaque UUIDs produced
 *  by whichever host spawns, so they pass through un-rewritten.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  ILoggerService,
  ProxyChannel,
  RemoteChannels,
  type IDisposable,
} from '@universe-editor/platform'
import { AcpTerminalService, type AcpTerminalSpawner } from '@universe-editor/node-services'
import type {
  AcpTerminalCreatedInfo,
  AcpTerminalCreateSpec,
  AcpTerminalOutput,
  AcpTerminalWaitExit,
  IAcpTerminalService,
} from '@universe-editor/platform'
import { processRoleRegistry } from '../process/processRoleRegistry.js'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'

export type { AcpTerminalSpawner }

export class AcpTerminalMainService extends Disposable implements IAcpTerminalService {
  declare readonly _serviceBrand: undefined

  private readonly _local: AcpTerminalService

  private readonly _remoteServices = new Map<string, IAcpTerminalService>()
  private readonly _remoteSubs = new Map<string, IDisposable[]>()
  /** terminalId → authority (remote terminals only). */
  private readonly _remoteByTerminal = new Map<string, string>()

  constructor(
    spawn?: AcpTerminalSpawner,
    @ILoggerService loggerService?: ILoggerService,
    @IRemoteConnectionService private readonly _connections?: IRemoteConnectionService,
  ) {
    super()
    this._local = this._register(
      new AcpTerminalService({
        ...(spawn !== undefined ? { spawn } : {}),
        ...(loggerService !== undefined ? { logger: loggerService } : {}),
        onSpawned: (pid, label) =>
          processRoleRegistry.register(pid, { role: 'acp-terminal', label }),
      }),
    )
  }

  async create(spec: AcpTerminalCreateSpec): Promise<AcpTerminalCreatedInfo> {
    if (spec.authority) {
      const service = await this._remoteService(spec.authority)
      const { authority: _authority, ...rest } = spec
      const result = await service.create(rest)
      this._remoteByTerminal.set(result.terminalId, spec.authority)
      return result
    }
    return this._local.create(spec)
  }

  output(terminalId: string): Promise<AcpTerminalOutput> {
    const authority = this._remoteByTerminal.get(terminalId)
    if (authority) {
      const service = this._remoteServices.get(authority)
      return service
        ? service.output(terminalId)
        : Promise.reject(new Error(`AcpTerminal: unknown terminal ${terminalId}`))
    }
    return this._local.output(terminalId)
  }

  waitForExit(terminalId: string): Promise<AcpTerminalWaitExit> {
    const authority = this._remoteByTerminal.get(terminalId)
    if (authority) {
      const service = this._remoteServices.get(authority)
      return service
        ? service.waitForExit(terminalId)
        : Promise.reject(new Error(`AcpTerminal: unknown terminal ${terminalId}`))
    }
    return this._local.waitForExit(terminalId)
  }

  kill(terminalId: string): Promise<void> {
    const authority = this._remoteByTerminal.get(terminalId)
    if (authority) {
      const service = this._remoteServices.get(authority)
      return service ? service.kill(terminalId) : Promise.resolve()
    }
    return this._local.kill(terminalId)
  }

  release(terminalId: string): Promise<void> {
    const authority = this._remoteByTerminal.get(terminalId)
    if (authority) {
      this._remoteByTerminal.delete(terminalId)
      const service = this._remoteServices.get(authority)
      return service ? service.release(terminalId) : Promise.resolve()
    }
    return this._local.release(terminalId)
  }

  override dispose(): void {
    for (const subs of this._remoteSubs.values()) {
      for (const s of subs) s.dispose()
    }
    this._remoteSubs.clear()
    this._remoteServices.clear()
    this._remoteByTerminal.clear()
    super.dispose()
  }

  private async _remoteService(authority: string): Promise<IAcpTerminalService> {
    const cached = this._remoteServices.get(authority)
    if (cached) return cached
    if (!this._connections) {
      throw new Error('acpTerminal: remote connection service not available')
    }
    const conn = await this._connections.getConnection(authority)
    const service = ProxyChannel.toService<IAcpTerminalService>(
      conn.getChannel(RemoteChannels.AcpTerminal),
    )
    this._remoteServices.set(authority, service)
    this._remoteSubs.set(authority, [])
    return service
  }
}
