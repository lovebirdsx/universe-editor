import { describe, expect, it } from 'vitest'
import { buildKeyString } from '../keyEventUtils.js'

function key(init: KeyboardEventInit): KeyboardEvent {
  // buildKeyString only reads the modifier flags, key, and code; a plain object
  // keeps this suite in the node project (no DOM environment needed).
  return init as unknown as KeyboardEvent
}

describe('buildKeyString', () => {
  it('resolves shifted punctuation from e.code instead of the shifted e.key', () => {
    expect(buildKeyString(key({ key: '>', code: 'Period', ctrlKey: true, shiftKey: true }))).toBe(
      'ctrl+shift+.',
    )
    expect(
      buildKeyString(key({ key: ':', code: 'Semicolon', ctrlKey: true, shiftKey: true })),
    ).toBe('ctrl+shift+;')
  })

  it('keeps shifted-character bindings written by character (e.g. ?)', () => {
    // `Slash` must stay un-mapped: existing bindings spell the shifted character
    // (`?` / `shift+?`), and mapping it from code would build `shift+/`.
    expect(buildKeyString(key({ key: '?', code: 'Slash', shiftKey: true }))).toBe('shift+?')
    expect(buildKeyString(key({ key: '?', code: 'Slash' }))).toBe('?')
  })

  it('keeps the existing digit and backquote remapping', () => {
    expect(buildKeyString(key({ key: '%', code: 'Digit5', ctrlKey: true, shiftKey: true }))).toBe(
      'ctrl+shift+5',
    )
    expect(buildKeyString(key({ key: '~', code: 'Backquote', ctrlKey: true }))).toBe('ctrl+`')
  })

  it('maps space and arrow keys', () => {
    expect(buildKeyString(key({ key: ' ', code: 'Space' }))).toBe('space')
    expect(buildKeyString(key({ key: 'ArrowLeft', code: 'ArrowLeft' }))).toBe('left')
    expect(buildKeyString(key({ key: 'ArrowRight', code: 'ArrowRight' }))).toBe('right')
    expect(buildKeyString(key({ key: 'ArrowUp', code: 'ArrowUp' }))).toBe('up')
    expect(buildKeyString(key({ key: 'ArrowDown', code: 'ArrowDown' }))).toBe('down')
  })
})
