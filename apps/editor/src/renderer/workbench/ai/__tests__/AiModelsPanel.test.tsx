/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  AiModelsPanel tests — the single-layer providers rewrite: entries render,
 *  removal writes through updateProviders, the account-usage block honours the
 *  "authoritative source only" contract (hidden without a usageSource,
 *  "Unavailable" when the source yields nothing), the connectivity dot only
 *  probes on an explicit "Test connection" click, the legacy-format banner shows
 *  when aiSettings.json is still two-layer, provider issues are surfaced visibly,
 *  and a provider without a pricing source shows "Rate unknown" on its models.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  Emitter,
  Event,
  IAiModelService,
  IDialogService,
  IEditorGroupsService,
  INotificationService,
  IQuickInputService,
  IStorageService,
  IUserDataFilesService,
  InstantiationService,
  ServiceCollection,
  type AiAccountUsage,
  type AiModelConfiguration,
  type AiModelMetadata,
  type AiProviderEntry,
  type AiProviderIssue,
} from '@universe-editor/platform'
import { IAiRateMirror } from '../../../services/ai/aiRateMirror.js'
import { AiModelsPanel } from '../AiModelsPanel.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => cleanup())

const KURO_MODEL: AiModelMetadata = {
  id: 'kuro/anthropic-messages/qwen3-coder',
  providerId: 'kuro',
  protocol: 'anthropic-messages',
  channelModel: 'qwen3-coder',
  name: 'Qwen3 Coder',
  family: 'qwen3',
  maxInputTokens: 1000,
  maxOutputTokens: 1000,
  capabilities: { streaming: true },
}

const KURO_PROVIDER: AiProviderEntry = {
  id: 'kuro',
  label: 'Kuro',
  baseUrl: 'https://kuro.example',
  protocolMap: { 'anthropic-messages': ['qwen3-coder'] },
}

class FakeAiModelService {
  private readonly _onDidChangeModels = new Emitter<void>()
  private readonly _onDidChangeRemote = new Emitter<void>()
  readonly onDidChangeModels = this._onDidChangeModels.event
  readonly onDidChangeRemote = this._onDidChangeRemote.event

  providers: readonly AiProviderEntry[] = []
  models: readonly AiModelMetadata[] = []
  issues: readonly AiProviderIssue[] = []
  legacy = false
  usages = new Map<string, AiAccountUsage | undefined>()

  getProviders = vi.fn(async () => this.providers)
  getModels = vi.fn(async () => this.models)
  getProviderIssues = vi.fn(async () => this.issues)
  isLegacySettingsFormat = vi.fn(async () => this.legacy)
  updateProviders = vi.fn(async (providers: readonly AiProviderEntry[]) => {
    this.providers = [...providers]
  })
  refreshRemote = vi.fn(async () => {})
  setApiKey = vi.fn(async () => {})
  deleteApiKey = vi.fn(async () => {})
  setModelConfiguration = vi.fn(async () => {})
  getModelConfiguration = vi.fn(async (): Promise<AiModelConfiguration> => ({}))
  verifyProvider = vi.fn(async () => ({ ok: true, modelCount: 2 }))
  getAccountUsage = vi.fn(async (providerId: string) => this.usages.get(providerId))
}

class FakeStorage {
  private readonly map = new Map<string, unknown>()
  readonly onDidChangeWorkspaceScope = Event.None
  get = vi.fn(async (key: string) => this.map.get(key))
  set = vi.fn(async (key: string, value: unknown) => {
    this.map.set(key, value)
  })
  remove = vi.fn(async (key: string) => {
    this.map.delete(key)
  })
}

const rateMirrorStub = {
  getRateTablesSync: vi.fn(() => []),
  getRatesSync: vi.fn(() => undefined),
} as unknown as IAiRateMirror

async function flushEffects(): Promise<void> {
  await act(async () => {})
}

