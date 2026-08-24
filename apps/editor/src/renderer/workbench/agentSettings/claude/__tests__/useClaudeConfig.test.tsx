/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useClaudeConfig: applyAuthentication injects the derived credential env (or
 *  clears it for `@subscription`) and persists the selection; setModel /
 *  setSubagentModel write settings.json alongside their persisted picks.
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

  it('writes the sub-agent model env and persists the pick', async () => {
    const { service } = makeClaudeService({
      settings: {},
      agentSettings: { authentication: 'gw' },
    })
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.setSubagentModel('kimi-k3-mini')
    })

    expect(result.current.settings.env?.['CLAUDE_CODE_SUBAGENT_MODEL']).toBe('kimi-k3-mini')
  })

  it('setModelOneM appends [1m] and toggling off drops it from both stores', async () => {
    const { service, writeCalls } = makeClaudeService({
      settings: {},
      agentSettings: { authentication: 'gw', model: 'kimi-k3' },
    })
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.setModelOneM(true)
    })
    expect(result.current.settings.model).toBe('kimi-k3[1m]')
    expect(writeCalls[writeCalls.length - 1]!.model1m).toBe(true)

    await act(async () => {
      await result.current.setModelOneM(false)
    })
    expect(result.current.settings.model).toBe('kimi-k3')
    expect('model1m' in writeCalls[writeCalls.length - 1]!).toBe(false)
  })

  it('keeps an already-[1m] model id intact and drops the stale 1m flag', async () => {
    const { service, writeCalls } = makeClaudeService({
      settings: {},
      agentSettings: { model: 'a', model1m: true },
    })
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.setModel('claude-opus-5[1m]')
    })

    expect(result.current.settings.model).toBe('claude-opus-5[1m]')
    const last = writeCalls[writeCalls.length - 1]!
    expect('model1m' in last).toBe(false)
    expect(last.model).toBe('claude-opus-5[1m]')
  })

  it('each setter patches only the one related key, leaving the rest untouched', async () => {
    const { service, patchCalls } = makeClaudeService({
      settings: {
        model: 'old',
        language: 'zh',
        env: { ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://gw', FOO: 'bar' },
      },
      agentSettings: {},
    })
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.setModel('kimi-k3')
    })
    const modelPatch = patchCalls[patchCalls.length - 1]!
    expect(Object.keys(modelPatch)).toEqual(['model'])
    expect(result.current.settings.model).toBe('kimi-k3')
    expect(result.current.settings.language).toBe('zh')
    expect(result.current.settings.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'tok',
      ANTHROPIC_BASE_URL: 'https://gw',
      FOO: 'bar',
    })

    await act(async () => {
      await result.current.setSubagentModel('kimi-k3-mini')
    })
    const subPatch = patchCalls[patchCalls.length - 1]!
    expect(subPatch).toEqual({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-k3-mini' } })
    expect(Object.keys(subPatch.env!)).toEqual(['CLAUDE_CODE_SUBAGENT_MODEL'])
    expect(result.current.settings.model).toBe('kimi-k3')
    expect(result.current.settings.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'tok',
      ANTHROPIC_BASE_URL: 'https://gw',
      FOO: 'bar',
      CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-k3-mini',
    })

    await act(async () => {
      await result.current.setSubagentModel(undefined)
    })
    const clearPatch = patchCalls[patchCalls.length - 1]!
    expect(clearPatch).toEqual({ env: { CLAUDE_CODE_SUBAGENT_MODEL: null } })
    expect(result.current.settings.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'tok',
      ANTHROPIC_BASE_URL: 'https://gw',
      FOO: 'bar',
    })
  })

  it('setSubagentModelOneM appends [1m] to the sub-agent model env', async () => {
    const { service } = makeClaudeService({
      settings: {},
      agentSettings: { subagentModel: 'kimi-k3' },
    })
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await result.current.setSubagentModelOneM(true)
    })

    expect(result.current.settings.env?.['CLAUDE_CODE_SUBAGENT_MODEL']).toBe('kimi-k3[1m]')
  })

  // The agent-settings block is persisted wholesale, so a second writer that
  // started from the same pre-write snapshot would drop the first one's field.
  it('serializes concurrent writers instead of dropping the earlier field', async () => {
    const { service, writeCalls } = makeClaudeService({ settings: {}, agentSettings: {} })
    const { result } = setup(service, [GATEWAY_ENTRY])
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      // Fire both without awaiting the first, exactly as the panel's handlers do.
      await Promise.all([result.current.applyAuthentication('gw'), result.current.setModel('kimi')])
    })

    expect(writeCalls.at(-1)).toEqual({ authentication: 'gw', model: 'kimi' })
    expect(result.current.agentSettings).toEqual({ authentication: 'gw', model: 'kimi' })
  })

  it('lets a 1m toggle fired alongside a model pick see the settled pick', async () => {
    const { service } = makeClaudeService({ settings: {}, agentSettings: {} })
    const { result } = setup(service)
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(async () => {
      await Promise.all([result.current.setModel('kimi-k3'), result.current.setModelOneM(true)])
    })

    expect(result.current.settings.model).toBe('kimi-k3[1m]')
    expect(result.current.agentSettings).toEqual({ model: 'kimi-k3', model1m: true })
  })
})
