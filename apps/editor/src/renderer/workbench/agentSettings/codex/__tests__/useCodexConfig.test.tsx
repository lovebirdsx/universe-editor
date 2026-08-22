/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useCodexConfig.saveProfile: editing the in-use credential profile (e.g.
 *  rotating its key) must re-apply it so auth.json / config.toml pick up the
 *  new key immediately — previously the old credential stayed in effect until
 *  the profile was switched away and back. Gateway profiles now reference a
 *  provider instance; applying one derives the credential from that provider.
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
  ICodexConfigService,
  type CodexAuthStatus,
  type CodexCredentialIntent,
  type CodexCredentialProfile,
  type CodexSettings,
} from '../../../../../shared/ipc/codexConfigService.js'
import {
  deriveCodexProvider,
  resolveProviderRef,
} from '../../../../../shared/ai/providerDerivation.js'
import { ServicesContext } from '../../../useService.js'
import { useCodexConfig } from '../useCodexConfig.js'

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

/**
 * In-memory mirror of the main-process service: auth.json reduces to a single
 * API key, config.toml to an optional gateway provider, and matchActiveProfile
 * re-derives the active profile from both (resolving a gateway profile's
 * providerRef), like CodexConfigMainService does.
 */
function makeCodexService(
  initial: {
    apiKey?: string
    gateway?: { baseUrl: string; token: string }
    profiles: CodexCredentialProfile[]
  },
  providers: readonly AiProviderInstance[],
  types: Readonly<Record<string, AiProviderType>>,
) {
  let authKey = initial.apiKey
  let gateway = initial.gateway
  let profiles = initial.profiles
  const intents: CodexCredentialIntent[] = []
  const authStatus = (): CodexAuthStatus => ({
    active: authKey ? 'apiKey' : 'none',
    hasApiKey: authKey !== undefined,
  })
  const service = {
    _serviceBrand: undefined,
    onDidChangeAuth: Event.None,
    async read(): Promise<CodexSettings> {
      return {}
    },
    async patch(): Promise<void> {},
    async applyCredential(intent: CodexCredentialIntent): Promise<CodexAuthStatus> {
      intents.push(intent)
      if (intent.kind === 'apiKey') {
        authKey = intent.apiKey
        gateway = undefined
      } else if (intent.kind === 'gateway') {
        gateway = { baseUrl: intent.baseUrl, token: intent.apiKey }
        authKey = undefined
      } else {
        authKey = undefined
        gateway = undefined
      }
      return authStatus()
    },
    async configPath(): Promise<string> {
      return '/home/u/.codex/config.toml'
    },
    async readAuthStatus(): Promise<CodexAuthStatus> {
      return authStatus()
    },
    async readProfiles(): Promise<CodexCredentialProfile[]> {
      return profiles
    },
    async writeProfiles(next: CodexCredentialProfile[]): Promise<void> {
      profiles = next
    },
    async matchActiveProfile(): Promise<string | undefined> {
      const gw = gateway
      if (gw) {
        return profiles.find((p) => {
          if (p.kind !== 'gateway' || p.providerRef === undefined) return false
          const resolved = resolveProviderRef(p.providerRef, providers, types)
          if (resolved === undefined) return false
          const derived = deriveCodexProvider(resolved.instance, resolved.type)
          return (
            derived !== undefined && derived.baseUrl === gw.baseUrl && derived.apiKey === gw.token
          )
        })?.id
      }
      if (authKey === undefined) return undefined
      return profiles.find((p) => p.kind === 'apiKey' && p.apiKey === authKey)?.id
    },
    async checkGatewayConnectivity(): Promise<boolean> {
      return true
    },
  } as unknown as ICodexConfigService
  return { service, intents }
}

