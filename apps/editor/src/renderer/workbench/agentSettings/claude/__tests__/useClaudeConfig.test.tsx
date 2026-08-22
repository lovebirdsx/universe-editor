/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useClaudeConfig.saveProfile: editing the in-use credential profile (e.g.
 *  rotating its key) must push the new values into settings.json immediately —
 *  previously the old key stayed in effect until the profile was switched away
 *  and back. Gateway profiles now reference a provider instance; applying one
 *  derives the env from that provider.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  Event,
  IAiModelService,
  INotificationService,
  InstantiationService,
  IStorageService,
  ServiceCollection,
  type AiProviderInstance,
  type AiProviderType,
  type IStorageService as IStorageServiceType,
} from '@universe-editor/platform'
import {
  IClaudeConfigService,
  type ClaudeCredentialProfile,
  type ClaudeSettings,
  type ClaudeSettingsPatch,
} from '../../../../../shared/ipc/claudeConfigService.js'
import { ServicesContext } from '../../../useService.js'
import { useClaudeConfig } from '../useClaudeConfig.js'

function makeStorage(): IStorageServiceType {
  const data = new Map<string, unknown>()
  return {
    _serviceBrand: undefined,
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined
    },
    async set(key: string, value: unknown) {
      data.set(key, value)
    },
    async remove(key: string) {
      data.delete(key)
    },
    onDidChangeWorkspaceScope: Event.None,
  }
}

function makeAiService(
  providers: readonly AiProviderInstance[],
  types: Readonly<Record<string, AiProviderType>>,
): IAiModelService {
  return {
    _serviceBrand: undefined,
    async getProviders() {
      return providers
    },
    async getProviderTypes() {
      return types
    },
  } as unknown as IAiModelService
}

function makeNotificationService(): INotificationService {
  return {
    _serviceBrand: undefined,
    notify: () => ({ dispose: () => {}, update: () => {} }),
  } as unknown as INotificationService
}

function makeClaudeService(initial: {
  settings: ClaudeSettings
  profiles: ClaudeCredentialProfile[]
}) {
  let settings = initial.settings
  let profiles = initial.profiles
  const patchCalls: ClaudeSettingsPatch[] = []
  const service = {
    _serviceBrand: undefined,
    async read(): Promise<ClaudeSettings> {
      return settings
    },
    async patch(p: ClaudeSettingsPatch): Promise<void> {
      patchCalls.push(p)
      let next = { ...settings }
      if (typeof p.model === 'string') next = { ...next, model: p.model }
      if (p.env) {
        const env = { ...(next.env ?? {}) }
        for (const [key, value] of Object.entries(p.env)) {
          if (value === null) delete env[key]
          else env[key] = value
        }
        next = { ...next, env }
      }
      settings = next
    },
    async configPath(): Promise<string> {
      return '/home/u/.claude/settings.json'
    },
    async readAuthStatus() {
      return { loggedIn: false, expired: false }
    },
    async readProfiles(): Promise<ClaudeCredentialProfile[]> {
      return profiles
    },
    async writeProfiles(next: ClaudeCredentialProfile[]): Promise<void> {
      profiles = next
    },
    async checkGatewayConnectivity(): Promise<boolean> {
      return true
    },
  } as unknown as IClaudeConfigService
  return {
    service,
    patchCalls,
    getSettings: () => settings,
  }
}

function setup(
  service: IClaudeConfigService,
  providers: readonly AiProviderInstance[] = [],
  types: Readonly<Record<string, AiProviderType>> = {},
) {
  const services = new ServiceCollection()
  services.set(IClaudeConfigService, service)
  services.set(IStorageService, makeStorage())
  services.set(IAiModelService, makeAiService(providers, types))
  services.set(INotificationService, makeNotificationService())
  const instantiation = new InstantiationService(services)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServicesContext.Provider value={instantiation}>{children}</ServicesContext.Provider>
  )
  return renderHook(() => useClaudeConfig(), { wrapper })
}

