/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Thin, wire-ready facade over RemoteConnectionMainService. Tracks the latest
 *  per-authority state (from onDidChangeState) so getConnections() can answer
 *  without reaching into the connection manager's private entry table, and maps
 *  the internal state onto the shared DTO so the renderer never sees a
 *  main-internal type.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  ILoggerService,
  createNamedLogger,
  type Event,
  type ILogger,
} from '@universe-editor/platform'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'
import { listSshHosts } from '../remote/sshConfig.js'
import { isWslAvailable, listWslDistros as enumerateWslDistros } from '../remote/wslTargets.js'
import {
  IEnvironmentMainService,
  type EnvironmentMainService,
} from '../../environment/environmentMainService.js'
import {
  type IRemoteStatusService,
  type RemoteConnectionStatusDto,
  type RemoteEnvironmentDto,
  type WslDistroDto,
} from '../../../shared/ipc/remoteStatusService.js'

/** Map the internal handshake environment onto the wire-ready DTO. */
function toEnvironmentDto(env: {
  readonly os: string
  readonly arch: string
  readonly homeDir: string
  readonly tmpDir: string
  readonly pathCaseSensitive: boolean
  readonly serverVersion: string
}): RemoteEnvironmentDto {
  return {
    os: env.os,
    arch: env.arch,
    homeDir: env.homeDir,
    tmpDir: env.tmpDir,
    pathCaseSensitive: env.pathCaseSensitive,
    serverVersion: env.serverVersion,
  }
}

/**
 * Host hook into window management, injected after WindowMainService exists:
 * lets stopServer close the windows scoped to an authority (running their
 * shutdown veto chain) before tearing the server down.
 */
export interface IRemoteWindowsParticipant {
  closeWindowsForRemoteAuthority(authority: string): Promise<boolean>
}

export class RemoteStatusMainService extends Disposable implements IRemoteStatusService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _states = new Map<string, RemoteConnectionStatusDto>()
  private readonly _onDidChangeState = this._register(new Emitter<RemoteConnectionStatusDto>())
  readonly onDidChangeState: Event<RemoteConnectionStatusDto> = this._onDidChangeState.event

  private _windowsParticipant: IRemoteWindowsParticipant | undefined

  constructor(
    @IRemoteConnectionService private readonly _remote: IRemoteConnectionService,
    @IEnvironmentMainService private readonly _environment: EnvironmentMainService,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'remoteStatus',
      name: 'Remote Status',
    })
    this._register(
      this._remote.onDidChangeState((e) => {
        const dto: RemoteConnectionStatusDto = {
          authority: e.authority,
          state: e.state,
          ...(e.error !== undefined ? { errorMessage: e.error } : {}),
          ...(e.progress !== undefined ? { progress: e.progress } : {}),
        }
        this._states.set(dto.authority, dto)
        this._onDidChangeState.fire(dto)
      }),
    )
  }

  async getConnections(): Promise<readonly RemoteConnectionStatusDto[]> {
    return [...this._states.values()]
  }

  async connect(authority: string): Promise<RemoteEnvironmentDto> {
    const connection = await this._remote.connect(authority)
    return toEnvironmentDto(connection.env)
  }

  async getEnvironment(authority: string): Promise<RemoteEnvironmentDto | null> {
    if (this._states.get(authority)?.state !== 'connected') return null
    try {
      const connection = await this._remote.getConnection(authority)
      return toEnvironmentDto(connection.env)
    } catch {
      // Connection dropped between the state check and the read — treat as not connected.
      return null
    }
  }

  async listSshHosts(): Promise<string[]> {
    return listSshHosts()
  }

  async listWslDistros(): Promise<readonly WslDistroDto[]> {
    if (!isWslAvailable()) return []
    return enumerateWslDistros()
  }

  async retryConnection(authority: string): Promise<void> {
    this._remote.retryConnection(authority)
  }

  async closeConnection(authority: string): Promise<void> {
    await this._remote.closeConnection(authority)
  }

  async closeRemoteWorkspace(authority: string): Promise<boolean> {
    if (this._windowsParticipant) {
      const proceed = await this._windowsParticipant.closeWindowsForRemoteAuthority(authority)
      if (!proceed) {
        this._logger.info(`[remote:${authority}] closeRemoteWorkspace vetoed; connection kept`)
        return false
      }
    }
    this._logger.info(`[remote:${authority}] closeRemoteWorkspace: disconnecting`)
    await this._remote.closeConnection(authority)
    return true
  }

  /** Wired from index.ts once WindowMainService exists (created after this service). */
  setWindowsParticipant(participant: IRemoteWindowsParticipant): void {
    this._windowsParticipant = participant
  }

  async stopServer(authority: string): Promise<boolean> {
    if (this._windowsParticipant) {
      const proceed = await this._windowsParticipant.closeWindowsForRemoteAuthority(authority)
      if (!proceed) return false
    }
    await this._remote.stopServer(authority)
    return true
  }

  async dropSocketForTesting(authority: string): Promise<void> {
    if (!this._environment.isE2E) {
      throw new Error('dropSocketForTesting is only available under UNIVERSE_E2E=1')
    }
    this._remote.dropSocketForTesting(authority)
  }

  async dropExtensionHostSocketForTesting(authority: string): Promise<void> {
    if (!this._environment.isE2E) {
      throw new Error('dropExtensionHostSocketForTesting is only available under UNIVERSE_E2E=1')
    }
    this._remote.dropExtensionHostSocketForTesting(authority)
  }
}
