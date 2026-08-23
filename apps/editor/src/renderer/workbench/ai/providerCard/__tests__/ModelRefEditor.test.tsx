/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  ModelRefEditor tests — pins the two rules that make a static-list entry more
 *  than a string: capabilities can only ever be narrowed (a checkbox for a
 *  capability the knowledge base does not grant is disabled, not hidden), and
 *  committing runs the draft back through `refFromDraft`, so a draft that only
 *  renamed nothing collapses to a plain string rather than `{ id }`.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AiModelKnowledge, AiProtocolModelRef } from '@universe-editor/platform'
import { ModelRefEditor } from '../ModelRefEditor.js'

afterEach(() => cleanup())

async function flushEffects(): Promise<void> {
  await act(async () => {})
}

function renderEditor({
  value,
  knowledge = {},
}: {
  readonly value: AiProtocolModelRef
  readonly knowledge?: Readonly<Record<string, AiModelKnowledge>>
}) {
  const onCommit = vi.fn<(next: AiProtocolModelRef) => void>()
  const onCancel = vi.fn()
  render(
    <ModelRefEditor value={value} knowledge={knowledge} onCommit={onCommit} onCancel={onCancel} />,
  )
  return { onCommit, onCancel }
}

function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
}

describe('ModelRefEditor', () => {
  it('a capability the knowledge base grants can be turned off, and commits as { vision: false }', async () => {
    const knowledge: Record<string, AiModelKnowledge> = {
      'gpt-4o': { capabilities: { streaming: true, vision: true } },
    }
    const { onCommit } = renderEditor({ value: 'gpt-4o', knowledge })
    await flushEffects()

    const vision = screen.getByTestId('ai-capability-vision') as HTMLInputElement
    expect(vision.disabled).toBe(false)
    expect(vision.checked).toBe(true)

    fireEvent.click(vision)
    await flushEffects()
    save()
    await flushEffects()

    expect(onCommit).toHaveBeenCalledWith({
      id: 'gpt-4o',
      capabilities: { vision: false },
    })
  })

  it('a capability the knowledge base does not grant is disabled', async () => {
    const knowledge: Record<string, AiModelKnowledge> = {
      'gpt-4o': { capabilities: { streaming: true } },
    }
    renderEditor({ value: 'gpt-4o', knowledge })
    await flushEffects()

    const vision = screen.getByTestId('ai-capability-vision') as HTMLInputElement
    expect(vision.disabled).toBe(true)
    expect(vision.checked).toBe(false)
  })

  it('a model absent from the knowledge base has every capability checkbox disabled', async () => {
    renderEditor({ value: 'never-heard-of-it', knowledge: {} })
    await flushEffects()

    for (const key of ['streaming', 'vision', 'promptCaching', 'toolCalling']) {
      const box = screen.getByTestId(`ai-capability-${key}`) as HTMLInputElement
      expect(box.disabled).toBe(true)
    }
    expect(
      screen.getByText(
        'This model is not in the knowledge base, so it has no capabilities to narrow.',
      ),
    ).toBeTruthy()
  })

  // Round-tripping a bare name through the editor must not produce `{ id: name }`;
  // the string form is what the file should contain whenever the object would
  // carry nothing beyond the name.
  it('changing nothing commits back a plain string, not an object', async () => {
    const { onCommit } = renderEditor({ value: 'gpt-4o' })
    await flushEffects()

    save()
    await flushEffects()

    expect(onCommit).toHaveBeenCalledWith('gpt-4o')
  })

  it('renaming only the wire name still collapses to the new string', async () => {
    const { onCommit } = renderEditor({ value: 'gpt-4o' })
    await flushEffects()

    fireEvent.change(screen.getByRole('textbox', { name: 'Wire name' }), {
      target: { value: 'gpt-4o-renamed' },
    })
    await flushEffects()
    save()
    await flushEffects()

    expect(onCommit).toHaveBeenCalledWith('gpt-4o-renamed')
  })

  it('a wire name plus a different knowledge ref commits an object carrying both fields', async () => {
    const knowledge: Record<string, AiModelKnowledge> = {
      'gpt-4o': { capabilities: { streaming: true, vision: true } },
    }
    const { onCommit } = renderEditor({ value: 'channel-renamed', knowledge })
    await flushEffects()

    // Select is a self-rendered listbox — click the trigger, then the option.
    fireEvent.click(screen.getByRole('combobox', { name: 'Knowledge entry' }))
    await flushEffects()
    fireEvent.click(screen.getByRole('option', { name: 'gpt-4o' }))
    await flushEffects()

    save()
    await flushEffects()

    expect(onCommit).toHaveBeenCalledWith({ id: 'channel-renamed', ref: 'gpt-4o' })
  })

  it('an empty draft disables Save (no model named at all)', async () => {
    renderEditor({ value: 'gpt-4o' })
    await flushEffects()

    fireEvent.change(screen.getByRole('textbox', { name: 'Wire name' }), {
      target: { value: '   ' },
    })
    await flushEffects()

    const saveButton = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(saveButton.disabled).toBe(true)
  })
})
