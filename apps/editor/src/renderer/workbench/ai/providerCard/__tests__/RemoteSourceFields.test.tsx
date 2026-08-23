/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  RemoteSourceFields tests — pins the write-through contract of the two remote
 *  sources a provider entry can declare: the three-state source picker (absent
 *  is a deliberate "unknown", never a guess), the catalog vendor sub-picker,
 *  and the raw-JSON escape hatch, which must refuse to persist unparseable
 *  text rather than write a corrupt spec.
 *
 *  The component renders pricing and usage as two sibling sections with no
 *  testid of their own, so the http-json forms inside them are told apart by
 *  DOM order (pricing first, usage second) via getAllByRole.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  AiProviderEntry,
  AiRemoteSourceSpec,
  IAiModelService,
} from '@universe-editor/platform'
import { RemoteSourceFields } from '../RemoteSourceFields.js'

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
}

function renderFields(provider: AiProviderEntry): Rendered {
  const onPricingSourceChange = vi.fn<(spec: AiRemoteSourceSpec | undefined) => void>()
  const onUsageSourceChange = vi.fn<(spec: AiRemoteSourceSpec | undefined) => void>()
  const aiModel = {
    getAccountUsage: vi.fn(async () => undefined),
  } as unknown as IAiModelService
  render(
    <RemoteSourceFields
      aiModel={aiModel}
      provider={provider}
      allProviders={[provider]}
      rateTables={[]}
      reloadToken={0}
      saved={undefined}
      onPricingSourceChange={onPricingSourceChange}
      onUsageSourceChange={onUsageSourceChange}
      onRefreshRemote={vi.fn(async () => {})}
    />,
  )
  return { onPricingSourceChange, onUsageSourceChange }
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
