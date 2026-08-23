/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useCodexConfig: applyAuthentication drives the matching applyCredential
 *  intent (self-contained gateway, or ChatGPT login) and persists the selection;
 *  setModel writes config.toml alongside the persisted pick.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  Event,
  IAiModelService,
  INotificationService,
  InstantiationService,
  ServiceCollection,
  type AiProviderEntry,
} from '@universe-editor/platform'
import {
  ICodexConfigService,
  type CodexActiveAuth,
  type CodexAgentSettings,
  type CodexAuthStatus,
  type CodexCredentialIntent,
  type CodexSettings,
  type CodexSettingsPatch,
} from '../../../../../shared/ipc/codexConfigService.js'
import { AGENT_SUBSCRIPTION_AUTH } from '../../../../../shared/ipc/claudeConfigService.js'
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

function makeCodexService(initial: {
  agentSettings: CodexAgentSettings
  activeAuth: CodexActiveAuth
}) {
  let agentSettings = initial.agentSettings
  let activeAuth = initial.activeAuth
  const intents: CodexCredentialIntent[] = []
  const writeCalls: CodexAgentSettings[] = []
  const patchCalls: CodexSettingsPatch[] = []
  const service = {
    _serviceBrand: undefined,
    onDidChangeAuth: Event.None,
    async read(): Promise<CodexSettings> {
      return {}
    },
    async patch(p: CodexSettingsPatch): Promise<void> {
      patchCalls.push(p)
    },
    async applyCredential(intent: CodexCredentialIntent): Promise<CodexAuthStatus> {
      intents.push(intent)
      if (intent.kind === 'gateway') {
        activeAuth = { kind: 'provider', providerId: 'gw', drift: false }
      } else if (intent.kind === 'chatgpt') {
        activeAuth = { kind: 'subscription', drift: false }
      } else {
        activeAuth = { kind: 'none', drift: false }
      }
      return LOGGED_OUT
    },
    async configPath(): Promise<string> {
      return '/home/u/.codex/config.toml'
    },
    async readAuthStatus(): Promise<CodexAuthStatus> {
      return LOGGED_OUT
    },
    async readAgentSettings(): Promise<CodexAgentSettings> {
      return agentSettings
    },
    async writeAgentSettings(next: CodexAgentSettings): Promise<void> {
      writeCalls.push(next)
      agentSettings = next
    },
    async resolveActiveAuth(): Promise<CodexActiveAuth> {
      return activeAuth
    },
    async checkGatewayConnectivity(): Promise<boolean> {
      return true
    },
  } as unknown as ICodexConfigService
  return { service, intents, writeCalls, patchCalls }
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

  it('applies a self-contained gateway and persists the selection', async () => {
    const { service, intents, writeCalls } = makeCodexService({
      agentSettings: {},
      activeAuth: { kind: 'none', drift: false },
    })
    const { result } = setup(service, [GATEWAY_ENTRY])
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.applyAuthentication('gw')
    })

    expect(writeCalls).toEqual([{ authentication: 'gw' }])
    expect(intents).toEqual([
      { kind: 'gateway', baseUrl: 'https://gw.example.com', apiKey: 'tok-1', providerName: 'gw' },
    ])
    expect(result.current.activeAuth.kind).toBe('provider')
  })

  it('switches to the ChatGPT login for @subscription', async () => {
    const { service, intents, writeCalls } = makeCodexService({
      agentSettings: { authentication: 'gw' },
      activeAuth: { kind: 'provider', providerId: 'gw', drift: false },
    })
    const { result } = setup(service, [GATEWAY_ENTRY])
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.applyAuthentication(AGENT_SUBSCRIPTION_AUTH)
    })

    expect(writeCalls).toEqual([{ authentication: AGENT_SUBSCRIPTION_AUTH }])
    expect(intents).toEqual([{ kind: 'chatgpt' }])
    expect(result.current.activeAuth.kind).toBe('subscription')
  })

  it('writes config.toml model and persists the pick', async () => {
    const { service, patchCalls, writeCalls } = makeCodexService({
      agentSettings: { authentication: 'gw' },
      activeAuth: { kind: 'provider', providerId: 'gw', drift: false },
    })
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.setModel('gpt-5.5')
    })

    expect(writeCalls).toEqual([{ authentication: 'gw', model: 'gpt-5.5' }])
    expect(patchCalls).toEqual([{ model: 'gpt-5.5' }])
  })
})
