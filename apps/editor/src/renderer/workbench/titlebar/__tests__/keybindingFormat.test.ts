import { afterEach, describe, expect, it } from 'vitest'
import { KeybindingsRegistry, type IDisposable } from '@universe-editor/platform'
import { formatChord, formatKey, resolveShortcut } from '../keybindingFormat.js'

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

describe('resolveShortcut', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('returns formatted key for a registered single-key binding', () => {
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ key: 'ctrl+k', command: 'test.single' }),
    )
    expect(resolveShortcut('test.single')).toBe('Ctrl+K')
  })

  it('returns formatted chord for a chord binding', () => {
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        chords: ['ctrl+k', 'ctrl+s'],
        command: 'test.chord',
      }),
    )
    expect(resolveShortcut('test.chord')).toBe('Ctrl+K Ctrl+S')
  })

  it('returns undefined for an unregistered command', () => {
    expect(resolveShortcut('test.notexist')).toBeUndefined()
  })

  it('ignores negated bindings', () => {
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: 'ctrl+k',
        command: 'test.neg',
        isNegated: true,
      }),
    )
    expect(resolveShortcut('test.neg')).toBeUndefined()
  })

  it('prefers the most recently registered binding when there are multiple', () => {
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ key: 'ctrl+1', command: 'test.multi' }),
    )
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ key: 'ctrl+2', command: 'test.multi' }),
    )
    expect(resolveShortcut('test.multi')).toBe('Ctrl+2')
  })
})
