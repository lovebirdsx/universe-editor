/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExtensionMcpServersService — contribution intake, whenReady (execPath
 *  snapshot), change-only onDidChange, and self-driven recompute on
 *  configuration / workspace-trust changes (a trust grant does not re-emit
 *  contributions, so the service must recompute on its own).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  ConfigurationService,
  ConfigurationTarget,
  Emitter,
  Event,
  LogLevel,
  NullLogger,
  type ILogger,
  type ILoggerService,
  type IWorkspaceTrustManagementService,
} from '@universe-editor/platform'
import type { IExtensionDescriptionDto } from '@universe-editor/extensions-common'
import type {
  IEnvironmentSnapshot,
  IEnvironmentSnapshotService,
} from '../../../../shared/ipc/environmentSnapshotService.js'
import { ExtensionMcpServersService } from '../extensionMcpServersService.js'

class StubLoggerService implements ILoggerService {
  declare readonly _serviceBrand: undefined
  createLogger(): ILogger {
    return new NullLogger()
  }
  setLevel(): void {}
  getLevel(): LogLevel {
    return LogLevel.Info
  }
}

class FakeTrustService implements IWorkspaceTrustManagementService {
  declare readonly _serviceBrand: undefined
  private readonly _onDidChangeTrust = new Emitter<boolean>()
  readonly onDidChangeTrust = this._onDidChangeTrust.event
  readonly onDidChangeTrustedFolders = Event.None
  readonly workspaceTrustInitialized = Promise.resolve()
  private _trusted = true
  isWorkspaceTrusted(): boolean {
    return this._trusted
  }
  setTrusted(trusted: boolean): void {
    this._trusted = trusted
    this._onDidChangeTrust.fire(trusted)
  }
  canSetWorkspaceTrust(): boolean {
    return true
  }
  async setWorkspaceTrust(): Promise<void> {}
  getUriTrustInfo(): never {
    throw new Error('not implemented')
  }
  async setUrisTrust(): Promise<void> {}
  getTrustedUris(): never[] {
    return []
  }
  async setTrustedUris(): Promise<void> {}
  addWorkspaceTrustTransitionParticipant(): never {
    throw new Error('not implemented')
  }
}

function makeEnvSnapshot(
  overrides: Partial<{ execPath: string; fail: boolean }> = {},
): IEnvironmentSnapshotService {
  return {
    async getSnapshot(): Promise<IEnvironmentSnapshot> {
      if (overrides.fail) throw new Error('ipc down')
      return {
        userHome: '/home/u',
        cwd: '/',
        execPath: overrides.execPath ?? 'C:/app/editor.exe',
        userDataDir: '/data/u',
        appResourcesPath: undefined,
        env: {},
      }
    },
  } as IEnvironmentSnapshotService
}

function makeExt(overrides: Partial<IExtensionDescriptionDto> = {}): IExtensionDescriptionDto {
  return {
    id: 'pub.ext',
    name: 'ext',
    activationEvents: [],
    contributes: {
      mcpServers: { bridge: { command: '${execPath}', whenConfiguration: 'bridge.enabled' } },
    },
    hasMain: false,
    extensionLocation: '/exts/bridge',
    extensionIsBuiltin: false,
    ...overrides,
  }
}

async function makeService(overrides: Partial<{ execPath: string; fail: boolean }> = {}): Promise<{
  service: ExtensionMcpServersService
  config: ConfigurationService
  trust: FakeTrustService
}> {
  const config = new ConfigurationService()
  const trust = new FakeTrustService()
  const service = new ExtensionMcpServersService(
    config,
    trust,
    makeEnvSnapshot(overrides),
    new StubLoggerService(),
  )
  await service.whenReady
  return { service, config, trust }
}

describe('ExtensionMcpServersService', () => {
  it('resolves contributions into rawRecord after whenReady', async () => {
    const { service } = await makeService()
    service.setContributions([makeExt()])
    expect(service.rawRecord).toEqual({ bridge: { command: 'C:/app/editor.exe' } })
    service.dispose()
  })

  it('whenReady gates resolution on the execPath snapshot', async () => {
    const config = new ConfigurationService()
    const trust = new FakeTrustService()
    let release!: (snap: IEnvironmentSnapshot) => void
    const gated: IEnvironmentSnapshotService = {
      getSnapshot: () =>
        new Promise<IEnvironmentSnapshot>((resolve) => {
          release = resolve
        }),
    } as IEnvironmentSnapshotService
    const service = new ExtensionMcpServersService(config, trust, gated, new StubLoggerService())
    service.setContributions([makeExt()])
    expect(service.rawRecord).toEqual({})
    release({
      userHome: '/h',
      cwd: '/',
      execPath: '/app/e',
      userDataDir: '/data',
      appResourcesPath: undefined,
      env: {},
    })
    await service.whenReady
    expect(service.rawRecord).toEqual({ bridge: { command: '/app/e' } })
    service.dispose()
  })

  it('degrades to an empty execPath when the snapshot fails, without blocking', async () => {
    const { service } = await makeService({ fail: true })
    service.setContributions([makeExt()])
    expect(service.rawRecord).toEqual({ bridge: { command: '' } })
    service.dispose()
  })

  it('fires onDidChange only when the resolved record actually changed', async () => {
    const { service } = await makeService()
    const fired = vi.fn()
    service.onDidChange(fired)
    service.setContributions([makeExt()])
    expect(fired).toHaveBeenCalledTimes(1)
    service.setContributions([makeExt()])
    expect(fired).toHaveBeenCalledTimes(1)
    service.setContributions([])
    expect(fired).toHaveBeenCalledTimes(2)
    expect(service.rawRecord).toEqual({})
    service.dispose()
  })

  it('recomputes when a whenConfiguration gate key changes', async () => {
    const { service, config } = await makeService()
    service.setContributions([makeExt()])
    expect(Object.keys(service.rawRecord)).toEqual(['bridge'])

    config.update('bridge.enabled', false, ConfigurationTarget.User)
    expect(service.rawRecord).toEqual({})

    config.update('bridge.enabled', true, ConfigurationTarget.User)
    expect(Object.keys(service.rawRecord)).toEqual(['bridge'])
    service.dispose()
  })

  it('ignores configuration changes outside the gate keys', async () => {
    const { service, config } = await makeService()
    service.setContributions([makeExt()])
    const fired = vi.fn()
    service.onDidChange(fired)
    config.update('editor.fontSize', 13, ConfigurationTarget.User)
    expect(fired).not.toHaveBeenCalled()
    service.dispose()
  })

  it('recomputes when workspace trust flips (grant does not re-emit contributions)', async () => {
    const { service, trust } = await makeService()
    trust.setTrusted(false)
    service.setContributions([
      makeExt({
        contributes: { mcpServers: { bridge: { command: '${execPath}' } } },
        untrustedWorkspaces: { supported: false, description: 'needs trust' },
      }),
    ])
    expect(service.rawRecord).toEqual({})

    trust.setTrusted(true)
    expect(Object.keys(service.rawRecord)).toEqual(['bridge'])
    service.dispose()
  })
})
