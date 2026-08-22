/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  AuthenticationPanel tests — the gateway credential form now uses a provider
 *  picker with a derived-preview, a click-only connectivity probe, and a
 *  guidance state when no compatible provider exists. These cover: the derived
 *  env preview renders with a masked token (never the full key), verifyProvider
 *  only fires on an explicit "Test" click, and the empty state shows guidance
 *  instead of an empty dropdown.
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
  type AiProviderInstance,
  type AiProviderType,
} from '@universe-editor/platform'
import { IClaudeBinaryService } from '../../../../../shared/ipc/claudeBinaryService.js'
import type { ClaudeCredentialDraft } from '../../../../../shared/ipc/claudeConfigService.js'
import { ITerminalManagerService } from '../../../../services/terminal/TerminalManagerService.js'
import { ServicesContext } from '../../../useService.js'
import { AuthenticationPanel } from '../AuthenticationPanel.js'
import type { UseClaudeConfig } from '../useClaudeConfig.js'

afterEach(() => cleanup())

const GW_INSTANCE: AiProviderInstance = {
  name: 'gw',
  type: 'anthropic',
  apiKey: 'sk-ant-secret-key-123',
  baseUrl: 'https://gw.example.com',
}
const GW_TYPES: Readonly<Record<string, AiProviderType>> = {
  anthropic: { protocol: 'anthropic-messages' },
}

const GATEWAY_DRAFT: ClaudeCredentialDraft = {
  kind: 'gateway',
  label: 'Work gateway',
  apiKey: '',
  providerRef: 'anthropic/gw',
  model: '',
  smallFastModel: '',
}

function makeConfig(draft: ClaudeCredentialDraft | undefined): UseClaudeConfig {
  return {
    settings: { env: {} },
    loaded: true,
    configPath: '',
    authority: undefined,
    authStatus: { loggedIn: false, expired: false },
    profiles: [],
    credentialDraft: draft,
    patch: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    reloadAuthStatus: vi.fn(async () => ({ loggedIn: false, expired: false })),
    saveProfile: vi.fn(async () => {}),
    deleteProfile: vi.fn(async () => {}),
    saveCredentialDraft: vi.fn(async () => {}),
    applyProfile: vi.fn(async () => {}),
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

describe('AuthenticationPanel gateway form', () => {
  it('renders the derived env preview with a masked token, never the full key', async () => {
    const { aiModel } = makeAiModel([GW_INSTANCE], GW_TYPES)
    renderPanel(makeConfig(GATEWAY_DRAFT), aiModel)
    await flushEffects()
    await flushEffects()

    const preview = within(screen.getByTestId('derivePreview'))
    expect(preview.getByText('https://gw.example.com')).toBeTruthy()
    expect(preview.getByText('sk-a••••••••••-123')).toBeTruthy()
    expect(screen.queryByText('sk-ant-secret-key-123')).toBeNull()
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
      type: 'anthropic',
      name: 'gw',
      protocol: 'anthropic-messages',
      baseUrl: 'https://gw.example.com',
      apiKey: 'sk-ant-secret-key-123',
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

  it('shows the adjust-protocol guidance when providers exist but none is compatible', async () => {
    const { aiModel } = makeAiModel([{ name: 'gw', type: 'openai' }], {
      openai: { protocol: 'openai-chat' },
    })
    renderPanel(makeConfig({ ...GATEWAY_DRAFT, providerRef: '' }), aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.getByText(/none declares the anthropic-messages protocol/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open AI settings…' })).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('keeps a saved-but-incompatible providerRef visible with a warning', async () => {
    const { aiModel } = makeAiModel(
      [{ name: 'gw', type: 'openai', apiKey: 'sk-x', baseUrl: 'https://gw.example.com' }],
      { openai: { protocol: 'openai-chat' } },
    )
    renderPanel(makeConfig({ ...GATEWAY_DRAFT, providerRef: 'openai/gw' }), aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.getByRole('combobox')).toBeTruthy()
    expect(screen.getByRole('option', { name: /incompatible/ })).toBeTruthy()
    expect(screen.getByText(/does not declare the anthropic-messages protocol/)).toBeTruthy()
  })
})
