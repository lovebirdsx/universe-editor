import { describe, expect, it } from 'vitest'
import { formatVimKeys, formatVimPending, formatVimToken } from '../vimKeyFormat.js'

describe('vimKeyFormat', () => {
  it('spells named keys and modifier combos', () => {
    expect(formatVimToken('space')).toBe('<Space>')
    expect(formatVimToken('escape')).toBe('<Esc>')
    expect(formatVimToken('ctrl+d')).toBe('<C-d>')
    expect(formatVimToken('ctrl+shift+enter')).toBe('<C-S-CR>')
    expect(formatVimToken('<leader>')).toBe('<Leader>')
  })

  it('keeps printable keys and unknown strings as typed', () => {
    expect(formatVimToken('G')).toBe('G')
    expect(formatVimToken('?')).toBe('?')
    expect(formatVimToken('+')).toBe('+')
    expect(formatVimToken('<C-x>')).toBe('<C-x>')
  })

  it('joins sequences compactly and prefixes a typed count', () => {
    expect(formatVimKeys(['space', 'w', 'h'])).toBe('<Space>wh')
    expect(formatVimPending(3, ['g'])).toBe('3g')
    expect(formatVimPending(0, ['space'])).toBe('<Space>')
  })
})
