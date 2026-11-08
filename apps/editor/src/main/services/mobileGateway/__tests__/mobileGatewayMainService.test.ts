/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MobileGatewayMainService config ownership: machine-local gateway.json,
 *  patch writes, external edits and the old settings.json keys staying inert.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MOBILE_GATEWAY_CONFIG } from '../../../../shared/ipc/mobileGatewayService.js'
import type { MobileGatewayConfigState } from '../../../../shared/ipc/mobileGatewayService.js'
import type { RecentWorkspacesMainService } from '../../workspace/recentWorkspacesMainService.js'

const electronState = vi.hoisted(() => ({ userDataDir: '' }))

vi.mock('electron', async () => {
  const { mkTempDir } = await import('@universe-editor/temp-root')
  electronState.userDataDir = mkTempDir('universe-gateway-main-')
  return {
    app: {
      getPath: (name: string) => {
        if (name === 'userData') return electronState.userDataDir
        return electronState.userDataDir
      },
      getAppPath: () => process.cwd(),
      isPackaged: false,
      getVersion: () => '0.0.0-test',
    },
    BrowserWindow: { getFocusedWindow: () => null },
  }
})

const { MobileGatewayMainService } = await import('../mobileGatewayMainService.js')

const services: InstanceType<typeof MobileGatewayMainService>[] = []

function createService(): InstanceType<typeof MobileGatewayMainService> {
  const service = new MobileGatewayMainService({
    getRecent: vi.fn(async () => []),
  } as unknown as RecentWorkspacesMainService)
  services.push(service)
  return service
}

function gatewayFile(): string {
  return join(electronState.userDataDir, 'mobile', 'gateway.json')
}

function nextConfigEvent(
  service: InstanceType<typeof MobileGatewayMainService>,
): Promise<MobileGatewayConfigState> {
  return new Promise((resolve) => {
    const subscription = service.onDidChangeConfig((state) => {
      subscription.dispose()
      resolve(state)
    })
  })
}

async function waitForWatcher(): Promise<void> {
  await mkdir(join(electronState.userDataDir, 'mobile'), { recursive: true })
  // The store attaches its watcher asynchronously in the constructor.
  await new Promise((resolve) => setTimeout(resolve, 100))
}

afterEach(() => {
  for (const service of services.splice(0)) service.dispose()
})

beforeEach(async () => {
  await rm(gatewayFile(), { force: true })
  await writeFile(join(electronState.userDataDir, 'settings.json'), '{}\n', 'utf8')
})

describe('MobileGatewayMainService config', () => {
  it('defaults to a disabled gateway when gateway.json is missing', async () => {
    const service = createService()
    await expect(service.getConfig()).resolves.toEqual({
      config: DEFAULT_MOBILE_GATEWAY_CONFIG,
    })
  })

  it('persists a patch to the machine-local file and applies it', async () => {
    const service = createService()
    await service.getConfig()

    const result = await service.updateConfig({ port: 48000, bind: 'lan' })
    expect(result.ok).toBe(true)
    await expect(readFile(gatewayFile(), 'utf8')).resolves.toContain('"port": 48000')
    await expect(service.getConfig()).resolves.toEqual({
      config: { ...DEFAULT_MOBILE_GATEWAY_CONFIG, port: 48000, bind: 'lan' },
    })
  })

  it('rejects an invalid patch without writing the file', async () => {
    const service = createService()
    await service.getConfig()

    const result = await service.updateConfig({ port: 0 })
    expect(result.ok).toBe(false)
    await expect(readFile(gatewayFile(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('ignores the legacy mobileGateway.* keys in settings.json', async () => {
    await writeFile(
      join(electronState.userDataDir, 'settings.json'),
      JSON.stringify({ 'mobileGateway.enabled': true, 'mobileGateway.bind': 'lan' }),
      'utf8',
    )

    const service = createService()
    await expect(service.getConfig()).resolves.toEqual({
      config: DEFAULT_MOBILE_GATEWAY_CONFIG,
    })
  })

  it('applies an external edit of gateway.json', async () => {
    const service = createService()
    await service.getConfig()
    await waitForWatcher()

    const event = nextConfigEvent(service)
    await writeFile(
      gatewayFile(),
      JSON.stringify({ ...DEFAULT_MOBILE_GATEWAY_CONFIG, port: 48001 }),
      'utf8',
    )

    const state = await event
    expect(state.config.port).toBe(48001)
    await expect(service.getConfig()).resolves.toEqual(state)
  })

  it('keeps the last valid config when an external edit is invalid', async () => {
    const service = createService()
    await service.getConfig()
    await waitForWatcher()

    const event = nextConfigEvent(service)
    await writeFile(gatewayFile(), '{ "port": 0 }', 'utf8')

    const state = await event
    expect(state.config).toEqual(DEFAULT_MOBILE_GATEWAY_CONFIG)
    expect(state.error).toContain('"port"')
  })

  it('exposes the machine-local config file URI and creates it on demand', async () => {
    const service = createService()
    await service.getConfig()

    await expect(service.getConfigFileUri()).resolves.toContain('/mobile/gateway.json')
    await expect(readFile(gatewayFile(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const uri = await service.ensureConfigFile()
    expect(uri).toContain('/mobile/gateway.json')
    expect(JSON.parse(await readFile(gatewayFile(), 'utf8'))).toEqual(DEFAULT_MOBILE_GATEWAY_CONFIG)
  })
})
