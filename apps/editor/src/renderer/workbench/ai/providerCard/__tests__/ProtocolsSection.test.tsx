/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  ProtocolsSection tests — pins the contract of `protocolMap` editing: mode
 *  switches between "discover" (`[]`) and a static list, the last-protocol
 *  removal gate, the pin-discovered shortcut, and the deliberate distinction
 *  between clearing a root entry (`undefined`) and clearing an inheriting
 *  entry (`{}` — a meaningful "speak nothing" override).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type {
  AiModelConfiguration,
  AiModelKnowledge,
  AiModelMetadata,
  AiProtocolMap,
  AiProviderEntry,
  AiWireProtocol,
  IAiModelService,
  IDialogService,
} from '@universe-editor/platform'
import { ProtocolsSection } from '../ProtocolsSection.js'

afterEach(() => cleanup())

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

function makeModel(providerId: string, protocol: string, channelModel: string): AiModelMetadata {
  return {
    id: `${providerId}/${protocol}/${channelModel}`,
    providerId,
    protocol: channelModel === '' ? 'openai-chat' : (protocol as AiModelMetadata['protocol']),
    channelModel,
    name: channelModel,
    family: channelModel,
    maxInputTokens: 0,
    maxOutputTokens: 0,
    capabilities: { streaming: true },
  }
}

interface Rendered {
  readonly onChange: ReturnType<typeof vi.fn<(map: AiProtocolMap | undefined) => void>>
  readonly dialog: { confirm: ReturnType<typeof vi.fn> }
  readonly verifyProvider: ReturnType<typeof vi.fn>
}

function renderSection({
  provider,
  allProviders = [provider],
  models = [],
  knowledge = {},
  confirmResult = { confirmed: true, choice: 'primary' as const },
  probeIds = [],
  isCollapsed = () => false,
  onToggleCollapsed = vi.fn<(protocol: AiWireProtocol) => void>(),
}: {
  readonly provider: AiProviderEntry
  readonly allProviders?: readonly AiProviderEntry[]
  readonly models?: readonly AiModelMetadata[]
  readonly knowledge?: Readonly<Record<string, AiModelKnowledge>>
  readonly confirmResult?: { confirmed: boolean; choice: 'primary' | 'secondary' | 'cancel' }
  /** What the endpoint reports when ProbeModelsDialog mounts. */
  readonly probeIds?: readonly string[]
  readonly isCollapsed?: (protocol: AiWireProtocol) => boolean
  readonly onToggleCollapsed?: (protocol: AiWireProtocol) => void
}): Rendered {
  const onChange = vi.fn<(map: AiProtocolMap | undefined) => void>()
  const dialog = { confirm: vi.fn(async () => confirmResult) }
  // ProbeModelsDialog fires verifyProvider the moment it mounts; the shape here
  // must match AiProviderVerifyResult or the dialog silently renders nothing.
  const verifyProvider = vi.fn(async () => ({
    ok: true as const,
    modelCount: probeIds.length,
    modelIds: probeIds,
  }))
  const aiModel = { verifyProvider } as unknown as IAiModelService
  render(
    <ProtocolsSection
      aiModel={aiModel}
      dialog={dialog as unknown as IDialogService}
      provider={provider}
      allProviders={allProviders}
      models={models}
      knowledge={knowledge}
      filter=""
      onChange={onChange}
      onConfigure={vi.fn(async (_id: string, _c: AiModelConfiguration) => {})}
      getConfiguration={vi.fn(async (_id: string) => ({}))}
      isCollapsed={isCollapsed}
      onToggleCollapsed={onToggleCollapsed}
    />,
  )
  return { onChange, dialog, verifyProvider }
}

