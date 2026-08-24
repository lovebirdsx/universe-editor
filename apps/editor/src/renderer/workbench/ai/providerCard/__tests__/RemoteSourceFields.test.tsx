/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  RemoteSourceFields tests — pins the write-through contract of the two remote
 *  sources a provider entry can declare: the three-state source picker (absent
 *  is a deliberate "unknown", never a guess), the catalog vendor sub-picker,
 *  and the raw-JSON escape hatch, which must refuse to persist unparseable
 *  text rather than write a corrupt spec.
 *
 *  Also pinned: what an entry that only *inherits* a source renders. main flattens
 *  `extends` before it fetches, so those entries have prices and usage of their own
 *  id — showing them "None" hid data that existed. The component must follow the
 *  effective source when rendering while still writing only the entry's own field.
 *
 *  The two sections are collapsible and controlled, so the harness below owns the
 *  collapse state and starts expanded unless a test says otherwise. Pricing renders
 *  before usage, which is how the http-json forms inside them are told apart.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { AiProviderEntry, AiRemoteSourceSpec } from '@universe-editor/platform'
import { RemoteSourceFields } from '../RemoteSourceFields.js'
import type { UsageState } from '../usageState.js'

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

interface Rendered {
  readonly onPricingSourceChange: ReturnType<
    typeof vi.fn<(spec: AiRemoteSourceSpec | undefined) => void>
  >
  readonly onUsageSourceChange: ReturnType<
    typeof vi.fn<(spec: AiRemoteSourceSpec | undefined) => void>
  >
  readonly onRefreshRemote: ReturnType<typeof vi.fn<() => Promise<void>>>
}

interface RenderOptions {
  readonly all?: readonly AiProviderEntry[]
  readonly usage?: UsageState
  /** Both sections start collapsed, as they do in the real panel. */
  readonly startCollapsed?: boolean
}

function renderFields(provider: AiProviderEntry, options: RenderOptions = {}): Rendered {
  const onPricingSourceChange = vi.fn<(spec: AiRemoteSourceSpec | undefined) => void>()
  const onUsageSourceChange = vi.fn<(spec: AiRemoteSourceSpec | undefined) => void>()
  const onRefreshRemote = vi.fn<() => Promise<void>>(async () => {})
  const startCollapsed = options.startCollapsed ?? false

  function Harness() {
    const [pricingCollapsed, setPricingCollapsed] = useState(startCollapsed)
    const [usageCollapsed, setUsageCollapsed] = useState(startCollapsed)
    return (
      <RemoteSourceFields
        provider={provider}
        allProviders={options.all ?? [provider]}
        rateTables={[]}
        usage={options.usage ?? { kind: 'none' }}
        saved={undefined}
        pricingCollapsed={pricingCollapsed}
        usageCollapsed={usageCollapsed}
        onTogglePricing={() => setPricingCollapsed((v) => !v)}
        onToggleUsage={() => setUsageCollapsed((v) => !v)}
        onPricingSourceChange={onPricingSourceChange}
        onUsageSourceChange={onUsageSourceChange}
        onRefreshRemote={onRefreshRemote}
      />
    )
  }

  render(<Harness />)
  return { onPricingSourceChange, onUsageSourceChange, onRefreshRemote }
}

describe('RemoteSourceFields — pricing source', () => {
  it('None → Catalog writes a catalog spec seeded with the first vendor', async () => {
    const provider: AiProviderEntry = { id: 'p', protocolMap: { 'openai-chat': [] } }
    const { onPricingSourceChange } = renderFields(provider)
    await flushEffects()

    await pickOption('Pricing source', /Catalog/)
    expect(onPricingSourceChange).toHaveBeenCalledWith({
      id: 'catalog',
      options: { vendor: 'anthropic' },
    })
  })

  it('Catalog → None writes undefined', async () => {
    const provider: AiProviderEntry = {
      id: 'p',
      protocolMap: { 'openai-chat': [] },
      pricingSource: { id: 'catalog', options: { vendor: 'anthropic' } },
    }
    const { onPricingSourceChange } = renderFields(provider)
    await flushEffects()

    await pickOption('Pricing source', 'None')
    expect(onPricingSourceChange).toHaveBeenCalledWith(undefined)
  })

  it('None → HTTP JSON writes a bare http-json spec', async () => {
    const provider: AiProviderEntry = { id: 'p', protocolMap: { 'openai-chat': [] } }
    const { onPricingSourceChange } = renderFields(provider)
    await flushEffects()

    await pickOption('Pricing source', 'HTTP JSON')
    expect(onPricingSourceChange).toHaveBeenCalledWith({ id: 'http-json' })
  })

  it('the catalog vendor picker writes options.vendor', async () => {
    const provider: AiProviderEntry = {
      id: 'p',
      protocolMap: { 'openai-chat': [] },
      pricingSource: { id: 'catalog', options: { vendor: 'anthropic' } },
    }
    const { onPricingSourceChange } = renderFields(provider)
    await flushEffects()

    await pickOption('Vendor', 'openai')
    expect(onPricingSourceChange).toHaveBeenCalledWith({
      id: 'catalog',
      options: { vendor: 'openai' },
    })
  })
})

