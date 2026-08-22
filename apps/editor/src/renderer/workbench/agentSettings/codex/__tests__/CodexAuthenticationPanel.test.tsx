/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  CodexAuthenticationPanel tests — mirrors the Claude panel: the gateway
 *  credential form's provider picker renders a derived TOML preview with a
 *  masked key (never the full key), probes connectivity only on an explicit
 *  "Test" click, and shows guidance when no compatible provider exists.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  IAiModelService,
  ICommandService,
  INotificationService,
  InstantiationService,
  ServiceCollection,
  type AiProviderInstance,
  type AiProviderType,
} from '@universe-editor/platform'
import type {
  CodexAuthStatus,
  CodexCredentialDraft,
} from '../../../../../shared/ipc/codexConfigService.js'
import { ITerminalManagerService } from '../../../../services/terminal/TerminalManagerService.js'
import { ServicesContext } from '../../../useService.js'
import { CodexAuthenticationPanel } from '../CodexAuthenticationPanel.js'
import type { UseCodexConfig } from '../useCodexConfig.js'

afterEach(() => cleanup())

const GW_INSTANCE: AiProviderInstance = {
  name: 'edge',
  type: 'openai',
  apiKey: 'sk-codex-secret-key-456',
  baseUrl: 'https://gw.example.com/v1',
}
const GW_TYPES: Readonly<Record<string, AiProviderType>> = {
  openai: { protocol: 'openai-responses' },
}

const GATEWAY_DRAFT: CodexCredentialDraft = {
  kind: 'gateway',
  label: 'Work gateway',
  apiKey: '',
  providerRef: 'openai/edge',
}

function makeConfig(draft: CodexCredentialDraft | undefined): UseCodexConfig {
  return {
    settings: { model_provider: '' },
    loaded: true,
    configPath: '',
    authority: undefined,
    authStatus: { active: 'none', hasApiKey: false },
    profiles: [],
    activeProfileId: undefined,
    credentialDraft: draft,
    patch: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    reloadAuthStatus: vi.fn(
      async (): Promise<CodexAuthStatus> => ({ active: 'none', hasApiKey: false }),
    ),
    saveProfile: vi.fn(async () => {}),
    deleteProfile: vi.fn(async () => {}),
    saveCredentialDraft: vi.fn(async () => {}),
    applyProfile: vi.fn(async () => {}),
    switchToChatgptLogin: vi.fn(async () => {}),
  }
}

function makeAiModel(
  providers: readonly AiProviderInstance[],
  types: Readonly<Record<string, AiProviderType>>,
) {
  const verifyProvider = vi.fn(async () => ({ ok: true, modelCount: 2 }))
  const aiModel = {
    verifyProvider,
    getProviders: vi.fn(async () => providers),
    getProviderTypes: vi.fn(async () => types),
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

describe('CodexAuthenticationPanel gateway form', () => {
  it('renders the derived TOML preview with a masked key, never the full key', async () => {
    const { aiModel } = makeAiModel([GW_INSTANCE], GW_TYPES)
    renderPanel(makeConfig(GATEWAY_DRAFT), aiModel)
    await flushEffects()
    await flushEffects()

    const preview = within(screen.getByTestId('derivePreview'))
    expect(preview.getByText('edge')).toBeTruthy()
    expect(preview.getByText('https://gw.example.com/v1')).toBeTruthy()
    expect(preview.getByText('sk-c••••••••••-456')).toBeTruthy()
    expect(screen.queryByText('sk-codex-secret-key-456')).toBeNull()
  })

  it('only calls verifyProvider on an explicit Test click, not on render', async () => {
    const { aiModel, verifyProvider } = makeAiModel([GW_INSTANCE], GW_TYPES)
    renderPanel(makeConfig(GATEWAY_DRAFT), aiModel)
    await flushEffects()
    await flushEffects()

    expect(verifyProvider).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await flushEffects()

    expect(verifyProvider).toHaveBeenCalledTimes(1)
    expect(verifyProvider).toHaveBeenCalledWith({
      type: 'openai',
      name: 'edge',
      protocol: 'openai-responses',
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sk-codex-secret-key-456',
    })
  })

  it('shows guidance instead of an empty dropdown when no compatible provider exists', async () => {
    const { aiModel } = makeAiModel([], {})
    renderPanel(makeConfig(GATEWAY_DRAFT), aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.getByText(/No provider instances/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add a provider…' })).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})