function setup(
  service: ICodexConfigService,
  providers: readonly AiProviderInstance[] = [],
  types: Readonly<Record<string, AiProviderType>> = {},
) {
  const services = new ServiceCollection()
  services.set(ICodexConfigService, service)
  services.set(IStorageService, makeStorage())
  services.set(IAiModelService, makeAiService(providers, types))
  services.set(INotificationService, makeNotificationService())
  const instantiation = new InstantiationService(services)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServicesContext.Provider value={instantiation}>{children}</ServicesContext.Provider>
  )
  return renderHook(() => useCodexConfig(), { wrapper })
}

const GATEWAY_PROVIDER: AiProviderInstance = {
  name: 'gw',
  type: 'openai',
  apiKey: 'tok-1',
  baseUrl: 'https://gw.example.com',
}
const GATEWAY_TYPES: Readonly<Record<string, AiProviderType>> = {
  openai: { protocol: 'openai-chat' },
}

describe('useCodexConfig.saveProfile', () => {
  afterEach(() => cleanup())

  it('re-applies the profile when the in-use API key is rotated', async () => {
    const { service, intents } = makeCodexService(
      {
        apiKey: 'sk-old',
        profiles: [{ id: 'p1', label: 'OpenAI', kind: 'apiKey', apiKey: 'sk-old' }],
      },
      [],
      {},
    )
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.activeProfileId).toBe('p1')

    await act(async () => {
      await result.current.saveProfile({
        id: 'p1',
        label: 'OpenAI',
        kind: 'apiKey',
        apiKey: 'sk-new',
      })
    })

    expect(intents).toEqual([{ kind: 'apiKey', apiKey: 'sk-new' }])
    expect(result.current.activeProfileId).toBe('p1')
  })

  it('re-applies the profile when the in-use gateway is edited', async () => {
    const { service, intents } = makeCodexService(
      {
        gateway: { baseUrl: 'https://gw.example.com', token: 'tok-1' },
        profiles: [{ id: 'g1', label: 'Gateway', kind: 'gateway', providerRef: 'openai/gw' }],
      },
      [GATEWAY_PROVIDER],
      GATEWAY_TYPES,
    )
    const { result } = setup(service, [GATEWAY_PROVIDER], GATEWAY_TYPES)
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.activeProfileId).toBe('g1')

    await act(async () => {
      await result.current.saveProfile({
        id: 'g1',
        label: 'Gateway',
        kind: 'gateway',
        providerRef: 'openai/gw',
      })
    })

    expect(intents).toEqual([
      {
        kind: 'gateway',
        baseUrl: 'https://gw.example.com',
        apiKey: 'tok-1',
        providerName: 'gw',
      },
    ])
    expect(result.current.activeProfileId).toBe('g1')
  })

  it('does not apply anything when a non-active profile is edited', async () => {
    const { service, intents } = makeCodexService(
      {
        apiKey: 'sk-active',
        profiles: [
          { id: 'p1', label: 'Active', kind: 'apiKey', apiKey: 'sk-active' },
          { id: 'p2', label: 'Spare', kind: 'apiKey', apiKey: 'sk-spare' },
        ],
      },
      [],
      {},
    )
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.saveProfile({
        id: 'p2',
        label: 'Spare',
        kind: 'apiKey',
        apiKey: 'sk-rotated',
      })
    })

    expect(intents).toEqual([])
    expect(result.current.activeProfileId).toBe('p1')
    expect(result.current.profiles.find((p) => p.id === 'p2')?.apiKey).toBe('sk-rotated')
  })

  it('does not apply anything when adding a brand-new profile', async () => {
    const { service, intents } = makeCodexService(
      {
        apiKey: 'sk-active',
        profiles: [{ id: 'p1', label: 'Active', kind: 'apiKey', apiKey: 'sk-active' }],
      },
      [],
      {},
    )
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.saveProfile({
        id: 'p-new',
        label: 'New',
        kind: 'apiKey',
        apiKey: 'sk-new',
      })
    })

    expect(intents).toEqual([])
    expect(result.current.activeProfileId).toBe('p1')
    expect(result.current.profiles).toHaveLength(2)
  })
})
