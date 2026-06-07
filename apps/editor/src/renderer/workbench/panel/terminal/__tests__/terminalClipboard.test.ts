import { describe, expect, it, vi } from 'vitest'
import { handleTerminalClipboardKey } from '../terminalClipboard.js'

function keyboardEvent(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    key,
    ...init,
  })
}

function makeTerminal(selection = '') {
  return {
    getSelection: vi.fn(() => selection),
    hasSelection: vi.fn(() => selection.length > 0),
    paste: vi.fn(),
  }
}

function makeClipboard(text = '') {
  return {
    readText: vi.fn(async () => text),
    writeText: vi.fn(async () => {}),
  }
}

describe('terminal clipboard key handling', () => {
  it('copies the active terminal selection on Ctrl+C', async () => {
    const term = makeTerminal('selected text')
    const clipboard = makeClipboard()
    const event = keyboardEvent('c')

    expect(handleTerminalClipboardKey(event, term, clipboard)).toBe(false)
    await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith('selected text'))
    expect(event.defaultPrevented).toBe(true)
    expect(term.paste).not.toHaveBeenCalled()
  })

  it('leaves Ctrl+C to the terminal when there is no selection', () => {
    const term = makeTerminal()
    const clipboard = makeClipboard()
    const event = keyboardEvent('c')

    expect(handleTerminalClipboardKey(event, term, clipboard)).toBe(true)
    expect(event.defaultPrevented).toBe(false)
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })

  it('pastes clipboard text into the terminal on Ctrl+V', async () => {
    const term = makeTerminal()
    const clipboard = makeClipboard('paste me')
    const event = keyboardEvent('v')

    expect(handleTerminalClipboardKey(event, term, clipboard)).toBe(false)
    await vi.waitFor(() => expect(term.paste).toHaveBeenCalledWith('paste me'))
    expect(event.defaultPrevented).toBe(true)
  })

  it('does not claim shifted Ctrl+C', () => {
    const term = makeTerminal('selected text')
    const clipboard = makeClipboard()
    const event = keyboardEvent('c', { shiftKey: true })

    expect(handleTerminalClipboardKey(event, term, clipboard)).toBe(true)
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })
})
