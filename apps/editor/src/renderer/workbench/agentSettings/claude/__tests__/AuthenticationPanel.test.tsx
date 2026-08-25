/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  AuthenticationPanel tests — the provider picker mirrors the credential in
 *  effect on disk (`activeAuth`), renders a derived env preview with a masked
 *  token (never the full key), probes connectivity only on an explicit "Test"
 *  click, shows guidance when no compatible provider exists, and surfaces an
 *  unattributed external credential.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  IAiModelService,
  ICommandService,
  IConfigurationService,
  ILayoutService,
  INotificationService,
  IViewsService,
  InstantiationService,
  ServiceCollection,
  type AiProviderEntry,
  type AiProviderVerifyResult,
} from '@universe-editor/platform'
import { IClaudeBinaryService } from '../../../../../shared/ipc/claudeBinaryService.js'
import { ITerminalManagerService } from '../../../../services/terminal/TerminalManagerService.js'
import type { AgentActiveAuth } from '../../../../../shared/ai/agentActiveAuth.js'
import type { ClaudeAuthStatus } from '../../../../../shared/ipc/claudeConfigService.js'
import { ServicesContext } from '../../../useService.js'
import { AuthenticationPanel } from '../AuthenticationPanel.js'
import type { UseClaudeConfig } from '../useClaudeConfig.js'

afterEach(() => cleanup())

const GW_ENTRY: AiProviderEntry = {
  id: 'gw',
  apiKey: 'sk-ant-secret-key-123',
  baseUrl: 'https://gw.example.com',
  protocolMap: { 'anthropic-messages': [] },
}
const OPENAI_ENTRY: AiProviderEntry = {
  id: 'gw-openai',
  apiKey: 'sk-x',
  baseUrl: 'https://gw.example.com',
  protocolMap: { 'openai-chat': [] },
}

function makeConfig(
  activeAuth: AgentActiveAuth,
  effective: { model?: string; subagentModel?: string } = {},
  authStatus: ClaudeAuthStatus = { loggedIn: false, expired: false },
): UseClaudeConfig {
  const env: Record<string, string> = {}
  if (effective.subagentModel !== undefined) {
    env['CLAUDE_CODE_SUBAGENT_MODEL'] = effective.subagentModel
  }
  return {
    settings: { env, ...(effective.model !== undefined ? { model: effective.model } : {}) },
    loaded: true,
    configPath: '',
    authority: undefined,
    authStatus,
    activeAuth,
    subagentModelEnv: effective.subagentModel,
    patch: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    reloadAuthStatus: vi.fn(async () => authStatus),
    applyAuthentication: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setModelOneM: vi.fn(async () => {}),
    setSubagentModel: vi.fn(async () => {}),
    setSubagentModelOneM: vi.fn(async () => {}),
  }
}

function makeAiModel(entries: readonly AiProviderEntry[]) {
  const verifyProvider = vi.fn(
    async (): Promise<AiProviderVerifyResult> => ({ ok: true, modelCount: 2 }),
  )
  const aiModel = {
    verifyProvider,
    getProviders: vi.fn(async () => entries),
    getModelKnowledge: vi.fn(async () => ({})),
  }
  return { aiModel, verifyProvider }
}

function renderPanel(config: UseClaudeConfig, aiModel: unknown) {
  const services = new ServiceCollection()
  services.set(IAiModelService, aiModel as IAiModelService)
  services.set(INotificationService, { notify: vi.fn() } as unknown as INotificationService)
  services.set(ICommandService, {
    executeCommand: vi.fn(async () => {}),
  } as unknown as ICommandService)
  services.set(IClaudeBinaryService, {} as unknown as IClaudeBinaryService)
  services.set(ITerminalManagerService, {} as unknown as ITerminalManagerService)
  services.set(IConfigurationService, {
    get: vi.fn(() => undefined),
  } as unknown as IConfigurationService)
  services.set(ILayoutService, {} as unknown as ILayoutService)
  services.set(IViewsService, {} as unknown as IViewsService)
  const inst = new InstantiationService(services)
  return render(<AuthenticationPanel config={config} />, {
    wrapper: ({ children }) => (
      <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
    ),
  })
}

async function flushEffects(): Promise<void> {
  await act(async () => {})
}

