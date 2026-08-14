/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/remote/RemoteExplorerService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { Emitter, type IStorageService } from '@universe-editor/platform'
import type {
  IRemoteStatusService,
  RemoteConnectionStatusDto,
  WslDistroDto,
} from '../../../../shared/ipc/remoteStatusService.js'
import { RemoteExplorerService } from '../RemoteExplorerService.js'

function distro(name: string, over: Partial<WslDistroDto> = {}): WslDistroDto {
  return { name, isDefault: false, isRunning: false, version: 2, ...over }
}

interface RemoteStatusStubConfig {
  hosts?: readonly string[]
  connections?: readonly RemoteConnectionStatusDto[]
  wslDistros?: readonly WslDistroDto[]
  wslError?: Error
}

function makeRemoteStatusStub(cfg: RemoteStatusStubConfig = {}): IRemoteStatusService {
  const emitter = new Emitter<RemoteConnectionStatusDto>()
  return {
    listSshHosts: () => Promise.resolve([...(cfg.hosts ?? [])]),
    getConnections: () => Promise.resolve(cfg.connections ?? []),
    listWslDistros: () =>
      cfg.wslError ? Promise.reject(cfg.wslError) : Promise.resolve(cfg.wslDistros ?? []),
    onDidChangeState: emitter.event,
  } as unknown as IRemoteStatusService
}

function makeStorageStub(): IStorageService {
  const store = new Map<string, unknown>()
  return {
    get: (key: string) => Promise.resolve(store.get(key)),
    set: (key: string, value: unknown) => {
      store.set(key, value)
      return Promise.resolve()
    },
  } as unknown as IStorageService
}

describe('RemoteExplorerService', () => {
  it('refresh fills wslDistros preserving the facade order', async () => {
    const service = new RemoteExplorerService(
      makeRemoteStatusStub({
        wslDistros: [distro('Ubuntu', { isDefault: true, isRunning: true }), distro('Debian')],
      }),
      makeStorageStub(),
    )
    await service.refresh()
    expect(service.wslDistros.get().map((d) => d.name)).toEqual(['Ubuntu', 'Debian'])
    expect(service.wslDistros.get()[0]?.isDefault).toBe(true)
  })

  it('refresh filters out distros with unsafe names', async () => {
    const service = new RemoteExplorerService(
      makeRemoteStatusStub({
        wslDistros: [distro('Ubuntu-22.04'), distro('bad name$(rm)'), distro('openSUSE_Leap')],
      }),
      makeStorageStub(),
    )
    await service.refresh()
    expect(service.wslDistros.get().map((d) => d.name)).toEqual(['Ubuntu-22.04', 'openSUSE_Leap'])
  })

  it('refresh falls back to an empty wsl list when the facade rejects', async () => {
    const service = new RemoteExplorerService(
      makeRemoteStatusStub({ hosts: ['alpha'], wslError: new Error('wsl.exe missing') }),
      makeStorageStub(),
    )
    await service.refresh()
    expect(service.wslDistros.get()).toEqual([])
    expect(service.sshTargets.get().map((t) => t.host)).toEqual(['alpha'])
  })

  it('refresh clears previously published distros when they disappear', async () => {
    const remoteStatus = makeRemoteStatusStub({ wslDistros: [distro('Ubuntu')] })
    const service = new RemoteExplorerService(remoteStatus, makeStorageStub())
    await service.refresh()
    expect(service.wslDistros.get()).toHaveLength(1)
    ;(
      remoteStatus as unknown as { listWslDistros: () => Promise<readonly WslDistroDto[]> }
    ).listWslDistros = () => Promise.resolve([])
    await service.refresh()
    expect(service.wslDistros.get()).toEqual([])
  })
})
