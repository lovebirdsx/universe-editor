/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  AiModelKnowledgePanel tests — the user layer of the `models` knowledge base:
 *  the section split with the built-in section collapsed by default, the empty
 *  state, overriding a built-in entry writes an EMPTY object (never a
 *  materialized copy), add-model dialog validation with its Override affordance,
 *  per-field commits (text / clear-deletes-key / capabilities quad / numbers /
 *  reasoning effort), the atomic rename and how the confirmations name
 *  referencing providers, remove/reset flows, the legacy-format banner, the
 *  "no write before the first read lands" gate, and the Saved flag.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  Emitter,
  Event,
  IAiModelService,
  IDialogService,
  IEditorGroupsService,
  IStorageService,
  IUserDataFilesService,
  InstantiationService,
  ServiceCollection,
  type AiModelKnowledge,
  type AiProviderEntry,
  type IConfirmOptions,
  type IConfirmResult,
} from '@universe-editor/platform'
import { AiModelKnowledgePanel } from '../AiModelKnowledgePanel.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => cleanup())

const CUSTOM_KEY = 'kimi-k3'
const BUILTIN_KEY = 'claude-sonnet-5'

const REFERRING_PROVIDER: AiProviderEntry = {
  id: 'gw',
  protocolMap: { 'anthropic-messages': [CUSTOM_KEY] },
}

const EXPLICIT_REF_PROVIDER: AiProviderEntry = {
  id: 'gw',
  protocolMap: { 'anthropic-messages': [{ id: 'wire-name', ref: CUSTOM_KEY }] },
}

class FakeAiModelService {
  private readonly _onDidChangeModels = new Emitter<void>()
  readonly onDidChangeModels = this._onDidChangeModels.event

  providers: readonly AiProviderEntry[] = []
  knowledge: Readonly<Record<string, AiModelKnowledge>> = {}
  legacy = false
  /** Set to hold `getUserModelKnowledge` open, to test the pre-load write gate. */
  gate: Promise<void> | undefined

  getProviders = vi.fn(async () => this.providers)
  getUserModelKnowledge = vi.fn(async () => {
    if (this.gate !== undefined) await this.gate
    return this.knowledge
  })
  isLegacySettingsFormat = vi.fn(async () => this.legacy)
  // The panel reloads after every write, so the fake must remember what it got
  // or the UI snaps back to the pre-write snapshot and the next case fails.
  updateModelKnowledge = vi.fn(async (models: Readonly<Record<string, AiModelKnowledge>>) => {
    this.knowledge = { ...models }
  })
  updateProviders = vi.fn(async (providers: readonly AiProviderEntry[]) => {
    this.providers = [...providers]
  })
  updateModelKnowledgeAndProviders = vi.fn(
    async (
      models: Readonly<Record<string, AiModelKnowledge>>,
      providers: readonly AiProviderEntry[],
    ) => {
      this.knowledge = { ...models }
      this.providers = [...providers]
    },
  )
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

function renderPanel(
  aiModel: FakeAiModelService,
  options: { readonly promptResult?: string; readonly confirmResult?: IConfirmResult } = {},
) {
  const confirm = vi.fn(
    async (_opts: IConfirmOptions): Promise<IConfirmResult> =>
      options.confirmResult ?? { confirmed: true, choice: 'primary' },
  )
  const prompt = vi.fn(async (): Promise<string | undefined> => options.promptResult)
  const services = new ServiceCollection()
  services.set(IAiModelService, aiModel as unknown as IAiModelService)
  services.set(IStorageService, new FakeStorage() as unknown as IStorageService)
  services.set(IDialogService, { confirm, prompt } as unknown as IDialogService)
  services.set(IUserDataFilesService, {
    getFileUri: vi.fn(async () => null),
  } as unknown as IUserDataFilesService)
  services.set(IEditorGroupsService, {} as unknown as IEditorGroupsService)
  const inst = new InstantiationService(services)
  const utils = render(<AiModelKnowledgePanel />, {
    wrapper: ({ children }) => (
      <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
    ),
  })
  return { ...utils, aiModel, confirm, prompt }
}

/** The editable card for one knowledge key, found by its data-model-key. */
function knowledgeCard(key: string): HTMLElement {
  const el = [...screen.getAllByTestId('ai-model-knowledge-card')].find(
    (n) => n.getAttribute('data-model-key') === key,
  )
  expect(el, `knowledge card ${key}`).toBeTruthy()
  return el!
}

/** One row of the built-in section, found by its data-model-key. */
function builtinRow(key: string): HTMLElement {
  const el = [...screen.getAllByTestId('ai-knowledge-builtin-row')].find(
    (n) => n.getAttribute('data-model-key') === key,
  )
  expect(el, `builtin row ${key}`).toBeTruthy()
  return el!
}

async function expandBuiltinSection(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Built-in Models' }))
  await flushEffects()
}

/** The knowledge map of the most recent write, for inspecting the payload. */
function lastKnowledgeWrite(
  aiModel: FakeAiModelService,
): Readonly<Record<string, AiModelKnowledge>> {
  const written = aiModel.updateModelKnowledge.mock.calls.at(-1)?.[0]
  expect(written, 'updateModelKnowledge payload').toBeTruthy()
  return written!
}

describe('AiModelKnowledgePanel', () => {
  it('renders a Custom badge for a user-layer key and starts the built-in section collapsed', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.knowledge = { [CUSTOM_KEY]: { name: 'Kimi K3' } }
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    expect(within(knowledgeCard(CUSTOM_KEY)).getByText('Custom')).toBeTruthy()

    const builtinHeader = screen.getByRole('button', { name: 'Built-in Models' })
    expect(builtinHeader.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('ai-knowledge-builtin-row')).toBeNull()

    fireEvent.click(builtinHeader)
    await flushEffects()

    expect(builtinHeader.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByTestId('ai-knowledge-builtin-row').length).toBeGreaterThan(0)
  })

  it('shows the empty state when the user layer is empty', async () => {
    const aiModel = new FakeAiModelService()
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.getByTestId('ai-knowledge-empty')).toBeTruthy()
  })

