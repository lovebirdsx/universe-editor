/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  AiModelsPanel tests — the two-section (provider types / provider instances)
 *  rewrite: both sections render, type-level model pricing writes through
 *  updateProviderTypes, instance removal writes through updateProviders, the
 *  account-usage block honours the "authoritative source only" contract (hidden
 *  without a usageSource, "Unavailable" when the source yields nothing), and the
 *  connectivity dot only probes on an explicit "Test connection" click.
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
  type AiProviderInstance,
  type AiProviderType,
  type AiProviderTypeDescriptor,
} from '@universe-editor/platform'
import { IAiRateMirror } from '../../../services/ai/aiRateMirror.js'
import { AiModelsPanel } from '../AiModelsPanel.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => cleanup())

class FakeAiModelService {
  private readonly _onDidChangeModels = new Emitter<void>()
  private readonly _onDidChangeRemote = new Emitter<void>()
  readonly onDidChangeModels = this._onDidChangeModels.event
  readonly onDidChangeRemote = this._onDidChangeRemote.event

  types: Readonly<Record<string, AiProviderType>> = {}
  descriptors: readonly AiProviderTypeDescriptor[] = []
  instances: readonly AiProviderInstance[] = []
  models: readonly AiModelMetadata[] = []
  usages = new Map<string, AiAccountUsage | undefined>()

  getProviderTypes = vi.fn(async () => this.types)
  getProviderTypeDescriptors = vi.fn(async () => this.descriptors)
  getProviders = vi.fn(async () => this.instances)
  getModels = vi.fn(async () => this.models)
  updateProviderTypes = vi.fn(async (types: Readonly<Record<string, AiProviderType>>) => {
    this.types = { ...types }
  })
  updateProviders = vi.fn(async (providers: readonly AiProviderInstance[]) => {
    this.instances = [...providers]
  })
  refreshRemote = vi.fn(async () => {})
  setModelConfiguration = vi.fn(async () => {})
  getModelConfiguration = vi.fn(async (): Promise<AiModelConfiguration> => ({}))
  verifyProvider = vi.fn(async () => ({ ok: true, modelCount: 2 }))
  getAccountUsage = vi.fn(async (key: string) => this.usages.get(key))
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

function typeCard(id: string): HTMLElement {
  const el = [...screen.getAllByTestId('ai-type-card')].find(
    (n) => n.getAttribute('data-type-id') === id,
  )
  expect(el, `type card ${id}`).toBeTruthy()
  return el!
}

function instanceCard(key: string): HTMLElement {
  const el = [...screen.getAllByTestId('ai-instance-card')].find(
    (n) => n.getAttribute('data-provider-key') === key,
  )
  expect(el, `instance card ${key}`).toBeTruthy()
  return el!
}

const ANTHROPIC_TYPE: AiProviderType = {
  label: 'Anthropic',
  protocol: 'anthropic-messages',
  requiresApiKey: true,
  models: [{ id: 'claude-sonnet-4.5', pricing: { input: 3, output: 15 } }],
}
const ANTHROPIC_DESCRIPTOR: AiProviderTypeDescriptor = {
  id: 'anthropic',
  label: 'Anthropic',
  protocol: 'anthropic-messages',
  requiresApiKey: true,
  builtin: true,
}
const KURO_TYPE: AiProviderType = {
  label: 'Kuro',
  protocol: 'anthropic-messages',
  models: [{ id: 'qwen3-coder' }],
}
const KURO_DESCRIPTOR: AiProviderTypeDescriptor = {
  id: 'kuro',
  label: 'Kuro',
  protocol: 'anthropic-messages',
  requiresApiKey: true,
  builtin: false,
}

describe('AiModelsPanel', () => {
  it('renders both the provider-types and provider-instances sections', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.types = { anthropic: ANTHROPIC_TYPE }
    aiModel.descriptors = [ANTHROPIC_DESCRIPTOR]
    aiModel.instances = [{ name: 'default', type: 'anthropic' }]
    renderPanel(aiModel)
    await flushEffects()

    expect(screen.getByText('Provider Types')).toBeTruthy()
    expect(screen.getByText('Provider Instances')).toBeTruthy()
    expect(typeCard('anthropic')).toBeTruthy()
    expect(instanceCard('anthropic/default')).toBeTruthy()
  })

  it('edits a type-level model rate and writes the override through updateProviderTypes', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.types = { kuro: KURO_TYPE }
    aiModel.descriptors = [KURO_DESCRIPTOR]
    renderPanel(aiModel)
    await flushEffects()

    const card = typeCard('kuro')
    fireEvent.click(within(card).getByRole('button', { name: 'Fill in rate' }))

    const spins = within(card).getAllByRole('spinbutton')
    expect(spins.length).toBe(4)
    fireEvent.change(spins[0]!, { target: { value: '3' } })
    fireEvent.change(spins[1]!, { target: { value: '15' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    await flushEffects()

    expect(aiModel.updateProviderTypes).toHaveBeenCalledTimes(1)
    const arg = aiModel.updateProviderTypes.mock.calls[0]![0]
    expect(arg.kuro?.models?.[0]?.pricing).toEqual({ currency: 'USD', input: 3, output: 15 })
  })

  it('removes an instance through updateProviders', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.types = { anthropic: ANTHROPIC_TYPE }
    aiModel.descriptors = [ANTHROPIC_DESCRIPTOR]
    aiModel.instances = [{ name: 'default', type: 'anthropic' }]
    renderPanel(aiModel)
    await flushEffects()

    const card = instanceCard('anthropic/default')
    fireEvent.click(within(card).getByRole('button', { name: 'Remove' }))
    await flushEffects()

    expect(aiModel.updateProviders).toHaveBeenCalledWith([])
  })

  it('hides the account-usage block entirely when no usageSource is declared', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.types = { anthropic: ANTHROPIC_TYPE }
    aiModel.descriptors = [ANTHROPIC_DESCRIPTOR]
    aiModel.instances = [{ name: 'default', type: 'anthropic' }]
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.queryByText('Account usage')).toBeNull()
    expect(aiModel.getAccountUsage).not.toHaveBeenCalled()
  })

  it('shows "Unavailable" when a usageSource is declared but no authoritative value exists', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.types = { anthropic: ANTHROPIC_TYPE }
    aiModel.descriptors = [ANTHROPIC_DESCRIPTOR]
    aiModel.instances = [{ name: 'default', type: 'anthropic', usageSource: { id: 'http-json' } }]
    aiModel.usages.set('anthropic/default', undefined)
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.getByText('Unavailable')).toBeTruthy()
    expect(aiModel.getAccountUsage).toHaveBeenCalledWith('anthropic/default')
  })

  it('only calls verifyProvider on an explicit "Test connection" click, not on render', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.types = { anthropic: ANTHROPIC_TYPE }
    aiModel.descriptors = [ANTHROPIC_DESCRIPTOR]
    aiModel.instances = [{ name: 'default', type: 'anthropic' }]
    renderPanel(aiModel)
    await flushEffects()

    expect(aiModel.verifyProvider).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await flushEffects()

    expect(aiModel.verifyProvider).toHaveBeenCalledTimes(1)
    expect(aiModel.verifyProvider).toHaveBeenCalledWith({
      type: 'anthropic',
      name: 'default',
      protocol: 'anthropic-messages',
    })
  })
})