describe('RemoteSourceFields — usage source', () => {
  it('None → HTTP JSON writes a bare http-json spec', async () => {
    const provider: AiProviderEntry = { id: 'p', protocolMap: { 'openai-chat': [] } }
    const { onUsageSourceChange } = renderFields(provider)
    await flushEffects()

    await pickOption('Account usage source', 'HTTP JSON')
    expect(onUsageSourceChange).toHaveBeenCalledWith({ id: 'http-json' })
  })

  it('HTTP JSON → None writes undefined', async () => {
    const provider: AiProviderEntry = {
      id: 'p',
      protocolMap: { 'openai-chat': [] },
      usageSource: { id: 'http-json' },
    }
    const { onUsageSourceChange } = renderFields(provider)
    await flushEffects()

    await pickOption('Account usage source', 'None')
    expect(onUsageSourceChange).toHaveBeenCalledWith(undefined)
  })

  it('renders "Unavailable" for a fetched-but-empty usage rather than a spinner', async () => {
    const provider: AiProviderEntry = {
      id: 'p',
      protocolMap: { 'openai-chat': [] },
      usageSource: { id: 'http-json' },
    }
    renderFields(provider, { usage: { kind: 'ready', value: undefined } })
    await flushEffects()

    expect(screen.getByText('Unavailable')).toBeTruthy()
  })
})

describe('RemoteSourceFields — inherited sources', () => {
  const root: AiProviderEntry = {
    id: 'root',
    baseUrl: 'https://gw.example',
    pricingSource: { id: 'http-json', options: { path: '/v1/pricing' } },
    usageSource: { id: 'http-json', options: { path: '/api/user/self' } },
  }
  const leaf: AiProviderEntry = { id: 'leaf', extends: 'root' }

  it('shows the ancestor usage source instead of None, and its form', async () => {
    renderFields(leaf, { all: [root, leaf], usage: { kind: 'ready', value: undefined } })
    await flushEffects()

    expect(screen.getByRole('combobox', { name: 'Account usage source' }).textContent).toContain(
      'HTTP JSON',
    )
    // The effective form is reachable: two http-json forms (pricing + usage) each
    // render a Path field.
    expect(screen.getAllByRole('textbox', { name: 'Path' }).length).toBe(2)
    expect(screen.getAllByText(/Inherited from root/).length).toBeGreaterThan(0)
  })

  it('enables Refresh usage on a purely inheriting entry', async () => {
    renderFields(leaf, { all: [root, leaf] })
    await flushEffects()

    const refresh = screen.getByRole('button', { name: /Refresh usage/ })
    expect(refresh.hasAttribute('disabled')).toBe(false)
  })

  it('enables Refresh prices and does not claim "No pricing source"', async () => {
    renderFields(leaf, { all: [root, leaf] })
    await flushEffects()

    expect(screen.getByRole('button', { name: /Refresh prices/ }).hasAttribute('disabled')).toBe(
      false,
    )
    expect(screen.queryByText(/No pricing source/)).toBeNull()
  })

  it('labels the empty option "Inherit from root" so picking it is not a no-op surprise', async () => {
    renderFields(leaf, { all: [root, leaf] })
    await flushEffects()

    fireEvent.click(screen.getByRole('combobox', { name: 'Account usage source' }))
    await flushEffects()
    expect(screen.getByRole('option', { name: 'Inherit from root' })).toBeTruthy()
  })

  it('labels the empty option by the ancestor even when the entry overrides it', async () => {
    // Clearing an override restores the parent's value, so offering "None" here
    // would describe the opposite of what happens.
    const override: AiProviderEntry = {
      id: 'leaf',
      extends: 'root',
      usageSource: { id: 'http-json', options: { path: '/own' } },
    }
    renderFields(override, { all: [root, override] })
    await flushEffects()

    fireEvent.click(screen.getByRole('combobox', { name: 'Account usage source' }))
    await flushEffects()
    expect(screen.getByRole('option', { name: 'Inherit from root' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'None' })).toBeNull()
  })

  it('reverting an inherited source still writes the entry’s own field', async () => {
    const { onUsageSourceChange } = renderFields(leaf, { all: [root, leaf] })
    await flushEffects()

    await pickOption('Account usage source', 'Inherit from root')
    expect(onUsageSourceChange).toHaveBeenCalledWith(undefined)
  })
})