function renderPanel(aiModel: FakeAiModelService, confirmResult = { confirmed: true }) {
  const services = new ServiceCollection()
  services.set(IAiModelService, aiModel as unknown as IAiModelService)
  services.set(IAiRateMirror, rateMirrorStub)
  services.set(IStorageService, new FakeStorage() as unknown as IStorageService)
  services.set(IQuickInputService, {
    input: vi.fn(async () => undefined),
  } as unknown as IQuickInputService)
  services.set(IDialogService, {
    confirm: vi.fn(async () => ({ confirmed: confirmResult.confirmed, choice: 'primary' })),
  } as unknown as IDialogService)
  services.set(INotificationService, { notify: vi.fn() } as unknown as INotificationService)
  services.set(IUserDataFilesService, {
    getFileUri: vi.fn(async () => null),
  } as unknown as IUserDataFilesService)
  services.set(IEditorGroupsService, {} as unknown as IEditorGroupsService)
  const inst = new InstantiationService(services)
  const utils = render(<AiModelsPanel />, {
    wrapper: ({ children }) => (
      <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
    ),
  })
  return { ...utils, aiModel }
}

function entryCard(id: string): HTMLElement {
  const el = [...screen.getAllByTestId('ai-provider-entry-card')].find(
    (n) => n.getAttribute('data-provider-id') === id,
  )
  expect(el, `provider entry card ${id}`).toBeTruthy()
  return el!
}

describe('AiModelsPanel', () => {
  it('renders the providers section with an entry card per provider', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER]
    aiModel.models = [KURO_MODEL]
    renderPanel(aiModel)
    await flushEffects()

    expect(screen.getByText('Providers')).toBeTruthy()
    expect(entryCard('kuro')).toBeTruthy()
  })

  it('removes a provider through updateProviders', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER]
    aiModel.models = [KURO_MODEL]
    renderPanel(aiModel)
    await flushEffects()

    const card = entryCard('kuro')
    fireEvent.click(within(card).getByRole('button', { name: 'Remove' }))
    await flushEffects()

    expect(aiModel.updateProviders).toHaveBeenCalledWith([])
  })

  it('hides the account-usage block entirely when no usageSource is declared', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER]
    aiModel.models = [KURO_MODEL]
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.queryByText('Account usage')).toBeNull()
    expect(aiModel.getAccountUsage).not.toHaveBeenCalled()
  })

  it('shows "Unavailable" when a usageSource is declared but no authoritative value exists', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [{ ...KURO_PROVIDER, usageSource: { id: 'http-json' } }]
    aiModel.models = [KURO_MODEL]
    aiModel.usages.set('kuro', undefined)
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.getByText('Unavailable')).toBeTruthy()
    expect(aiModel.getAccountUsage).toHaveBeenCalledWith('kuro')
  })

  it('only calls verifyProvider on an explicit "Test connection" click, not on render', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER]
    aiModel.models = [KURO_MODEL]
    renderPanel(aiModel)
    await flushEffects()

    expect(aiModel.verifyProvider).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await flushEffects()

    expect(aiModel.verifyProvider).toHaveBeenCalledTimes(1)
    expect(aiModel.verifyProvider).toHaveBeenCalledWith({
      id: 'kuro',
      protocol: 'anthropic-messages',
      baseUrl: 'https://kuro.example',
    })
  })

  it('shows the legacy-format banner when aiSettings.json is still two-layer', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.legacy = true
    renderPanel(aiModel)
    await flushEffects()

    expect(screen.getByTestId('ai-legacy-banner')).toBeTruthy()
  })

  it('surfaces provider issues visibly on the affected card', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER]
    aiModel.models = [KURO_MODEL]
    aiModel.issues = [{ providerId: 'kuro', reason: 'no-protocol', fatal: true }]
    renderPanel(aiModel)
    await flushEffects()

    expect(screen.getByText('No protocol declared')).toBeTruthy()
  })

  it('shows "Rate unknown" on models of a provider without a pricing source', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER]
    aiModel.models = [KURO_MODEL]
    renderPanel(aiModel)
    await flushEffects()

    expect(screen.getByText('Rate unknown')).toBeTruthy()
  })
})
