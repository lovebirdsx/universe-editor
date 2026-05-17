/*---------------------------------------------------------------------------------------------
 *  Tests for QuickPickPanel prefix-mode behavior (VSCode-style ">" quick access).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QuickPickPanel } from '../QuickInput.js'
import type { QuickPickState } from '../QuickInputService.js'

afterEach(() => cleanup())

const items = [
  { id: 'cmd.format', label: 'Format Document' },
  { id: 'cmd.line', label: 'Go to Line' },
]

function makeState(extra: Partial<QuickPickState> = {}): QuickPickState {
  return { type: 'pick', items, prefix: '>', onAccept: vi.fn(), onHide: vi.fn(), ...extra }
}

describe('QuickPickPanel prefix mode', () => {
  it('prefills the input with the prefix on open', () => {
    render(<QuickPickPanel state={makeState()} onClose={() => undefined} />)
    expect((screen.getByTestId('quick-input-field') as HTMLInputElement).value).toBe('>')
    // both items visible (empty filter text after stripping prefix)
    expect(screen.getByText('Format Document')).toBeTruthy()
    expect(screen.getByText('Go to Line')).toBeTruthy()
  })

  it('filters items by the text after the prefix', () => {
    render(<QuickPickPanel state={makeState()} onClose={() => undefined} />)
    const input = screen.getByTestId('quick-input-field') as HTMLInputElement
    fireEvent.change(input, { target: { value: '>fmt' } })
    expect(screen.getByText('Format Document')).toBeTruthy()
    expect(screen.queryByText('Go to Line')).toBeNull()
  })

  it('shows a hint and suppresses the list when the prefix is wiped', () => {
    render(<QuickPickPanel state={makeState()} onClose={() => undefined} />)
    const input = screen.getByTestId('quick-input-field') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.queryByText('Format Document')).toBeNull()
    expect(screen.queryByText('Go to Line')).toBeNull()
    expect(screen.getByText(/Type '>' followed by a command name/)).toBeTruthy()
  })

  it('behaves like a plain picker (no prefix) when state.prefix is undefined', () => {
    render(<QuickPickPanel state={makeState({ prefix: undefined })} onClose={() => undefined} />)
    const input = screen.getByTestId('quick-input-field') as HTMLInputElement
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: 'line' } })
    expect(screen.queryByText('Format Document')).toBeNull()
    expect(screen.getByText('Go to Line')).toBeTruthy()
  })

  it('renders keybinding hint when item has keybinding field', () => {
    const state = makeState({
      items: [{ id: 'cmd.format', label: 'Format Document', keybinding: 'Ctrl+Shift+P' }],
    })
    render(<QuickPickPanel state={state} onClose={() => undefined} />)
    expect(screen.getByText('Ctrl+Shift+P')).toBeTruthy()
  })

  it('does not render keybinding when item has no keybinding field', () => {
    render(<QuickPickPanel state={makeState()} onClose={() => undefined} />)
    // default items have no keybinding; no unexpected keybinding text should appear
    expect(screen.queryByText('Ctrl+')).toBeNull()
  })
})