describe('RemoteSourceFields — collapsing', () => {
  const provider: AiProviderEntry = {
    id: 'p',
    protocolMap: { 'openai-chat': [] },
    usageSource: { id: 'http-json', options: { path: '/api/user/self' } },
  }

  it('collapsed sections hide the form but keep the summary readable', async () => {
    renderFields(provider, { startCollapsed: true })
    await flushEffects()

    expect(screen.queryByRole('combobox', { name: 'Account usage source' })).toBeNull()
    expect(screen.getByText(/HTTP JSON · \/api\/user\/self/)).toBeTruthy()
  })

  it('localizes the usage kind in the summary instead of echoing the raw option', async () => {
    renderFields(
      {
        id: 'p',
        usageSource: { id: 'http-json', options: { path: '/u', kind: 'balance' } },
      },
      { startCollapsed: true },
    )
    await flushEffects()

    expect(screen.getByText(/HTTP JSON · \/u · Balance/)).toBeTruthy()
  })

  it('echoes an unknown source id rather than calling it HTTP JSON', async () => {
    renderFields({ id: 'p', pricingSource: { id: 'some-custom-source' } }, { startCollapsed: true })
    await flushEffects()

    expect(screen.getByText('some-custom-source')).toBeTruthy()
  })

  it('the toggle expands the section', async () => {
    renderFields(provider, { startCollapsed: true })
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Account usage source' }))
    await flushEffects()

    expect(screen.getByRole('combobox', { name: 'Account usage source' })).toBeTruthy()
  })
})

describe('RemoteSourceFields — raw JSON escape hatch', () => {
  function renderPricingHttpJson(): Rendered {
    return renderFields({
      id: 'p',
      protocolMap: { 'openai-chat': [] },
      pricingSource: { id: 'http-json', options: { path: '/v1/pricing' } },
    })
  }

  async function openRawEditor(): Promise<HTMLTextAreaElement> {
    // Both sections render an "Edit raw JSON" button only when their spec is
    // http-json; here only pricing is, so there is exactly one.
    fireEvent.click(screen.getByRole('button', { name: 'Edit raw JSON' }))
    await flushEffects()
    return screen.getByRole('textbox', { name: 'Edit raw JSON' }) as HTMLTextAreaElement
  }

  it('unparseable JSON shows an error and writes nothing', async () => {
    const { onPricingSourceChange } = renderPricingHttpJson()
    await flushEffects()

    const textarea = await openRawEditor()
    fireEvent.change(textarea, { target: { value: '{ not json' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await flushEffects()

    expect(onPricingSourceChange).not.toHaveBeenCalled()
    // The dialog stays open with the error visible.
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('valid JSON writes the parsed options through', async () => {
    const { onPricingSourceChange } = renderPricingHttpJson()
    await flushEffects()

    const textarea = await openRawEditor()
    fireEvent.change(textarea, {
      target: { value: '{ "path": "/custom", "headers": { "X-Key": "v" } }' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await flushEffects()

    expect(onPricingSourceChange).toHaveBeenCalledWith({
      id: 'http-json',
      options: { path: '/custom', headers: { 'X-Key': 'v' } },
    })
  })

  it('a non-object JSON value is rejected with the shape error', async () => {
    const { onPricingSourceChange } = renderPricingHttpJson()
    await flushEffects()

    const textarea = await openRawEditor()
    fireEvent.change(textarea, { target: { value: '[1, 2]' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await flushEffects()

    expect(onPricingSourceChange).not.toHaveBeenCalled()
    expect(screen.getByText('JSON must be an object.')).toBeTruthy()
  })
})
