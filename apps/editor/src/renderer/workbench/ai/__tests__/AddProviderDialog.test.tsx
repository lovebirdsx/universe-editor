/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  AddProviderDialog tests — the single-layer entry flow: no type branch, one
 *  entry is one gateway endpoint. Creates an entry through updateProviders,
 *  rejects a duplicate id, and rejects an id containing '/'.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Event,
  IAiModelService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
  type AiProviderEntry,
} from '@universe-editor/platform'
import { AddProviderDialog } from '../AddProviderDialog.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => cleanup())

/** Mirrors the dialog's own private constant — kept in sync by hand, not exported for tests. */
const DRAFT_KEY = 'ai.settings.addProvider.draft'

class FakeDialogAiModel {
  verifyProvider = vi.fn(async () => ({ ok: true, modelCount: 1 }))
  updateProviders = vi.fn(async () => {})
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

async function flushEffects(): Promise<void> {
  await act(async () => {})
}

/** Select is a self-rendered listbox, not a native <select> — drive it by clicking. */
async function pickOption(selectLabel: string, optionName: string | RegExp): Promise<void> {
  fireEvent.click(screen.getByRole('combobox', { name: selectLabel }))
  await flushEffects()
  fireEvent.click(screen.getByRole('option', { name: optionName }))
  await flushEffects()
}

function renderDialog(
  aiModel: FakeDialogAiModel,
  {
    existingProviders = [],
    storage = new FakeStorage(),
  }: { existingProviders?: readonly AiProviderEntry[]; storage?: FakeStorage } = {},
) {
  const services = new ServiceCollection()
  services.set(IAiModelService, aiModel as unknown as IAiModelService)
  services.set(IStorageService, storage as unknown as IStorageService)
  const inst = new InstantiationService(services)
  const utils = render(
    <AddProviderDialog
      existingProviders={existingProviders}
      onClose={vi.fn()}
      onCreated={vi.fn()}
    />,
    {
      wrapper: ({ children }) => (
        <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
      ),
    },
  )
  return { ...utils, aiModel }
}

describe('AddProviderDialog', () => {
  it('creates a single-layer provider entry through updateProviders', async () => {
    const aiModel = new FakeDialogAiModel()
    renderDialog(aiModel)
    await flushEffects()

    fireEvent.change(screen.getByPlaceholderText('my-gateway'), { target: { value: 'kuro' } })
    fireEvent.change(screen.getByPlaceholderText('https://…'), {
      target: { value: 'https://kuro.example' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await flushEffects()

    expect(aiModel.updateProviders).toHaveBeenCalledTimes(1)
    expect(aiModel.updateProviders).toHaveBeenCalledWith([
      {
        id: 'kuro',
        baseUrl: 'https://kuro.example',
        defaultProtocol: 'openai-chat',
        protocolMap: { 'openai-chat': [] },
      },
    ])
  })

  // Without a protocolMap the entry resolves to a fatal `no-protocol` issue and
  // vanishes from the list the moment it is created.
  it('seeds the chosen protocol with a discover list so the entry actually resolves', async () => {
    const aiModel = new FakeDialogAiModel()
    renderDialog(aiModel)
    await flushEffects()

    fireEvent.change(screen.getByPlaceholderText('my-gateway'), { target: { value: 'claude-gw' } })
    await pickOption('Default protocol', 'anthropic-messages')
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await flushEffects()

    expect(aiModel.updateProviders).toHaveBeenCalledWith([
      {
        id: 'claude-gw',
        defaultProtocol: 'anthropic-messages',
        protocolMap: { 'anthropic-messages': [] },
      },
    ])
  })

  it('a template seeds label, baseUrl, protocol map and pricing source', async () => {
    const aiModel = new FakeDialogAiModel()
    renderDialog(aiModel)
    await flushEffects()

    await pickOption('Template', /Anthropic \(official\)/)
    fireEvent.change(screen.getByPlaceholderText('my-gateway'), { target: { value: 'claude' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await flushEffects()

    expect(aiModel.updateProviders).toHaveBeenCalledWith([
      {
        id: 'claude',
        label: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        defaultProtocol: 'anthropic-messages',
        protocolMap: { 'anthropic-messages': [] },
        pricingSource: { id: 'catalog', options: { vendor: 'anthropic' } },
      },
    ])
  })

  it('a template never fills in the id or the API key', async () => {
    const aiModel = new FakeDialogAiModel()
    renderDialog(aiModel)
    await flushEffects()

    fireEvent.change(screen.getByPlaceholderText('my-gateway'), { target: { value: 'mine' } })
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-secret' } })
    await pickOption('Template', /OpenAI \(official\)/)

    expect((screen.getByPlaceholderText('my-gateway') as HTMLInputElement).value).toBe('mine')
    expect((screen.getByPlaceholderText('sk-…') as HTMLInputElement).value).toBe('sk-secret')
  })

  it('rejects a duplicate provider id', async () => {
    const aiModel = new FakeDialogAiModel()
    renderDialog(aiModel, { existingProviders: [{ id: 'kuro' }] })
    await flushEffects()

    fireEvent.change(screen.getByPlaceholderText('my-gateway'), { target: { value: 'kuro' } })

    expect(screen.getByText('That provider id already exists.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it("rejects a provider id containing '/'", async () => {
    const aiModel = new FakeDialogAiModel()
    renderDialog(aiModel)
    await flushEffects()

    fireEvent.change(screen.getByPlaceholderText('my-gateway'), { target: { value: 'ku/ro' } })

    expect(screen.getByText("Provider id must not contain '/'.")).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})

describe('AddProviderDialog — persisted draft', () => {
  // This key outlived an earlier { vendor, name, baseUrl } draft shape. Reading
  // `.id` off one of those yielded undefined, and the next render died on
  // `id.trim()` — a white screen for anyone who had opened the old dialog once.
  it('ignores a draft left behind by an older dialog shape', async () => {
    const storage = new FakeStorage()
    await storage.set(DRAFT_KEY, { vendor: 'openai', name: 'default', baseUrl: 'https://old' })
    renderDialog(new FakeDialogAiModel(), { storage })
    await flushEffects()

    expect((screen.getByPlaceholderText('my-gateway') as HTMLInputElement).value).toBe('')
    expect((screen.getByPlaceholderText('https://…') as HTMLInputElement).value).toBe('')
  })

  it('restores a well-formed draft', async () => {
    const storage = new FakeStorage()
    await storage.set(DRAFT_KEY, {
      id: 'kuro',
      baseUrl: 'https://kuro.example',
      template: 'custom',
    })
    renderDialog(new FakeDialogAiModel(), { storage })
    await flushEffects()

    expect((screen.getByPlaceholderText('my-gateway') as HTMLInputElement).value).toBe('kuro')
    expect((screen.getByPlaceholderText('https://…') as HTMLInputElement).value).toBe(
      'https://kuro.example',
    )
  })

  // The key gained a `template` field; a draft without one predates the template
  // picker and is taken all-or-nothing like every other shape change.
  it('ignores a draft written before the template picker existed', async () => {
    const storage = new FakeStorage()
    await storage.set(DRAFT_KEY, { id: 'kuro', baseUrl: 'https://kuro.example' })
    renderDialog(new FakeDialogAiModel(), { storage })
    await flushEffects()

    expect((screen.getByPlaceholderText('my-gateway') as HTMLInputElement).value).toBe('')
  })

  it('never persists the API key to storage', async () => {
    const storage = new FakeStorage()
    renderDialog(new FakeDialogAiModel(), { storage })
    await flushEffects()

    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-secret' } })
    fireEvent.change(screen.getByPlaceholderText('my-gateway'), { target: { value: 'kuro' } })
    await flushEffects()

    const written = JSON.stringify(await storage.get(DRAFT_KEY))
    expect(written).toContain('kuro')
    expect(written).not.toContain('sk-secret')
  })
})
