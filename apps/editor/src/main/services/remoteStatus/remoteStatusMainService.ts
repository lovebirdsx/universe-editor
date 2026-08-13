/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Thin, wire-ready facade over RemoteConnectionMainService. Tracks the latest
 *  per-authority state (from onDidChangeState) so getConnections() can answer
 *  without reaching into the connection manager's private entry table, and maps
 *  the internal state onto the shared DTO so the renderer never sees a
 *  main-internal type.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, Emitter, type Event } from '@universe-editor/platform'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'
import {
  IEnvironmentMainService,
  type EnvironmentMainService,
} from '../../environment/environmentMainService.js'
import {
  type IRemoteStatusService,
  type RemoteConnectionStatusDto,
} from '../../../shared/ipc/remoteStatusService.js'

export class RemoteStatusMainService extends Disposable implements IRemoteStatusService {
  declare readonly _serviceBrand: undefined

  private readonly _states = new Map<string, RemoteConnectionStatusDto>()
  private readonly _onDidChangeState = this._register(new Emitter<RemoteConnectionStatusDto>())
  readonly onDidChangeState: Event<RemoteConnectionStatusDto> = this._onDidChangeState.event

  constructor(
    @IRemoteConnectionService private readonly _remote: IRemoteConnectionService,
    @IEnvironmentMainService private readonly _environment: EnvironmentMainService,
  ) {
    super()
    this._register(
      this._remote.onDidChangeState((e) => {
        const dto: RemoteConnectionStatusDto = {
          authority: e.authority,
          state: e.state,
          ...(e.error !== undefined ? { errorMessage: e.error } : {}),
        }
        this._states.set(dto.authority, dto)
        this._onDidChangeState.fire(dto)
      }),
    )
  }

  async getConnections(): Promise<readonly RemoteConnectionStatusDto[]> {
    return [...this._states.values()]
  }

  async retryConnection(authority: string): Promise<void> {
    this._remote.retryConnection(authority)
  }

  async closeConnection(authority: string): Promise<void> {
    await this._remote.closeConnection(authority)
  }

  async stopServer(authority: string): Promise<void> {
    await this._remote.stopServer(authority)
  }

  async dropSocketForTesting(authority: string): Promise<void> {
    if (!this._environment.isE2E) {
      throw new Error('dropSocketForTesting is only available under UNIVERSE_E2E=1')
    }
    this._remote.dropSocketForTesting(authority)
  }
}
