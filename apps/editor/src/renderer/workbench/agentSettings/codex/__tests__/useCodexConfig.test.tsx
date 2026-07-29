/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useCodexConfig.saveProfile: editing the in-use credential profile (e.g.
 *  rotating its key) must re-apply it so auth.json / config.toml pick up the
 *  new key immediately — previously the old credential stayed in effect until
 *  the profile was switched away and back.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  Event,
  InstantiationService,
  IStorageService,
  ServiceCollection,
  type IStorageService as IStorageServiceType,
} from '@universe-editor/platform'
import {
  ICodexConfigService,
  type CodexAuthStatus,
  type CodexCredentialIntent,
  type CodexCredentialProfile,
  type CodexSettings,
} from '../../../../../shared/ipc/codexConfigService.js'
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

/**
 * In-memory mirror of the main-process service: auth.json reduces to a single
 * API key, config.toml to an optional gateway provider, and matchActiveProfile
 * re-derives the active profile from both, like CodexConfigMainService does.
 */
function makeCodexService(initial: {
  apiKey?: string
  gateway?: { baseUrl: string; token: string }
  profiles: CodexCredentialProfile[]
}) {
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
        return profiles.find(
          (p) => p.kind === 'gateway' && p.baseUrl === gw.baseUrl && p.apiKey === gw.token,
        )?.id
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

function setup(service: ICodexConfigService) {
  const services = new ServiceCollection()
  services.set(ICodexConfigService, service)
  services.set(IStorageService, makeStorage())
  const instantiation = new InstantiationService(services)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServicesContext.Provider value={instantiation}>{children}</ServicesContext.Provider>
  )
  return renderHook(() => useCodexConfig(), { wrapper })
}

describe('useCodexConfig.saveProfile', () => {
  afterEach(() => cleanup())

  it('re-applies the profile when the in-use API key is rotated', async () => {
    const { service, intents } = makeCodexService({
      apiKey: 'sk-old',
      profiles: [{ id: 'p1', label: 'OpenAI', kind: 'apiKey', apiKey: 'sk-old' }],
    })
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

  it('re-applies the profile when the in-use gateway token is rotated', async () => {
    const { service, intents } = makeCodexService({
      gateway: { baseUrl: 'https://gw.example.com', token: 'tok-old' },
      profiles: [
        {
          id: 'g1',
          label: 'Gateway',
          kind: 'gateway',
          baseUrl: 'https://gw.example.com',
          apiKey: 'tok-old',
        },
      ],
    })
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.activeProfileId).toBe('g1')

    await act(async () => {
      await result.current.saveProfile({
        id: 'g1',
        label: 'Gateway',
        kind: 'gateway',
        baseUrl: 'https://gw.example.com',
        apiKey: 'tok-new',
      })
    })

    expect(intents).toEqual([
      {
        kind: 'gateway',
        baseUrl: 'https://gw.example.com',
        apiKey: 'tok-new',
        providerName: 'Gateway',
      },
    ])
    expect(result.current.activeProfileId).toBe('g1')
  })

  it('does not apply anything when a non-active profile is edited', async () => {
    const { service, intents } = makeCodexService({
      apiKey: 'sk-active',
      profiles: [
        { id: 'p1', label: 'Active', kind: 'apiKey', apiKey: 'sk-active' },
        { id: 'p2', label: 'Spare', kind: 'apiKey', apiKey: 'sk-spare' },
      ],
    })
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
    const { service, intents } = makeCodexService({
      apiKey: 'sk-active',
      profiles: [{ id: 'p1', label: 'Active', kind: 'apiKey', apiKey: 'sk-active' }],
    })
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
