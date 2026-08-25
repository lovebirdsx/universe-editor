/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  CodexAuthenticationPanel tests — the provider picker mirrors the credential
 *  in effect on disk (`activeAuth`), renders a derived TOML preview with a
 *  masked key (never the full key), probes connectivity only on an explicit
 *  "Test" click, shows guidance when no compatible provider exists, pins a
 *  stale effective model on top, and surfaces an unattributed external
 *  credential.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  IAiModelService,
  ICommandService,
  INotificationService,
  InstantiationService,
  ServiceCollection,
  type AiProviderEntry,
} from '@universe-editor/platform'
import { ITerminalManagerService } from '../../../../services/terminal/TerminalManagerService.js'
import type { CodexAuthStatus } from '../../../../../shared/ipc/codexConfigService.js'
import type { AgentActiveAuth } from '../../../../../shared/ai/agentActiveAuth.js'
import { ServicesContext } from '../../../useService.js'
import { CodexAuthenticationPanel } from '../CodexAuthenticationPanel.js'
import type { UseCodexConfig } from '../useCodexConfig.js'

afterEach(() => cleanup())

const GW_ENTRY: AiProviderEntry = {
  id: 'edge',
  apiKey: 'sk-codex-secret-key-456',
  baseUrl: 'https://gw.example.com/v1',
  protocolMap: { 'openai-responses': [] },
}
const GW_ENTRY_WITH_MODELS: AiProviderEntry = {
  id: 'edge',
  apiKey: 'sk-codex-secret-key-456',
  baseUrl: 'https://gw.example.com/v1',
  protocolMap: { 'openai-responses': ['gpt-5.5', 'gpt-5.5-mini'] },
}

function makeConfig(
  activeAuth: AgentActiveAuth,
  settings: UseCodexConfig['settings'] = {},
): UseCodexConfig {
  return {
    settings,
    loaded: true,
    configPath: '',
    authority: undefined,
    authStatus: { active: 'none', hasApiKey: false },
    activeAuth,
    patch: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    reloadAuthStatus: vi.fn(
      async (): Promise<CodexAuthStatus> => ({
        active: 'none',
        hasApiKey: false,
      }),
    ),
    applyAuthentication: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
  }
}

function makeAiModel(entries: readonly AiProviderEntry[]) {
  const verifyProvider = vi.fn(async () => ({ ok: true, modelCount: 2 }))
  const aiModel = {
    verifyProvider,
    getProviders: vi.fn(async () => entries),
    getModelKnowledge: vi.fn(async () => ({})),
  }
  return { aiModel, verifyProvider }
}

function renderPanel(config: UseCodexConfig, aiModel: unknown) {
  const services = new ServiceCollection()
  services.set(IAiModelService, aiModel as IAiModelService)
  services.set(INotificationService, { notify: vi.fn() } as unknown as INotificationService)
  services.set(ICommandService, {
    executeCommand: vi.fn(async () => {}),
  } as unknown as ICommandService)
  services.set(ITerminalManagerService, {} as unknown as ITerminalManagerService)
  const inst = new InstantiationService(services)
  return render(<CodexAuthenticationPanel config={config} />, {
    wrapper: ({ children }) => (
      <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
    ),
  })
}

async function flushEffects(): Promise<void> {
  await act(async () => {})
}

describe('CodexAuthenticationPanel provider picker', () => {
  it('renders the derived TOML preview with a masked key, never the full key', async () => {
    const { aiModel } = makeAiModel([GW_ENTRY])
    renderPanel(makeConfig({ kind: 'provider', providerId: 'edge' }), aiModel)
    await flushEffects()
    await flushEffects()

    const preview = within(screen.getByTestId('derivePreview'))
    expect(preview.getByText('edge')).toBeTruthy()
    expect(preview.getByText('https://gw.example.com/v1')).toBeTruthy()
    expect(preview.getByText('sk-c••••••••••-456')).toBeTruthy()
    expect(screen.queryByText('sk-codex-secret-key-456')).toBeNull()
  })

  it('only calls verifyProvider on an explicit Test click, not on render', async () => {
    const { aiModel, verifyProvider } = makeAiModel([GW_ENTRY])
    renderPanel(makeConfig({ kind: 'provider', providerId: 'edge' }), aiModel)
    await flushEffects()
    await flushEffects()

    expect(verifyProvider).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await flushEffects()

    expect(verifyProvider).toHaveBeenCalledTimes(1)
    expect(verifyProvider).toHaveBeenCalledWith({
      id: 'edge',
      protocol: 'openai-responses',
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sk-codex-secret-key-456',
    })
  })

  it('shows guidance instead of an empty dropdown when no compatible provider exists', async () => {
    const { aiModel } = makeAiModel([])
    renderPanel(makeConfig({ kind: 'provider', providerId: 'edge' }), aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.getByText(/No provider entries/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add a provider…' })).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('derives the subscription selection from the subscription active auth', async () => {
    const { aiModel } = makeAiModel([GW_ENTRY])
    renderPanel(makeConfig({ kind: 'subscription' }), aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.getByText('Use ChatGPT subscription login')).toBeTruthy()
    expect(screen.getByText(/Uses the shared ChatGPT login below/)).toBeTruthy()
  })

  it('shows the external credential hint when the credential in effect matches no entry', async () => {
    const { aiModel } = makeAiModel([GW_ENTRY])
    renderPanel(makeConfig({ kind: 'provider' }), aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.getByText(/credential configured outside the editor/)).toBeTruthy()
  })

  // The row shows the effective config.toml model; a value the provider no
  // longer offers must stay pinned on top instead of vanishing.
  it('pins a stale effective model on top of the candidates', async () => {
    const { aiModel } = makeAiModel([GW_ENTRY_WITH_MODELS])
    renderPanel(
      makeConfig({ kind: 'provider', providerId: 'edge' }, { model: 'stale-model' }),
      aiModel,
    )
    await flushEffects()
    await flushEffects()

    // The pinned value is the Select trigger's current option.
    expect(screen.getByText('stale-model')).toBeTruthy()
  })
})
