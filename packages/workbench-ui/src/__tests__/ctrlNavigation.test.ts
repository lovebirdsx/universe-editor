/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { ctrlNavigationKey } from '../keybinding/ctrlNavigation.js'

function stroke(
  key: string,
  mods: Partial<Record<'ctrl' | 'alt' | 'meta' | 'shift', boolean>> = {},
) {
  return {
    key,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
  }
}

describe('ctrlNavigationKey', () => {
  it('maps the four movement letters, whatever their case', () => {
    expect(ctrlNavigationKey(stroke('p', { ctrl: true }))).toBe('p')
    expect(ctrlNavigationKey(stroke('n', { ctrl: true }))).toBe('n')
    expect(ctrlNavigationKey(stroke('h', { ctrl: true }))).toBe('h')
    expect(ctrlNavigationKey(stroke('l', { ctrl: true }))).toBe('l')
    // CapsLock reports an upper-case letter with no Shift held.
    expect(ctrlNavigationKey(stroke('P', { ctrl: true }))).toBe('p')
  })

  it('rejects the letters without Ctrl, and any extra modifier stripe', () => {
    for (const key of ['h', 'l', 'n', 'p']) {
      expect(ctrlNavigationKey(stroke(key))).toBeUndefined()
      expect(ctrlNavigationKey(stroke(key, { ctrl: true, shift: true }))).toBeUndefined()
      expect(ctrlNavigationKey(stroke(key, { ctrl: true, alt: true }))).toBeUndefined()
      expect(ctrlNavigationKey(stroke(key, { ctrl: true, meta: true }))).toBeUndefined()
      expect(ctrlNavigationKey(stroke(key, { meta: true }))).toBeUndefined()
    }
  })

  it('stops at the four aliases', () => {
    // Ctrl+K is the app's chord leader and Ctrl+J toggles the panel; Ctrl+Arrow
    // and Ctrl+Enter have their own meanings in the tree, Monaco and the menus.
    expect(ctrlNavigationKey(stroke('k', { ctrl: true }))).toBeUndefined()
    expect(ctrlNavigationKey(stroke('j', { ctrl: true }))).toBeUndefined()
    expect(ctrlNavigationKey(stroke('b', { ctrl: true }))).toBeUndefined()
    expect(ctrlNavigationKey(stroke('ArrowDown', { ctrl: true }))).toBeUndefined()
    expect(ctrlNavigationKey(stroke('Enter', { ctrl: true }))).toBeUndefined()
  })
})