  it('overriding a built-in model writes an empty object, not a materialized copy', async () => {
    const aiModel = new FakeAiModelService()
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    await expandBuiltinSection()
    fireEvent.click(within(builtinRow(BUILTIN_KEY)).getByRole('button', { name: 'Override' }))

    await waitFor(() =>
      expect(aiModel.updateModelKnowledge).toHaveBeenCalledWith({ [BUILTIN_KEY]: {} }),
    )
  })

  it('validates the add-model key and creates an empty entry for a new key', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.knowledge = { [CUSTOM_KEY]: {} }
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: 'Add Model' }))
    await flushEffects()
    const input = screen.getByLabelText<HTMLInputElement>('Model key')

    fireEvent.change(input, { target: { value: 'bad/key' } })
    expect(screen.getByText("A model key must not contain '/'.")).toBeTruthy()

    fireEvent.change(input, { target: { value: CUSTOM_KEY } })
    expect(screen.getByText('That model key already exists.')).toBeTruthy()

    fireEvent.change(input, { target: { value: BUILTIN_KEY } })
    expect(screen.getByRole('button', { name: 'Override' })).toBeTruthy()

    fireEvent.change(input, { target: { value: 'kimi-k3-pro' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(aiModel.updateModelKnowledge).toHaveBeenCalledWith({
        [CUSTOM_KEY]: {},
        'kimi-k3-pro': {},
      }),
    )
  })

  it('commits a display-name edit through updateModelKnowledge on blur', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.knowledge = { [CUSTOM_KEY]: {} }
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    const input = within(knowledgeCard(CUSTOM_KEY)).getByLabelText('Display name')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Kimi K3' } })
    fireEvent.blur(input)

    await waitFor(() =>
      expect(aiModel.updateModelKnowledge).toHaveBeenCalledWith({
        [CUSTOM_KEY]: { name: 'Kimi K3' },
      }),
    )
  })

  it('clearing a display name deletes the key instead of writing an empty string', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.knowledge = { [CUSTOM_KEY]: { name: 'Kimi K3' } }
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    const input = within(knowledgeCard(CUSTOM_KEY)).getByLabelText<HTMLInputElement>('Display name')
    expect(input.value).toBe('Kimi K3')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    await waitFor(() => expect(aiModel.updateModelKnowledge).toHaveBeenCalled())
    const entry = lastKnowledgeWrite(aiModel)[CUSTOM_KEY]
    expect(entry).toEqual({})
    expect('name' in (entry ?? {})).toBe(false)
  })

  it('toggling one capability writes the complete boolean quad', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.knowledge = { [CUSTOM_KEY]: {} }
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    fireEvent.click(within(knowledgeCard(CUSTOM_KEY)).getByRole('checkbox', { name: 'Vision' }))

    await waitFor(() => expect(aiModel.updateModelKnowledge).toHaveBeenCalled())
    const capabilities = lastKnowledgeWrite(aiModel)[CUSTOM_KEY]?.capabilities
    expect(capabilities).toEqual({
      streaming: true,
      vision: true,
      promptCaching: false,
      toolCalling: false,
    })
    for (const value of Object.values(capabilities ?? {})) {
      expect(typeof value).toBe('boolean')
    }
  })

  it('rejects a non-numeric token limit without writing and accepts a number', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.knowledge = { [CUSTOM_KEY]: {} }
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    const input = within(knowledgeCard(CUSTOM_KEY)).getByLabelText('Max input tokens')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '12a' } })
    fireEvent.blur(input)
    await flushEffects()

    expect(aiModel.updateModelKnowledge).not.toHaveBeenCalled()
    expect(input.getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(input, { target: { value: '1000' } })
    fireEvent.blur(input)

    await waitFor(() =>
      expect(aiModel.updateModelKnowledge).toHaveBeenCalledWith({
        [CUSTOM_KEY]: { maxInputTokens: 1000 },
      }),
    )
  })

  it('parses reasoning-effort levels on commit: trimmed and deduplicated', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.knowledge = { [CUSTOM_KEY]: {} }
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    const input = within(knowledgeCard(CUSTOM_KEY)).getByLabelText('Reasoning effort levels')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'low, high, low' } })
    fireEvent.blur(input)

    await waitFor(() =>
      expect(aiModel.updateModelKnowledge).toHaveBeenCalledWith({
        [CUSTOM_KEY]: { supportsReasoningEffort: ['low', 'high'] },
      }),
    )
  })

  it('renames the key and the explicit ref in ONE write, naming the provider', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.knowledge = { [CUSTOM_KEY]: { name: 'Kimi' } }
    aiModel.providers = [EXPLICIT_REF_PROVIDER]
    const { confirm } = renderPanel(aiModel, { promptResult: 'kimi-k4' })
    await flushEffects()
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: 'Rename model key' }))

    // Both layers in a single call: a split write can fail in between and leave
    // the provider pointing at a key that no longer exists.
    await waitFor(() =>
      expect(aiModel.updateModelKnowledgeAndProviders).toHaveBeenCalledWith(
        { 'kimi-k4': { name: 'Kimi' } },
        [
          {
            id: 'gw',
            protocolMap: { 'anthropic-messages': [{ id: 'wire-name', ref: 'kimi-k4' }] },
          },
        ],
      ),
    )
    expect(aiModel.updateModelKnowledge).not.toHaveBeenCalled()
    expect(aiModel.updateProviders).not.toHaveBeenCalled()

    const renameConfirm = confirm.mock.calls.find(([opts]) => opts.message.includes('Rename'))
    expect(renameConfirm?.[0]?.detail).toContain('gw')
  })

  it('refuses to rename onto a built-in key instead of silently making an override', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.knowledge = { [CUSTOM_KEY]: { name: 'Kimi' } }
    const { confirm } = renderPanel(aiModel, { promptResult: BUILTIN_KEY })
    await flushEffects()
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: 'Rename model key' }))
    await flushEffects()
    await flushEffects()

    expect(aiModel.updateModelKnowledgeAndProviders).not.toHaveBeenCalled()
    expect(aiModel.updateModelKnowledge).not.toHaveBeenCalled()
    const error = confirm.mock.calls.find(([opts]) => opts.type === 'error')
    expect(error?.[0]?.message).toContain(BUILTIN_KEY)
  })

  it('mentions both halves when a provider mixes an explicit and a bare reference', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.knowledge = { [CUSTOM_KEY]: {} }
    aiModel.providers = [
      {
        id: 'gw',
        protocolMap: { 'anthropic-messages': [CUSTOM_KEY, { id: 'wire', ref: CUSTOM_KEY }] },
      },
    ]
    const { confirm } = renderPanel(aiModel, { promptResult: 'kimi-k4' })
    await flushEffects()
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: 'Rename model key' }))
    await waitFor(() => expect(aiModel.updateModelKnowledgeAndProviders).toHaveBeenCalled())

    const detail = confirm.mock.calls.find(([o]) => o.message.includes('Rename'))?.[0]?.detail ?? ''
    expect(detail).toContain('Updated automatically')
    expect(detail).toContain('Cannot be updated')
  })

  it('removing a referenced model names the provider in the confirm detail', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.knowledge = { [CUSTOM_KEY]: { name: 'Kimi' } }
    aiModel.providers = [REFERRING_PROVIDER]
    const { confirm } = renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: 'Remove model' }))

    await waitFor(() => expect(aiModel.updateModelKnowledge).toHaveBeenCalledWith({}))
    expect(confirm.mock.calls[0]?.[0]?.detail).toContain('gw')
  })

  it('resetting an override shows the built-in label and deletes the key on confirm', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.knowledge = { [BUILTIN_KEY]: { name: 'My Override' } }
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    const card = knowledgeCard(BUILTIN_KEY)
    expect(within(card).getByText('Overrides built-in')).toBeTruthy()
    expect(within(card).queryByRole('button', { name: 'Remove model' })).toBeNull()

    fireEvent.click(within(card).getByRole('button', { name: 'Reset to built-in' }))

    await waitFor(() => expect(aiModel.updateModelKnowledge).toHaveBeenCalledWith({}))
  })

  it('shows the legacy banner and disables adding models in the legacy format', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.legacy = true
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.getByTestId('ai-knowledge-legacy-banner')).toBeTruthy()
    const addButtons = screen.getAllByRole('button', { name: 'Add Model' })
    expect(addButtons.length).toBeGreaterThan(0)
    for (const button of addButtons) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('does not rewrite a legacy file when opening it — that is the file we promised to leave alone', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.legacy = true
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    const banner = screen.getByTestId('ai-knowledge-legacy-banner')
    fireEvent.click(within(banner).getByRole('button', { name: 'Open aiSettings.json' }))
    await flushEffects()
    await flushEffects()

    expect(aiModel.updateModelKnowledge).not.toHaveBeenCalled()
  })

  it('writes nothing before the first read lands, so an early click cannot wipe the file', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.knowledge = { [CUSTOM_KEY]: { name: 'Kimi K3' } }
    let openGate = (): void => {}
    aiModel.gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    renderPanel(aiModel)
    await flushEffects()

    expect(screen.getByTestId('ai-knowledge-loading')).toBeTruthy()
    // Override lives in the built-in section, which renders regardless of load
    // state — its button is the one that used to reach a write with an empty
    // snapshot and replace the user's whole `models` map.
    await expandBuiltinSection()
    const override = within(builtinRow(BUILTIN_KEY)).getByRole<HTMLButtonElement>('button', {
      name: 'Override',
    })
    expect(override.disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add Model' }).disabled).toBe(true)

    fireEvent.click(override)
    await flushEffects()
    expect(aiModel.updateModelKnowledge).not.toHaveBeenCalled()

    aiModel.gate = undefined
    await act(async () => {
      openGate()
    })
    await flushEffects()
    expect(
      within(builtinRow(BUILTIN_KEY)).getByRole<HTMLButtonElement>('button', {
        name: 'Override',
      }).disabled,
    ).toBe(false)
  })

  it('locks editing when the initial read fails rather than treating it as an empty map', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.getUserModelKnowledge = vi.fn(async () => {
      throw new Error('ipc down')
    })
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.getByTestId('ai-knowledge-load-failed')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add Model' }).disabled).toBe(true)
  })

  it('stamps the Saved indicator after a successful field commit', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.knowledge = { [CUSTOM_KEY]: {} }
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    const input = within(knowledgeCard(CUSTOM_KEY)).getByLabelText('Display name')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Kimi K3' } })
    fireEvent.blur(input)

    await waitFor(() => expect(screen.getByTestId('ai-provider-saved')).toBeTruthy())
  })
})