describe('AuthenticationPanel provider picker', () => {
  it('renders the derived env preview with a masked token, never the full key', async () => {
    const { aiModel } = makeAiModel([GW_ENTRY])
    renderPanel(makeConfig({ kind: 'provider', providerId: 'gw' }), aiModel)
    await flushEffects()
    await flushEffects()

    const preview = within(screen.getByTestId('derivePreview'))
    expect(preview.getByText('https://gw.example.com')).toBeTruthy()
    expect(preview.getByText('sk-a••••••••••-123')).toBeTruthy()
    expect(screen.queryByText('sk-ant-secret-key-123')).toBeNull()
  })

  it('only calls verifyProvider on an explicit Test click, not on render', async () => {
    const { aiModel, verifyProvider } = makeAiModel([GW_ENTRY])
    renderPanel(makeConfig({ kind: 'provider', providerId: 'gw' }), aiModel)
    await flushEffects()
    await flushEffects()

    expect(verifyProvider).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await flushEffects()

    expect(verifyProvider).toHaveBeenCalledTimes(1)
    expect(verifyProvider).toHaveBeenCalledWith({
      id: 'gw',
      protocol: 'anthropic-messages',
      baseUrl: 'https://gw.example.com',
      apiKey: 'sk-ant-secret-key-123',
    })
  })

  it('shows guidance instead of an empty dropdown when no provider exists', async () => {
    const { aiModel } = makeAiModel([])
    renderPanel(makeConfig({ kind: 'provider', providerId: 'gw' }), aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.getByText(/No provider entries/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add a provider…' })).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('shows the adjust-protocol guidance when providers exist but none is compatible', async () => {
    const { aiModel } = makeAiModel([OPENAI_ENTRY])
    renderPanel(makeConfig({ kind: 'none' }), aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.getByText(/none declares the anthropic-messages protocol/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open AI settings…' })).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('keeps a saved-but-incompatible selection visible with a warning', async () => {
    const { aiModel } = makeAiModel([OPENAI_ENTRY])
    renderPanel(makeConfig({ kind: 'provider', providerId: 'gw-openai' }), aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.getByRole('combobox')).toBeTruthy()
    // The themed Select only renders its options while the popup is open.
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.getByRole('option', { name: /incompatible/ })).toBeTruthy()
    expect(screen.getByText(/does not declare the anthropic-messages protocol/)).toBeTruthy()
  })

  it('derives the subscription selection from the subscription active auth', async () => {
    const { aiModel } = makeAiModel([GW_ENTRY])
    renderPanel(makeConfig({ kind: 'subscription' }), aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.getByText('Use Claude subscription login')).toBeTruthy()
    expect(screen.getByText(/Uses the shared Claude OAuth login below/)).toBeTruthy()
  })

  it('shows the external credential hint when the credential in effect matches no entry', async () => {
    const { aiModel } = makeAiModel([GW_ENTRY])
    renderPanel(makeConfig({ kind: 'provider' }), aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.getByText(/credential configured outside the editor/)).toBeTruthy()
  })

  it('renders the 1m checkbox for a plain model and toggles it on', async () => {
    const { aiModel } = makeAiModel([GW_ENTRY])
    const config = makeConfig({ kind: 'provider', providerId: 'gw' }, { model: 'deepseek-v4-pro' })
    renderPanel(config, aiModel)
    await flushEffects()
    await flushEffects()

    const checkbox = screen.getByTestId('model-1m')
    expect((checkbox as HTMLInputElement).checked).toBe(false)
    fireEvent.click(checkbox)
    expect(config.setModelOneM).toHaveBeenCalledWith(true)
  })

  // The row shows the effective id, so a `[1m]` suffix IS the checked state —
  // there is no second flag that could contradict it.
  it('shows the 1m checkbox already checked when the model id carries [1m]', async () => {
    const { aiModel } = makeAiModel([GW_ENTRY])
    const config = makeConfig(
      { kind: 'provider', providerId: 'gw' },
      { model: 'claude-opus-5[1m]' },
    )
    renderPanel(config, aiModel)
    await flushEffects()
    await flushEffects()

    const checkbox = screen.getByTestId('model-1m')
    expect((checkbox as HTMLInputElement).checked).toBe(true)
    fireEvent.click(checkbox)
    expect(config.setModelOneM).toHaveBeenCalledWith(false)
  })

  it('hides the 1m checkbox when no model is picked', async () => {
    const { aiModel } = makeAiModel([GW_ENTRY])
    renderPanel(makeConfig({ kind: 'provider', providerId: 'gw' }), aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.queryByTestId('model-1m')).toBeNull()
  })

  // Regression for the reported bug: the sub-agent row must render the value the
  // spawned process actually reads (env.CLAUDE_CODE_SUBAGENT_MODEL), not a
  // separately stored pick that could have drifted from it.
  it('renders the sub-agent row from the effective env value', async () => {
    const { aiModel } = makeAiModel([GW_ENTRY])
    renderPanel(
      makeConfig({ kind: 'provider', providerId: 'gw' }, { subagentModel: 'deepseek-v4-flash' }),
      aiModel,
    )
    await flushEffects()
    await flushEffects()

    // The value is pinned as the only option, so it shows on the Select trigger.
    expect(screen.getByText('deepseek-v4-flash')).toBeTruthy()
    expect((screen.getByTestId('subagentModel-1m') as HTMLInputElement).checked).toBe(false)
  })

  it('renders a localized reason when the probe fails', async () => {
    const { aiModel, verifyProvider } = makeAiModel([GW_ENTRY])
    verifyProvider.mockResolvedValue({ ok: false, modelCount: 0, code: 'unreachable' })
    renderPanel(makeConfig({ kind: 'provider', providerId: 'gw' }), aiModel)
    await flushEffects()
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await flushEffects()
    await flushEffects()

    const dot = screen.getByRole('img')
    expect(dot.getAttribute('data-status')).toBe('fail')
    expect(dot.getAttribute('data-tooltip')?.trim()).not.toBe('')
  })
})

describe('AuthenticationPanel login form', () => {
  it('offers "Use this login" when signed in but a provider credential is in effect', async () => {
    const { aiModel } = makeAiModel([GW_ENTRY])
    renderPanel(
      makeConfig({ kind: 'provider', providerId: 'gw' }, {}, { loggedIn: true, expired: false }),
      aiModel,
    )
    await flushEffects()
    await flushEffects()

    expect(screen.getByText(/provider credential is currently taking precedence/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Use this login' })).toBeTruthy()
    // The effective credential is the selection now, so no "In use" badge is needed.
    expect(screen.queryByText('In use')).toBeNull()
  })

  it('does not offer "Use this login" when the subscription login is already in effect', async () => {
    const { aiModel } = makeAiModel([GW_ENTRY])
    renderPanel(
      makeConfig({ kind: 'subscription' }, {}, { loggedIn: true, expired: false }),
      aiModel,
    )
    await flushEffects()
    await flushEffects()

    expect(screen.queryByRole('button', { name: 'Use this login' })).toBeNull()
    expect(screen.queryByText('In use')).toBeNull()
  })
})
