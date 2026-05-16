import { describe, expect, it } from 'vitest'
import { formatChord, formatKey } from '../keybindingFormat.js'

describe('keybindingFormat', () => {
  it('formats simple key with capitalized modifiers', () => {
    expect(formatKey('ctrl+s')).toBe('Ctrl+S')
    expect(formatKey('ctrl+shift+p')).toBe('Ctrl+Shift+P')
  })

  it('maps meta to Cmd for mac display', () => {
    expect(formatKey('meta+k')).toBe('Cmd+K')
  })

  it('formats multi-letter key names (Enter / Escape / F1)', () => {
    expect(formatKey('enter')).toBe('Enter')
    expect(formatKey('f1')).toBe('F1')
  })

  it('formats a 2-stroke chord with space separator', () => {
    expect(formatChord(['ctrl+k', 'ctrl+s'])).toBe('Ctrl+K Ctrl+S')
  })

  it('formats a single-element chord like a plain key', () => {
    expect(formatChord(['ctrl+,'])).toBe('Ctrl+,')
  })
})
