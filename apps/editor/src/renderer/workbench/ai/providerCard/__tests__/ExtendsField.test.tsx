/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  ExtendsField tests — pins the two guards that keep `extends` from silently
 *  gutting a provider: the candidate list excludes self and every descendant
 *  (so no cycle is ever offered), and a pick that the real resolver would call
 *  fatal is rejected *before* it reaches the file, with the reason shown inline.
 *  Also pins the inheritance summary line, which is the only overview of what
 *  an entry actually pulled from its ancestors.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AiModelKnowledge, AiProviderEntry } from '@universe-editor/platform'
import { ExtendsField } from '../ExtendsField.js'

afterEach(() => cleanup())

async function flushEffects(): Promise<void> {
  await act(async () => {})
}

function renderField({
  provider,
  allProviders,
  knowledge = {},
}: {
  readonly provider: AiProviderEntry
  readonly allProviders: readonly AiProviderEntry[]
  readonly knowledge?: Readonly<Record<string, AiModelKnowledge>>
}) {
  const onChange = vi.fn<(parentId: string | undefined) => void>()
  render(
    <ExtendsField
      provider={provider}
      allProviders={allProviders}
      knowledge={knowledge}
      saved={undefined}
      onChange={onChange}
    />,
  )
  return { onChange }
}

async function openOptions(): Promise<string[]> {
  fireEvent.click(screen.getByRole('combobox', { name: 'Inherit from' }))
  await flushEffects()
  return screen.getAllByRole('option').map((o) => o.textContent ?? '')
}

async function pickOption(name: string | RegExp): Promise<void> {
  fireEvent.click(screen.getByRole('combobox', { name: 'Inherit from' }))
  await flushEffects()
  fireEvent.click(screen.getByRole('option', { name }))
  await flushEffects()
}

describe('ExtendsField', () => {
  it('candidates exclude self and every descendant, but keep ancestors and unrelated entries', async () => {
    const root: AiProviderEntry = { id: 'root', protocolMap: { 'openai-chat': [] } }
    const mid: AiProviderEntry = { id: 'mid', extends: 'root' }
    const leaf: AiProviderEntry = { id: 'leaf', extends: 'mid' }
    const other: AiProviderEntry = { id: 'other', protocolMap: { 'openai-chat': [] } }
    renderField({ provider: mid, allProviders: [root, mid, leaf, other] })
    await flushEffects()

    const options = await openOptions()
    expect(options).toContain('root')
    expect(options).toContain('other')
    expect(options).not.toContain('mid')
    expect(options).not.toContain('leaf')
  })

  // The candidate filter cannot see depth limits — it only excludes cycles — so
  // the pick is run through the real resolver, and a fatal result never reaches
  // onChange. The cheapest fatal to build is extends-depth: a chain that would
  // become 9 entries deep.
  it('a pick the resolver calls fatal is rejected and never written', async () => {
    const chain: AiProviderEntry[] = [{ id: 'root', protocolMap: { 'openai-chat': [] } }]
    for (let i = 1; i <= 7; i++) {
      chain.push({ id: `a${i}`, extends: i === 1 ? 'root' : `a${i - 1}` })
    }
    const leaf: AiProviderEntry = { id: 'leaf', protocolMap: { 'openai-chat': [] } }
    const all = [...chain, leaf]

    const { onChange } = renderField({ provider: leaf, allProviders: all })
    await flushEffects()

    await pickOption('a7')

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('ai-extends-error')).toBeTruthy()
  })

  it('a legal pick is written through onChange', async () => {
    const root: AiProviderEntry = { id: 'root', protocolMap: { 'openai-chat': [] } }
    const leaf: AiProviderEntry = { id: 'leaf' }
    const { onChange } = renderField({ provider: leaf, allProviders: [root, leaf] })
    await flushEffects()

    await pickOption('root')

    expect(onChange).toHaveBeenCalledWith('root')
    expect(screen.queryByTestId('ai-extends-error')).toBeNull()
  })

  it('the summary line names the inherited field and the ancestor that supplied it', async () => {
    const root: AiProviderEntry = {
      id: 'root',
      baseUrl: 'https://api.example',
      protocolMap: { 'openai-chat': [] },
    }
    const leaf: AiProviderEntry = { id: 'leaf', extends: 'root' }
    renderField({ provider: leaf, allProviders: [root, leaf] })
    await flushEffects()

    expect(screen.getByText(/Inheriting baseUrl \(root\)/)).toBeTruthy()
  })

  it('an entry with every field set locally reports that nothing is inherited', async () => {
    const root: AiProviderEntry = { id: 'root', protocolMap: { 'openai-chat': [] } }
    const leaf: AiProviderEntry = {
      id: 'leaf',
      extends: 'root',
      baseUrl: 'https://mine.example',
      apiKey: 'sk-x',
      defaultProtocol: 'openai-chat',
      protocolMap: { 'openai-chat': [] },
      pricingSource: { id: 'http-json' },
      usageSource: { id: 'http-json' },
    }
    renderField({ provider: leaf, allProviders: [root, leaf] })
    await flushEffects()

    expect(
      screen.getByText('Every field is set locally, so nothing is currently inherited.'),
    ).toBeTruthy()
  })
})