const GATEWAY_PROVIDER: AiProviderInstance = {
  name: 'gw',
  type: 'anthropic',
  apiKey: 'tok-1',
  baseUrl: 'https://gw.example.com',
}
const GATEWAY_TYPES: Readonly<Record<string, AiProviderType>> = {
  anthropic: { protocol: 'anthropic-messages' },
}

describe('useClaudeConfig.saveProfile', () => {
  afterEach(() => cleanup())

  it('re-applies the profile into settings.json when the in-use credential is edited', async () => {
    const { service, patchCalls } = makeClaudeService({
      settings: { env: { ANTHROPIC_API_KEY: 'sk-ant-old' } },
      profiles: [{ id: 'p1', label: 'Personal', kind: 'apiKey', apiKey: 'sk-ant-old' }],
    })
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.saveProfile({
        id: 'p1',
        label: 'Personal',
        kind: 'apiKey',
        apiKey: 'sk-ant-new',
      })
    })

    expect(patchCalls).toHaveLength(1)
    expect(result.current.settings.env?.['ANTHROPIC_API_KEY']).toBe('sk-ant-new')
  })

  it('re-applies a gateway profile, writing its derived token + base URL', async () => {
    const { service } = makeClaudeService({
      settings: {
        model: 'kimi-k3',
        env: {
          ANTHROPIC_AUTH_TOKEN: 'tok-1',
          ANTHROPIC_BASE_URL: 'https://gw.example.com',
        },
      },
      profiles: [
        {
          id: 'g1',
          label: 'Gateway',
          kind: 'gateway',
          providerRef: 'anthropic/gw',
          model: 'kimi-k3',
        },
      ],
    })
    const { result } = setup(service, [GATEWAY_PROVIDER], GATEWAY_TYPES)
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.saveProfile({
        id: 'g1',
        label: 'Gateway',
        kind: 'gateway',
        providerRef: 'anthropic/gw',
        model: 'kimi-k3',
      })
    })

    expect(result.current.settings.env?.['ANTHROPIC_AUTH_TOKEN']).toBe('tok-1')
    expect(result.current.settings.env?.['ANTHROPIC_BASE_URL']).toBe('https://gw.example.com')
    expect(result.current.settings.env?.['ANTHROPIC_API_KEY']).toBeUndefined()
  })

  it('does not touch settings.json when a non-active profile is edited', async () => {
    const { service, patchCalls } = makeClaudeService({
      settings: { env: { ANTHROPIC_API_KEY: 'sk-ant-active' } },
      profiles: [
        { id: 'p1', label: 'Active', kind: 'apiKey', apiKey: 'sk-ant-active' },
        { id: 'p2', label: 'Spare', kind: 'apiKey', apiKey: 'sk-ant-spare' },
      ],
    })
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.saveProfile({
        id: 'p2',
        label: 'Spare',
        kind: 'apiKey',
        apiKey: 'sk-ant-rotated',
      })
    })

    expect(patchCalls).toHaveLength(0)
    expect(result.current.settings.env?.['ANTHROPIC_API_KEY']).toBe('sk-ant-active')
    expect(result.current.profiles.find((p) => p.id === 'p2')?.apiKey).toBe('sk-ant-rotated')
  })

  it('does not re-apply when adding a brand-new profile', async () => {
    const { service, patchCalls } = makeClaudeService({
      settings: { env: { ANTHROPIC_API_KEY: 'sk-ant-active' } },
      profiles: [{ id: 'p1', label: 'Active', kind: 'apiKey', apiKey: 'sk-ant-active' }],
    })
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.saveProfile({
        id: 'p-new',
        label: 'New',
        kind: 'apiKey',
        apiKey: 'sk-ant-new',
      })
    })

    expect(patchCalls).toHaveLength(0)
    expect(result.current.profiles).toHaveLength(2)
  })
})
