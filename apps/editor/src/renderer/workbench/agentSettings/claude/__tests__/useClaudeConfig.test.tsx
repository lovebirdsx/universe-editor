/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useClaudeConfig: applyAuthentication injects the derived credential env (or
 *  clears it for `@subscription`) and persists the selection; setModel /
 *  setSmallFastModel write settings.json alongside their persisted picks.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  IAiModelService,
  INotificationService,
  InstantiationService,
  ServiceCollection,
  type AiProviderEntry,
} from '@universe-editor/platform'
import {
  AGENT_SUBSCRIPTION_AUTH,
  IClaudeConfigService,
  type ClaudeAgentSettings,
  type ClaudeSettings,
  type ClaudeSettingsPatch,
} from '../../../../../shared/ipc/claudeConfigService.js'
import { ServicesContext } from '../../../useService.js'
import { useClaudeConfig } from '../useClaudeConfig.js'

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

function makeClaudeService(initial: {
  settings: ClaudeSettings
  agentSettings: ClaudeAgentSettings
}) {
  let settings = initial.settings
  let agentSettings = initial.agentSettings
  const patchCalls: ClaudeSettingsPatch[] = []
  const writeCalls: ClaudeAgentSettings[] = []
  const service = {
    _serviceBrand: undefined,
    async read(): Promise<ClaudeSettings> {
      return settings
    },
    async patch(p: ClaudeSettingsPatch): Promise<void> {
      patchCalls.push(p)
      let next = { ...settings }
      if (typeof p.model === 'string') next = { ...next, model: p.model }
      else if (p.model === null) delete next.model
      if (p.env) {
        const env = { ...(next.env ?? {}) }
        for (const [key, value] of Object.entries(p.env)) {
          if (value === null) delete env[key]
          else env[key] = value
        }
        if (Object.keys(env).length > 0) next = { ...next, env }
        else delete next.env
      }
      settings = next
    },
    async configPath(): Promise<string> {
      return '/home/u/.claude/settings.json'
    },
    async readAuthStatus() {
      return { loggedIn: false, expired: false }
    },
    async readAgentSettings(): Promise<ClaudeAgentSettings> {
      return agentSettings
    },
    async writeAgentSettings(next: ClaudeAgentSettings): Promise<void> {
      writeCalls.push(next)
      agentSettings = next
    },
    async checkGatewayConnectivity(): Promise<boolean> {
      return true
    },
  } as unknown as IClaudeConfigService
  return { service, patchCalls, writeCalls, getSettings: () => settings }
}

function setup(service: IClaudeConfigService, entries: readonly AiProviderEntry[] = []) {
  const services = new ServiceCollection()
  services.set(IClaudeConfigService, service)
  services.set(IAiModelService, makeAiService(entries))
  services.set(INotificationService, makeNotificationService())
  const instantiation = new InstantiationService(services)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServicesContext.Provider value={instantiation}>{children}</ServicesContext.Provider>
  )
  return renderHook(() => useClaudeConfig(), { wrapper })
}

const GATEWAY_ENTRY: AiProviderEntry = {
  id: 'gw',
  apiKey: 'tok-1',
  baseUrl: 'https://gw.example.com',
  protocolMap: { 'anthropic-messages': [] },
}
const OFFICIAL_ENTRY: AiProviderEntry = {
  id: 'anthropic',
  apiKey: 'sk-ant-official',
  protocolMap: { 'anthropic-messages': [] },
}

describe('useClaudeConfig', () => {
  afterEach(() => cleanup())

  it('injects a gateway credential and persists the selection', async () => {
    const { service, patchCalls, writeCalls } = makeClaudeService({
      settings: {},
      agentSettings: {},
    })
    const { result } = setup(service, [GATEWAY_ENTRY])
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.applyAuthentication('gw')
    })

    expect(writeCalls).toEqual([{ authentication: 'gw' }])
    expect(result.current.settings.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'tok-1',
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
    })
    expect(patchCalls.some((p) => p.env?.['ANTHROPIC_API_KEY'] === null)).toBe(true)
  })

  it('injects the official API key for an official-endpoint provider', async () => {
    const { service } = makeClaudeService({ settings: {}, agentSettings: {} })
    const { result } = setup(service, [OFFICIAL_ENTRY])
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.applyAuthentication('anthropic')
    })

    expect(result.current.settings.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-official' })
  })

  it('clears the credential env for @subscription', async () => {
    const { service, writeCalls } = makeClaudeService({
      settings: { env: { ANTHROPIC_AUTH_TOKEN: 'tok-1', ANTHROPIC_BASE_URL: 'https://x' } },
      agentSettings: { authentication: 'gw' },
    })
    const { result } = setup(service, [GATEWAY_ENTRY])
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.applyAuthentication(AGENT_SUBSCRIPTION_AUTH)
    })

    expect(writeCalls).toEqual([{ authentication: AGENT_SUBSCRIPTION_AUTH }])
    expect(result.current.settings.env).toBeUndefined()
  })

  it('writes settings.model and persists the model pick', async () => {
    const { service, writeCalls } = makeClaudeService({
      settings: {},
      agentSettings: { authentication: 'gw' },
    })
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.setModel('kimi-k3')
    })

    expect(writeCalls).toEqual([{ authentication: 'gw', model: 'kimi-k3' }])
    expect(result.current.settings.model).toBe('kimi-k3')
  })

  it('writes the fast-model env and persists the pick', async () => {
    const { service } = makeClaudeService({
      settings: {},
      agentSettings: { authentication: 'gw' },
    })
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.setSmallFastModel('kimi-k3-mini')
    })

    expect(result.current.settings.env?.['ANTHROPIC_SMALL_FAST_MODEL']).toBe('kimi-k3-mini')
  })
})
