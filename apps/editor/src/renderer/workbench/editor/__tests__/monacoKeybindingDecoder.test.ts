/*---------------------------------------------------------------------------------------------
 *  Pure decoder tests — no monaco import. We synthesize numeric encodings the
 *  same way `KeyMod | KeyCode` does at compile time, and the same way
 *  `KeyMod.chord(a, b)` packs two chords into one i32 (`(a & 0xFFFF) | (b << 16)`).
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest'
import { decodeMonacoKeybinding } from '../monaco/monacoKeybindingDecoder.js'

// Mirror the monaco enum values we exercise — keep this list small and
// representative; the table inside the decoder covers the whole range.
const KeyMod = {
  CtrlCmd: 2048,
  Shift: 1024,
  Alt: 512,
  WinCtrl: 256,
} as const

const KeyCode = {
  Backspace: 1,
  Tab: 2,
  Enter: 3,
  Escape: 9,
  Space: 10,
  F1: 59,
  F2: 60,
  F12: 70,
  KeyA: 31,
  KeyD: 34,
  KeyF: 36,
  KeyK: 41,
  KeyS: 49,
  KeyY: 55,
  KeyZ: 56,
  Digit0: 21,
  Slash: 90,
  Backslash: 93,
  BracketLeft: 92,
  BracketRight: 94,
  UpArrow: 16,
  DownArrow: 18,
} as const

function chord(a: number, b: number): number {
  return ((a & 0x0000ffff) | ((b & 0x0000ffff) << 16)) >>> 0
}

describe('decodeMonacoKeybinding — single chord', () => {
  it('decodes ctrl+z', () => {
    expect(decodeMonacoKeybinding(KeyMod.CtrlCmd | KeyCode.KeyZ)).toEqual({ key: 'ctrl+z' })
  })

  it('decodes ctrl+shift+k (delete line)', () => {
    expect(decodeMonacoKeybinding(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyK)).toEqual({
      key: 'ctrl+shift+k',
    })
  })

  it('decodes shift+alt+f (format document) emits as alt+shift+f', () => {
    expect(decodeMonacoKeybinding(KeyMod.Shift | KeyMod.Alt | KeyCode.KeyF)).toEqual({
      key: 'alt+shift+f',
    })
  })

  it('decodes f1 / f2 / f12', () => {
    expect(decodeMonacoKeybinding(KeyCode.F1)).toEqual({ key: 'f1' })
    expect(decodeMonacoKeybinding(KeyCode.F2)).toEqual({ key: 'f2' })
    expect(decodeMonacoKeybinding(KeyCode.F12)).toEqual({ key: 'f12' })
  })

  it('decodes alt+f12 (peek definition)', () => {
    expect(decodeMonacoKeybinding(KeyMod.Alt | KeyCode.F12)).toEqual({ key: 'alt+f12' })
  })

  it('decodes alt+arrowup (move line up)', () => {
    expect(decodeMonacoKeybinding(KeyMod.Alt | KeyCode.UpArrow)).toEqual({ key: 'alt+arrowup' })
  })

  it('decodes shift+alt+arrowdown (copy line down) emits as alt+shift+arrowdown', () => {
    expect(decodeMonacoKeybinding(KeyMod.Shift | KeyMod.Alt | KeyCode.DownArrow)).toEqual({
      key: 'alt+shift+arrowdown',
    })
  })

  it('decodes ctrl+/ (toggle line comment)', () => {
    expect(decodeMonacoKeybinding(KeyMod.CtrlCmd | KeyCode.Slash)).toEqual({ key: 'ctrl+/' })
  })

  it('decodes ctrl+] (indent lines)', () => {
    expect(decodeMonacoKeybinding(KeyMod.CtrlCmd | KeyCode.BracketRight)).toEqual({ key: 'ctrl+]' })
  })

  it('decodes ctrl+shift+\\ (jump to bracket)', () => {
    expect(decodeMonacoKeybinding(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Backslash)).toEqual({
      key: 'ctrl+shift+\\',
    })
  })

  it('emits modifiers in canonical lexicographic order alt→ctrl→meta→shift', () => {
    // WinCtrl + Shift + Alt + CtrlCmd + KeyA — sanity check the join order.
    expect(
      decodeMonacoKeybinding(
        KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyMod.WinCtrl | KeyCode.KeyA,
      ),
    ).toEqual({ key: 'alt+ctrl+meta+shift+a' })
  })
})

describe('decodeMonacoKeybinding — two-stroke chord', () => {
  it('decodes ctrl+k ctrl+s (VSCode keyboard shortcuts)', () => {
    const k = chord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyS)
    expect(decodeMonacoKeybinding(k)).toEqual({ chords: ['ctrl+k', 'ctrl+s'] })
  })

  it('decodes ctrl+k ctrl+d', () => {
    const k = chord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyD)
    expect(decodeMonacoKeybinding(k)).toEqual({ chords: ['ctrl+k', 'ctrl+d'] })
  })
})

describe('decodeMonacoKeybinding — edge cases', () => {
  it('returns undefined for 0', () => {
    expect(decodeMonacoKeybinding(0)).toBeUndefined()
  })

  it('returns undefined when the key code is unsupported (e.g. media key 124)', () => {
    // KeyCode.MediaTrackNext = 124, no entry in the table.
    expect(decodeMonacoKeybinding(KeyMod.CtrlCmd | 124)).toBeUndefined()
  })

  it('returns undefined when the second chord references an unsupported key', () => {
    const k = chord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | 124)
    expect(decodeMonacoKeybinding(k)).toBeUndefined()
  })

  it('returns undefined when modifier-only (no key code)', () => {
    // Pure CtrlCmd flag with KeyCode = 0 → ineligible.
    expect(decodeMonacoKeybinding(KeyMod.CtrlCmd)).toBeUndefined()
  })
})