describe('ProtocolsSection', () => {
  it('switching discover → static with nothing resolved opens the probe dialog instead of writing', async () => {
    const provider: AiProviderEntry = { id: 'p', protocolMap: { 'openai-chat': [] } }
    const { onChange } = renderSection({ provider })
    await flushEffects()

    // No resolved models, so setMode('static') opens ProbeModelsDialog rather
    // than committing an empty static list.
    await pickOption('Model list mode', 'Static list')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('ai-protocol-openai-chat')).toBeTruthy()
  })

  it('switching static → discover commits an empty array for that protocol', async () => {
    const provider: AiProviderEntry = {
      id: 'p',
      protocolMap: { 'openai-chat': ['gpt-4o'] },
    }
    const { onChange } = renderSection({ provider })
    await flushEffects()

    await pickOption('Model list mode', 'Discover from endpoint')
    expect(onChange).toHaveBeenCalledWith({ 'openai-chat': [] })
  })

  it('removing a non-last protocol writes without confirmation', async () => {
    const provider: AiProviderEntry = {
      id: 'p',
      protocolMap: { 'openai-chat': [], 'anthropic-messages': [] },
    }
    const { onChange, dialog } = renderSection({ provider })
    await flushEffects()

    const block = screen.getByTestId('ai-protocol-openai-chat')
    fireEvent.click(within(block).getByRole('button', { name: /Remove protocol openai-chat/ }))
    await flushEffects()

    expect(dialog.confirm).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith({ 'anthropic-messages': [] })
  })

  it('removing the last protocol asks first; a cancelled confirm writes nothing', async () => {
    const provider: AiProviderEntry = { id: 'p', protocolMap: { 'openai-chat': [] } }
    const { onChange, dialog } = renderSection({
      provider,
      confirmResult: { confirmed: false, choice: 'cancel' },
    })
    await flushEffects()

    const block = screen.getByTestId('ai-protocol-openai-chat')
    fireEvent.click(within(block).getByRole('button', { name: /Remove protocol openai-chat/ }))
    await flushEffects()

    expect(dialog.confirm).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removing the last protocol after confirmation commits an empty map → undefined for a root entry', async () => {
    const provider: AiProviderEntry = { id: 'p', protocolMap: { 'openai-chat': [] } }
    const { onChange } = renderSection({ provider })
    await flushEffects()

    const block = screen.getByTestId('ai-protocol-openai-chat')
    fireEvent.click(within(block).getByRole('button', { name: /Remove protocol openai-chat/ }))
    await flushEffects()

    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  // An inheriting entry that clears its map is saying "speak nothing, whatever
  // the parent says" — that is a value, not an absence, so it must not collapse
  // to undefined the way a root entry's empty map does.
  it('an inheriting entry clearing its last protocol commits {} rather than undefined', async () => {
    const parent: AiProviderEntry = {
      id: 'root',
      protocolMap: { 'openai-chat': ['gpt-4o'] },
    }
    const child: AiProviderEntry = {
      id: 'child',
      extends: 'root',
      protocolMap: { 'openai-chat': [] },
    }
    const { onChange } = renderSection({ provider: child, allProviders: [parent, child] })
    await flushEffects()

    const block = screen.getByTestId('ai-protocol-openai-chat')
    fireEvent.click(within(block).getByRole('button', { name: /Remove protocol openai-chat/ }))
    await flushEffects()

    expect(onChange).toHaveBeenCalledWith({})
  })

  it('adding a model row to a static list appends the wire name', async () => {
    const provider: AiProviderEntry = {
      id: 'p',
      protocolMap: { 'openai-chat': ['gpt-4o'] },
    }
    const { onChange } = renderSection({ provider })
    await flushEffects()

    const block = screen.getByTestId('ai-protocol-openai-chat')
    fireEvent.click(within(block).getByRole('button', { name: 'Add model' }))
    await flushEffects()

    const input = within(block).getByRole('textbox', { name: 'Add model' })
    fireEvent.change(input, { target: { value: 'gpt-4o-mini' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flushEffects()

    expect(onChange).toHaveBeenCalledWith({ 'openai-chat': ['gpt-4o', 'gpt-4o-mini'] })
  })

  it('removing a model row from a static list drops that entry', async () => {
    const provider: AiProviderEntry = {
      id: 'p',
      protocolMap: { 'openai-chat': ['gpt-4o', 'gpt-4o-mini'] },
    }
    const { onChange } = renderSection({ provider })
    await flushEffects()

    const block = screen.getByTestId('ai-protocol-openai-chat')
    const removeButtons = within(block).getAllByRole('button', {
      name: 'Remove model from the list',
    })
    const first = removeButtons[0]
    if (first === undefined) throw new Error('expected at least one remove button')
    fireEvent.click(first)
    await flushEffects()

    expect(onChange).toHaveBeenCalledWith({ 'openai-chat': ['gpt-4o-mini'] })
  })

  it('pin discovered writes the resolved channelModel names into a static list', async () => {
    const provider: AiProviderEntry = { id: 'p', protocolMap: { 'openai-chat': [] } }
    const models = [
      makeModel('p', 'openai-chat', 'gpt-4o'),
      makeModel('p', 'openai-chat', 'gpt-4o-mini'),
    ]
    const { onChange } = renderSection({ provider, models })
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: /Pin 2 models to a static list/ }))
    await flushEffects()

    expect(onChange).toHaveBeenCalledWith({ 'openai-chat': ['gpt-4o', 'gpt-4o-mini'] })
  })

  // An entry that owns nothing but `extends` still has an address and a key —
  // they just live on the ancestor. Probing its own empty fields would dial the
  // protocol default unauthenticated and report a failure that is not real.
  it('probing an inheriting entry dials the ancestor base URL and key', async () => {
    const parent: AiProviderEntry = {
      id: 'root',
      baseUrl: 'https://gw.example/v1',
      apiKey: 'sk-parent',
    }
    const child: AiProviderEntry = {
      id: 'child',
      extends: 'root',
      protocolMap: { 'openai-chat': ['gpt-4o'] },
    }
    const { verifyProvider } = renderSection({
      provider: child,
      allProviders: [parent, child],
    })
    await flushEffects()

    const block = screen.getByTestId('ai-protocol-openai-chat')
    fireEvent.click(within(block).getByRole('button', { name: /Probe endpoint/ }))
    await flushEffects()

    expect(verifyProvider).toHaveBeenCalledWith({
      id: 'child',
      protocol: 'openai-chat',
      baseUrl: 'https://gw.example/v1',
      apiKey: 'sk-parent',
    })
  })

  it('renders static-list blocks before discover blocks', async () => {
    const provider: AiProviderEntry = {
      id: 'p',
      protocolMap: {
        'openai-chat': [],
        ollama: ['llama3'],
        'anthropic-messages': ['claude-sonnet'],
      },
    }
    renderSection({ provider })
    await flushEffects()

    const order = (testId: string): number => {
      const el = screen.getByTestId(testId)
      if (el.parentElement === null) throw new Error('expected a parent element')
      return Array.prototype.indexOf.call(el.parentElement.children, el)
    }
    const anthropic = order('ai-protocol-anthropic-messages')
    const ollama = order('ai-protocol-ollama')
    const openai = order('ai-protocol-openai-chat')
    // Static group first (both alphabetically ordered), discover last.
    expect(anthropic).toBeLessThan(ollama)
    expect(ollama).toBeLessThan(openai)
  })

  it('a collapsed block keeps its header and hides the list', async () => {
    const provider: AiProviderEntry = { id: 'p', protocolMap: { 'openai-chat': ['gpt-4o'] } }
    renderSection({ provider, isCollapsed: () => true })
    await flushEffects()

    const block = screen.getByTestId('ai-protocol-openai-chat')
    expect(within(block).queryByRole('button', { name: 'Add model' })).toBeNull()
    expect(within(block).getByRole('combobox', { name: 'Model list mode' })).toBeTruthy()
    const toggle = within(block).getByRole('button', { name: 'Toggle openai-chat models' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('clicking the toggle reports the protocol to collapse', async () => {
    const provider: AiProviderEntry = { id: 'p', protocolMap: { 'openai-chat': ['gpt-4o'] } }
    const onToggleCollapsed = vi.fn<(protocol: AiWireProtocol) => void>()
    renderSection({ provider, onToggleCollapsed })
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: 'Toggle openai-chat models' }))
    expect(onToggleCollapsed).toHaveBeenCalledWith('openai-chat')
  })

  it('mode and remove controls do not toggle the block', async () => {
    const provider: AiProviderEntry = { id: 'p', protocolMap: { 'openai-chat': ['gpt-4o'] } }
    const onToggleCollapsed = vi.fn<(protocol: AiWireProtocol) => void>()
    renderSection({ provider, onToggleCollapsed })
    await flushEffects()

    // Same value as the current mode — no probe dialog, no write.
    await pickOption('Model list mode', 'Static list')
    const block = screen.getByTestId('ai-protocol-openai-chat')
    fireEvent.click(within(block).getByRole('button', { name: /Remove protocol openai-chat/ }))
    await flushEffects()

    expect(onToggleCollapsed).not.toHaveBeenCalled()
  })
})
