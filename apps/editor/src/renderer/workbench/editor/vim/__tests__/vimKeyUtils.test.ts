/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { toVimKeyInput } from '../vimKeyUtils.js'

function event(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>> = {},
  altGraph = false,
): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
    getModifierState: (name: string) => name === 'AltGraph' && altGraph,
  } as unknown as KeyboardEvent
}

describe('toVimKeyInput: AltGr and Option text', () => {
  it('passes a plain key straight through', () => {
    expect(toVimKeyInput(event('j'))).toEqual({
      key: 'j',
      ctrl: false,
      alt: false,
      meta: false,
      shift: false,
    })
  })

  it('treats Windows AltGr (Ctrl+Alt) punctuation as text', () => {
    for (const key of ['{', '}', '[', ']', '\\', '~', '@', '|']) {
      const input = toVimKeyInput(event(key, { ctrlKey: true, altKey: true }))
      expect(input, key).toMatchObject({ key, ctrl: false, alt: false })
    }
  })

  it('treats a reported AltGraph state as text even for a letter or a symbol', () => {
    expect(toVimKeyInput(event('q', { ctrlKey: true, altKey: true }, true))).toMatchObject({
      ctrl: false,
      alt: false,
    })
    expect(toVimKeyInput(event('€', { altKey: true }, true))).toMatchObject({ alt: false })
  })

  it('treats macOS Option composed characters as text', () => {
    expect(toVimKeyInput(event('å', { altKey: true }))).toMatchObject({ key: 'å', alt: false })
    expect(toVimKeyInput(event('«', { altKey: true }))).toMatchObject({ alt: false })
  })

  it('keeps real chords: Ctrl+Alt+letter/digit, Alt+ASCII punctuation, Ctrl+key, Meta combos', () => {
    expect(toVimKeyInput(event('j', { ctrlKey: true, altKey: true }))).toMatchObject({
      ctrl: true,
      alt: true,
    })
    expect(toVimKeyInput(event('3', { ctrlKey: true, altKey: true }))).toMatchObject({
      ctrl: true,
      alt: true,
    })
    expect(toVimKeyInput(event('[', { altKey: true }))).toMatchObject({ alt: true })
    expect(toVimKeyInput(event('f', { ctrlKey: true }))).toMatchObject({ ctrl: true })
    expect(toVimKeyInput(event('å', { altKey: true, metaKey: true }))).toMatchObject({
      alt: true,
      meta: true,
    })
  })

  it('never reinterprets named keys', () => {
    expect(toVimKeyInput(event('ArrowLeft', { ctrlKey: true, altKey: true }))).toMatchObject({
      ctrl: true,
      alt: true,
    })
  })
})
