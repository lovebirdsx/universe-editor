/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  AiModelsPanel tests — the single-layer providers rewrite: entries render,
 *  removal writes through updateProviders, the account-usage block honours the
 *  "authoritative source only" contract (hidden without a usageSource,
 *  "Unavailable" when the source yields nothing), the connectivity dot probes
 *  automatically on mount and re-probes on connection edits (no manual button),
 *  the legacy-format banner shows when aiSettings.json is still two-layer,
 *  provider issues are surfaced visibly, and a provider without a pricing
 *  source shows "Rate unknown" on its models.
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
  getModelKnowledge = vi.fn(async () => ({}))
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

  fireModelsChanged(): void {
    this._onDidChangeModels.fire()
  }
}

class FakeStorage {
  private readonly map = new Map<string, unknown>()
  readonly onDidChangeWorkspaceScope = Event.None
  constructor(initial?: Readonly<Record<string, unknown>>) {
    for (const [key, value] of Object.entries(initial ?? {})) this.map.set(key, value)
  }
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

function renderPanel(
  aiModel: FakeAiModelService,
  confirmResult = { confirmed: true },
  storageInitial?: Readonly<Record<string, unknown>>,
) {
  const services = new ServiceCollection()
  services.set(IAiModelService, aiModel as unknown as IAiModelService)
  services.set(IAiRateMirror, rateMirrorStub)
  const storage = new FakeStorage(storageInitial)
  services.set(IStorageService, storage as unknown as IStorageService)
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
  return { ...utils, aiModel, storage }
}

function entryCard(id: string): HTMLElement {
  const el = [...screen.getAllByTestId('ai-provider-entry-card')].find(
    (n) => n.getAttribute('data-provider-id') === id,
  )
  expect(el, `provider entry card ${id}`).toBeTruthy()
  return el!
}

/**
 * The account-usage header badge, or null when the card shows none. It carries a
 * tooltip and lives among the other badges, so it is found by that attribute
 * rather than by its text — the text is the thing under test.
 */
function usageBadge(id: string): HTMLElement | null {
  const badges = entryCard(id).querySelector('[class*="cardBadges"]')
  return badges?.querySelector<HTMLElement>('[data-tooltip]') ?? null
}

/** The connectivity dot on a card, or null when the card has none. */
function connectivityDot(id: string): HTMLElement | null {
  return entryCard(id).querySelector('[data-status]')
}

function expectDotStatus(id: string, status: string): void {
  expect(connectivityDot(id)?.getAttribute('data-status')).toBe(status)
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
    fireEvent.click(within(card).getByRole('button', { name: 'Remove provider' }))
    await flushEffects()

    expect(aiModel.updateProviders).toHaveBeenCalledWith([])
  })

  it('shows no usage badge and fetches nothing when no usageSource is declared', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER]
    aiModel.models = [KURO_MODEL]
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    expect(screen.queryByText('Account usage')).toBeNull()
    expect(usageBadge('kuro')).toBeNull()
    expect(aiModel.getAccountUsage).not.toHaveBeenCalled()
  })

  it('shows "Unavailable" in the header badge when the source yields no authoritative value', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [{ ...KURO_PROVIDER, usageSource: { id: 'http-json' } }]
    aiModel.models = [KURO_MODEL]
    aiModel.usages.set('kuro', undefined)
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    expect(usageBadge('kuro')?.textContent).toBe('Unavailable')
    expect(aiModel.getAccountUsage).toHaveBeenCalledWith('kuro')
  })

  it('shows the used / limit pair in the header badge', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [{ ...KURO_PROVIDER, usageSource: { id: 'http-json' } }]
    aiModel.models = [KURO_MODEL]
    aiModel.usages.set('kuro', {
      kind: 'quota',
      usedUSD: 0.09,
      limitUSD: 3000,
      currency: 'CNY',
      fetchedAt: 1,
    })
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    expect(usageBadge('kuro')?.textContent).toBe('¥0.09 / ¥3,000')
  })

  it('keeps the usage badge visible while the card body is collapsed', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [{ ...KURO_PROVIDER, usageSource: { id: 'http-json' } }]
    aiModel.models = [KURO_MODEL]
    aiModel.usages.set('kuro', { kind: 'balance', remainingUSD: 29.91, fetchedAt: 1 })
    renderPanel(
      aiModel,
      { confirmed: true },
      {
        'ai.settings.models.collapsed': { 'provider:kuro': true },
      },
    )
    await flushEffects()
    await flushEffects()

    // The body is gone, so the detail row cannot be the source of the number.
    expect(screen.queryByText('Account usage')).toBeNull()
    expect(usageBadge('kuro')?.textContent).toBe('$29.91')
  })

  it('fetches usage for an entry that only inherits its usageSource', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [
      { id: 'root', baseUrl: 'https://gw.example', usageSource: { id: 'http-json' } },
      { id: 'leaf', extends: 'root' },
    ]
    aiModel.usages.set('leaf', { kind: 'quota', usedUSD: 1, limitUSD: 10, fetchedAt: 1 })
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    // main flattens `extends` before it fetches and caches under the child id, so
    // the inheriting entry has a number of its own — not asking for it was the bug.
    expect(aiModel.getAccountUsage).toHaveBeenCalledWith('leaf')
    expect(usageBadge('leaf')?.textContent).toBe('$1 / $10')
  })

  it('reports a failed usage read as Unavailable rather than spinning forever', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [{ ...KURO_PROVIDER, usageSource: { id: 'http-json' } }]
    aiModel.models = [KURO_MODEL]
    aiModel.getAccountUsage.mockRejectedValue(new Error('channel closed'))
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    expect(usageBadge('kuro')?.textContent).toBe('Unavailable')
  })

  it('asks only for providers with an effective usage source', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [
      { ...KURO_PROVIDER, usageSource: { id: 'http-json' } },
      { id: 'plain', baseUrl: 'https://plain.example' },
    ]
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    expect(aiModel.getAccountUsage.mock.calls.map(([id]) => id)).toEqual(['kuro'])
  })

  it('persists a card section collapse under its own key', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER]
    aiModel.models = [KURO_MODEL]
    const { storage } = renderPanel(aiModel)
    await flushEffects()

    // Pricing starts collapsed, so one click must expand it — a stored `true`
    // here would be the "click does nothing" bug.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Pricing source' }))
    await flushEffects()

    expect(storage.set).toHaveBeenCalledWith(
      'ai.settings.models.collapsed',
      expect.objectContaining({ 'provider:kuro:pricing': false }),
      expect.anything(),
    )
    expect(screen.getByRole('combobox', { name: 'Pricing source' })).toBeTruthy()
  })

  it('refreshing usage goes through refreshRemote and re-reads the cache', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [{ ...KURO_PROVIDER, usageSource: { id: 'http-json' } }]
    aiModel.models = [KURO_MODEL]
    aiModel.usages.set('kuro', undefined)
    renderPanel(
      aiModel,
      { confirmed: true },
      {
        'ai.settings.models.collapsed': { 'provider:kuro:usage': false },
      },
    )
    await flushEffects()
    await flushEffects()
    const before = aiModel.getAccountUsage.mock.calls.length

    aiModel.usages.set('kuro', { kind: 'quota', usedUSD: 2, limitUSD: 10, fetchedAt: 2 })
    fireEvent.click(screen.getByRole('button', { name: /Refresh usage/ }))
    await flushEffects()
    await flushEffects()

    expect(aiModel.refreshRemote).toHaveBeenCalledWith('kuro')
    expect(aiModel.getAccountUsage.mock.calls.length).toBeGreaterThan(before)
    expect(usageBadge('kuro')?.textContent).toBe('$2 / $10')
  })

  it('probes a testable provider automatically on mount, without a manual button', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER]
    aiModel.models = [KURO_MODEL]
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    expect(aiModel.verifyProvider).toHaveBeenCalledTimes(1)
    expect(aiModel.verifyProvider).toHaveBeenCalledWith({
      id: 'kuro',
      protocol: 'anthropic-messages',
      baseUrl: 'https://kuro.example',
    })
    expectDotStatus('kuro', 'ok')
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull()
  })

  it('skips the auto-probe when there is no effective base URL', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [{ id: 'kuro', protocolMap: { 'anthropic-messages': ['qwen3-coder'] } }]
    aiModel.models = [KURO_MODEL]
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()

    expect(aiModel.verifyProvider).not.toHaveBeenCalled()
    expectDotStatus('kuro', 'idle')
  })

  it('shows a fresh cached result without probing again', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER]
    aiModel.models = [KURO_MODEL]
    renderPanel(aiModel, undefined, {
      'ai.settings.connectivity.kuro': { ok: true, modelCount: 2, at: Date.now() },
    })
    await flushEffects()
    await flushEffects()

    expect(aiModel.verifyProvider).not.toHaveBeenCalled()
    expectDotStatus('kuro', 'ok')
  })

  it('probes when the cached result is stale', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER]
    aiModel.models = [KURO_MODEL]
    renderPanel(aiModel, undefined, {
      'ai.settings.connectivity.kuro': { ok: true, modelCount: 2, at: Date.now() - 6 * 60 * 1000 },
    })
    await flushEffects()
    await flushEffects()

    expect(aiModel.verifyProvider).toHaveBeenCalledTimes(1)
  })

  it('a model-list reload does not re-probe', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER]
    aiModel.models = [KURO_MODEL]
    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()
    expect(aiModel.verifyProvider).toHaveBeenCalledTimes(1)

    aiModel.fireModelsChanged()
    await flushEffects()
    await flushEffects()

    expect(aiModel.verifyProvider).toHaveBeenCalledTimes(1)
  })

  it('editing the base URL re-probes after the debounce', async () => {
    vi.useFakeTimers()
    try {
      const aiModel = new FakeAiModelService()
      aiModel.providers = [KURO_PROVIDER]
      aiModel.models = [KURO_MODEL]
      renderPanel(aiModel)
      await flushEffects()
      await flushEffects()
      expect(aiModel.verifyProvider).toHaveBeenCalledTimes(1)

      const input = within(entryCard('kuro')).getByLabelText('Base URL')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'https://kuro2.example' } })
      fireEvent.blur(input)
      await flushEffects()
      await flushEffects()

      await act(() => vi.advanceTimersByTimeAsync(600))
      await flushEffects()

      expect(aiModel.verifyProvider).toHaveBeenCalledTimes(2)
      expect(aiModel.verifyProvider).toHaveBeenLastCalledWith({
        id: 'kuro',
        protocol: 'anthropic-messages',
        baseUrl: 'https://kuro2.example',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('consecutive edits collapse into a single re-probe with the final value', async () => {
    vi.useFakeTimers()
    try {
      const aiModel = new FakeAiModelService()
      aiModel.providers = [KURO_PROVIDER]
      aiModel.models = [KURO_MODEL]
      renderPanel(aiModel)
      await flushEffects()
      await flushEffects()

      const first = within(entryCard('kuro')).getByLabelText('Base URL')
      fireEvent.focus(first)
      fireEvent.change(first, { target: { value: 'https://kuro2.example' } })
      fireEvent.blur(first)
      await flushEffects()
      await flushEffects()

      const second = within(entryCard('kuro')).getByLabelText('Base URL')
      fireEvent.focus(second)
      fireEvent.change(second, { target: { value: 'https://kuro3.example' } })
      fireEvent.blur(second)
      await flushEffects()
      await flushEffects()

      await act(() => vi.advanceTimersByTimeAsync(600))
      await flushEffects()

      expect(aiModel.verifyProvider).toHaveBeenCalledTimes(2)
      expect(aiModel.verifyProvider).toHaveBeenLastCalledWith({
        id: 'kuro',
        protocol: 'anthropic-messages',
        baseUrl: 'https://kuro3.example',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a stale in-flight result does not override a newer one', async () => {
    vi.useFakeTimers()
    try {
      const aiModel = new FakeAiModelService()
      aiModel.providers = [KURO_PROVIDER]
      aiModel.models = [KURO_MODEL]
      const gates: Array<(result: { ok: boolean; modelCount: number; error?: string }) => void> = []
      aiModel.verifyProvider = vi.fn(
        () =>
          new Promise((resolve) => {
            gates.push(resolve)
          }),
      )

      renderPanel(aiModel)
      await flushEffects()
      await flushEffects()
      expect(gates).toHaveLength(1)

      const input = within(entryCard('kuro')).getByLabelText('Base URL')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'https://kuro2.example' } })
      fireEvent.blur(input)
      await flushEffects()
      await flushEffects()
      await act(() => vi.advanceTimersByTimeAsync(600))
      await flushEffects()
      expect(gates).toHaveLength(2)

      // The newer probe finishes first with a good result; the stale mount
      // probe must not paint over it afterwards.
      gates[1]?.({ ok: true, modelCount: 5 })
      await flushEffects()
      expectDotStatus('kuro', 'ok')

      gates[0]?.({ ok: false, modelCount: 0, error: 'stale failure' })
      await flushEffects()

      expectDotStatus('kuro', 'ok')
    } finally {
      vi.useRealTimers()
    }
  })

  it('editing a connection field re-probes even with a fresh cached result', async () => {
    vi.useFakeTimers()
    try {
      const aiModel = new FakeAiModelService()
      aiModel.providers = [KURO_PROVIDER]
      aiModel.models = [KURO_MODEL]
      renderPanel(aiModel, undefined, {
        'ai.settings.connectivity.kuro': { ok: true, modelCount: 2, at: Date.now() },
      })
      await flushEffects()
      await flushEffects()
      expect(aiModel.verifyProvider).not.toHaveBeenCalled()
      expectDotStatus('kuro', 'ok')

      const input = within(entryCard('kuro')).getByLabelText('Base URL')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'https://kuro2.example' } })
      fireEvent.blur(input)
      await flushEffects()
      await flushEffects()
      await act(() => vi.advanceTimersByTimeAsync(600))
      await flushEffects()

      expect(aiModel.verifyProvider).toHaveBeenCalledTimes(1)
      expect(aiModel.verifyProvider).toHaveBeenCalledWith({
        id: 'kuro',
        protocol: 'anthropic-messages',
        baseUrl: 'https://kuro2.example',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('clearing the base URL invalidates an in-flight probe immediately', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER]
    aiModel.models = [KURO_MODEL]
    const gates: Array<(result: { ok: boolean; modelCount: number; error?: string }) => void> = []
    aiModel.verifyProvider = vi.fn(
      () =>
        new Promise((resolve) => {
          gates.push(resolve)
        }),
    )

    renderPanel(aiModel)
    await flushEffects()
    await flushEffects()
    expect(gates).toHaveLength(1)
    expectDotStatus('kuro', 'checking')

    const input = within(entryCard('kuro')).getByLabelText('Base URL')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '  ' } })
    fireEvent.blur(input)
    await flushEffects()
    await flushEffects()
    expectDotStatus('kuro', 'idle')

    gates[0]?.({ ok: true, modelCount: 3 })
    await flushEffects()

    expectDotStatus('kuro', 'idle')
  })

  it('clearing the base URL falls back to "not tested" without probing', async () => {
    vi.useFakeTimers()
    try {
      const aiModel = new FakeAiModelService()
      aiModel.providers = [KURO_PROVIDER]
      aiModel.models = [KURO_MODEL]
      renderPanel(aiModel)
      await flushEffects()
      await flushEffects()
      expect(aiModel.verifyProvider).toHaveBeenCalledTimes(1)
      expectDotStatus('kuro', 'ok')

      const input = within(entryCard('kuro')).getByLabelText('Base URL')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: '  ' } })
      fireEvent.blur(input)
      await flushEffects()
      await flushEffects()
      await act(() => vi.advanceTimersByTimeAsync(600))
      await flushEffects()

      expect(aiModel.verifyProvider).toHaveBeenCalledTimes(1)
      expectDotStatus('kuro', 'idle')
    } finally {
      vi.useRealTimers()
    }
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

  it('writes a field through on blur and flags it as saved', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER]
    aiModel.models = [KURO_MODEL]
    renderPanel(aiModel)
    await flushEffects()

    const input = within(entryCard('kuro')).getByLabelText('Base URL')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'https://kuro2.example' } })
    fireEvent.blur(input)
    await flushEffects()

    expect(aiModel.updateProviders).toHaveBeenCalledWith([
      { ...KURO_PROVIDER, baseUrl: 'https://kuro2.example' },
    ])
    expect(screen.getByTestId('ai-provider-saved')).toBeTruthy()
  })

  it('clearing a field deletes the key rather than writing an empty string', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER]
    aiModel.models = [KURO_MODEL]
    renderPanel(aiModel)
    await flushEffects()

    const input = within(entryCard('kuro')).getByLabelText('Base URL')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '  ' } })
    fireEvent.blur(input)
    await flushEffects()

    const written = aiModel.updateProviders.mock.calls[0]?.[0]
    expect(written).toBeTruthy()
    expect(Object.keys(written![0] as object)).not.toContain('baseUrl')
  })

  it('a hot reload of aiSettings.json does not overwrite a focused input', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER]
    aiModel.models = [KURO_MODEL]
    renderPanel(aiModel)
    await flushEffects()

    const input = within(entryCard('kuro')).getByLabelText<HTMLInputElement>('Base URL')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'half-typed' } })

    aiModel.providers = [{ ...KURO_PROVIDER, baseUrl: 'https://changed.example' }]
    aiModel.fireModelsChanged()
    await flushEffects()

    expect(input.value).toBe('half-typed')
  })

  it('duplicates a provider under a free id', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER]
    aiModel.models = [KURO_MODEL]
    renderPanel(aiModel)
    await flushEffects()

    fireEvent.click(within(entryCard('kuro')).getByRole('button', { name: 'Duplicate provider' }))
    await flushEffects()

    expect(aiModel.updateProviders).toHaveBeenCalledWith([
      KURO_PROVIDER,
      { ...KURO_PROVIDER, id: 'kuro-copy' },
    ])
  })

  // updateProviders replaces the whole array, so a second commit issued while the
  // first is still in flight must not start from the pre-first-write snapshot.
  // Tabbing from one field straight into another is exactly that timing.
  it('a second field edit committed mid-flight does not undo the first', async () => {
    const other: AiProviderEntry = { id: 'other', baseUrl: 'https://other.example' }
    const aiModel = new FakeAiModelService()
    aiModel.providers = [KURO_PROVIDER, other]
    aiModel.models = [KURO_MODEL]

    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = aiModel.updateProviders
    let gated = true
    aiModel.updateProviders = vi.fn(async (providers: readonly AiProviderEntry[]) => {
      if (gated) {
        gated = false
        await gate
      }
      await original(providers)
    })

    renderPanel(aiModel)
    await flushEffects()

    const first = within(entryCard('kuro')).getByLabelText<HTMLInputElement>('Base URL')
    fireEvent.focus(first)
    fireEvent.change(first, { target: { value: 'https://kuro2.example' } })
    fireEvent.blur(first)

    const second = within(entryCard('other')).getByLabelText<HTMLInputElement>('Base URL')
    fireEvent.focus(second)
    fireEvent.change(second, { target: { value: 'https://other2.example' } })
    fireEvent.blur(second)

    release?.()
    await flushEffects()
    await flushEffects()

    expect(aiModel.providers).toEqual([
      { ...KURO_PROVIDER, baseUrl: 'https://kuro2.example' },
      { ...other, baseUrl: 'https://other2.example' },
    ])
  })
})
