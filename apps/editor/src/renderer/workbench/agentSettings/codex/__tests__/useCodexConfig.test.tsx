/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useCodexConfig: applyAuthentication drives the matching applyCredential
 *  intent (self-contained gateway, or ChatGPT login); setModel writes
 *  config.toml. activeAuth is re-read from disk, and onDidChangeAuth also
 *  refreshes the settings snapshot (the watch covers config.toml too).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  Emitter,
  IAiModelService,
  INotificationService,
  InstantiationService,
  ServiceCollection,
  type AiProviderEntry,
} from '@universe-editor/platform'
import {
  ICodexConfigService,
  type CodexAuthStatus,
  type CodexCredentialIntent,
  type CodexSettings,
  type CodexSettingsPatch,
} from '../../../../../shared/ipc/codexConfigService.js'
import { AGENT_SUBSCRIPTION_AUTH } from '../../../../../shared/ipc/claudeConfigService.js'
import type { AgentActiveAuth } from '../../../../../shared/ai/agentActiveAuth.js'
import { ServicesContext } from '../../../useService.js'
import { useCodexConfig } from '../useCodexConfig.js'

function makeAiService(entries: readonly AiProviderEntry[]): IAiModelService {
  return {
    _serviceBrand: undefined,
    async getProviders() {
      return entries
    },
    async getModelKnowledge() {
      return {}
    },
  } as unknown as IAiModelService
}

function makeNotificationService(): INotificationService {
  return {
    _serviceBrand: undefined,
    notify: () => ({ dispose: () => {}, update: () => {} }),
  } as unknown as INotificationService
}

const LOGGED_OUT: CodexAuthStatus = { active: 'none', hasApiKey: false }

function makeCodexService(initial: { activeAuth: AgentActiveAuth }) {
  let settings: CodexSettings = {}
  let activeAuth = initial.activeAuth
  const intents: CodexCredentialIntent[] = []
  const patchCalls: CodexSettingsPatch[] = []
  const onDidChangeAuth = new Emitter<void>()
  const service = {
    _serviceBrand: undefined,
    onDidChangeAuth: onDidChangeAuth.event,
    async read(): Promise<CodexSettings> {
      return settings
    },
    async patch(p: CodexSettingsPatch): Promise<void> {
      patchCalls.push(p)
      if (typeof p.model === 'string') settings = { ...settings, model: p.model }
      else if (p.model === null) delete settings.model
    },
    async applyCredential(intent: CodexCredentialIntent): Promise<CodexAuthStatus> {
      intents.push(intent)
      if (intent.kind === 'gateway') {
        activeAuth = { kind: 'provider', providerId: 'gw' }
      } else if (intent.kind === 'chatgpt') {
        activeAuth = { kind: 'subscription' }
      } else {
        activeAuth = { kind: 'none' }
      }
      return LOGGED_OUT
    },
    async configPath(): Promise<string> {
      return '/home/u/.codex/config.toml'
    },
    async readAuthStatus(): Promise<CodexAuthStatus> {
      return LOGGED_OUT
    },
    async resolveActiveAuth(): Promise<AgentActiveAuth> {
      return activeAuth
    },
    async checkGatewayConnectivity(): Promise<boolean> {
      return true
    },
  } as unknown as ICodexConfigService
  return {
    service,
    intents,
    patchCalls,
    onDidChangeAuth,
    setOnDisk: (next: CodexSettings) => {
      settings = next
    },
    setActiveAuthOnDisk: (next: AgentActiveAuth) => {
      activeAuth = next
    },
  }
}

function setup(service: ICodexConfigService, entries: readonly AiProviderEntry[] = []) {
  const services = new ServiceCollection()
  services.set(ICodexConfigService, service)
  services.set(IAiModelService, makeAiService(entries))
  services.set(INotificationService, makeNotificationService())
  const instantiation = new InstantiationService(services)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServicesContext.Provider value={instantiation}>{children}</ServicesContext.Provider>
  )
  return renderHook(() => useCodexConfig(), { wrapper })
}

const GATEWAY_ENTRY: AiProviderEntry = {
  id: 'gw',
  apiKey: 'tok-1',
  baseUrl: 'https://gw.example.com',
  protocolMap: { 'openai-responses': [] },
}

describe('useCodexConfig', () => {
  afterEach(() => cleanup())

  it('applies a self-contained gateway and reflects the provider as the active auth', async () => {
    const { service, intents } = makeCodexService({ activeAuth: { kind: 'none' } })
    const { result } = setup(service, [GATEWAY_ENTRY])
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.applyAuthentication('gw')
    })

    expect(intents).toEqual([
      { kind: 'gateway', baseUrl: 'https://gw.example.com', apiKey: 'tok-1', providerName: 'gw' },
    ])
    expect(result.current.activeAuth).toEqual({ kind: 'provider', providerId: 'gw' })
  })

  it('switches to the ChatGPT login for @subscription', async () => {
    const { service, intents } = makeCodexService({
      activeAuth: { kind: 'provider', providerId: 'gw' },
    })
    const { result } = setup(service, [GATEWAY_ENTRY])
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.applyAuthentication(AGENT_SUBSCRIPTION_AUTH)
    })

    expect(intents).toEqual([{ kind: 'chatgpt' }])
    expect(result.current.activeAuth).toEqual({ kind: 'subscription' })
  })

  it('writes config.toml model', async () => {
    const { service, patchCalls } = makeCodexService({
      activeAuth: { kind: 'provider', providerId: 'gw' },
    })
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.setModel('gpt-5.5')
    })

    expect(patchCalls).toEqual([{ model: 'gpt-5.5' }])
    expect(result.current.settings.model).toBe('gpt-5.5')
  })

  it('clears config.toml model when the pick is unset', async () => {
    const { service, patchCalls } = makeCodexService({
      activeAuth: { kind: 'provider', providerId: 'gw' },
    })
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.setModel(undefined)
    })

    expect(patchCalls).toEqual([{ model: null }])
    expect(result.current.settings.model).toBeUndefined()
  })

  it('rereads settings AND active auth when config.toml / auth.json change on disk', async () => {
    // The watch covers both files, so one event has to refresh all three reads —
    // a `codex login` in the CLI changes the credential without touching model.
    const { service, onDidChangeAuth, setOnDisk, setActiveAuthOnDisk } = makeCodexService({
      activeAuth: { kind: 'none' },
    })
    const { result } = setup(service, [GATEWAY_ENTRY])
    await waitFor(() => expect(result.current.loaded).toBe(true))

    setOnDisk({ model: 'gpt-5.5' })
    setActiveAuthOnDisk({ kind: 'provider', providerId: 'gw' })
    await act(async () => {
      onDidChangeAuth.fire()
    })

    await waitFor(() => expect(result.current.settings.model).toBe('gpt-5.5'))
    expect(result.current.activeAuth).toEqual({ kind: 'provider', providerId: 'gw' })
  })
})
