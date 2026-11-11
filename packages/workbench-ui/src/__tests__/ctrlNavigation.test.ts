/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { ctrlNavigationDirection, ctrlNavigationKey } from '../keybinding/ctrlNavigation.js'

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
  it('maps the six movement letters, whatever their case', () => {
    expect(ctrlNavigationKey(stroke('p', { ctrl: true }))).toBe('p')
    expect(ctrlNavigationKey(stroke('n', { ctrl: true }))).toBe('n')
    expect(ctrlNavigationKey(stroke('k', { ctrl: true }))).toBe('k')
    expect(ctrlNavigationKey(stroke('j', { ctrl: true }))).toBe('j')
    expect(ctrlNavigationKey(stroke('h', { ctrl: true }))).toBe('h')
    expect(ctrlNavigationKey(stroke('l', { ctrl: true }))).toBe('l')
    // CapsLock reports an upper-case letter with no Shift held.
    expect(ctrlNavigationKey(stroke('P', { ctrl: true }))).toBe('p')
    expect(ctrlNavigationKey(stroke('K', { ctrl: true }))).toBe('k')
  })

  it('rejects the letters without Ctrl, and any extra modifier stripe', () => {
    for (const key of ['h', 'j', 'k', 'l', 'n', 'p']) {
      expect(ctrlNavigationKey(stroke(key))).toBeUndefined()
      expect(ctrlNavigationKey(stroke(key, { ctrl: true, shift: true }))).toBeUndefined()
      expect(ctrlNavigationKey(stroke(key, { ctrl: true, alt: true }))).toBeUndefined()
      expect(ctrlNavigationKey(stroke(key, { ctrl: true, meta: true }))).toBeUndefined()
      expect(ctrlNavigationKey(stroke(key, { meta: true }))).toBeUndefined()
    }
  })

  it('stops at the aliases', () => {
    expect(ctrlNavigationKey(stroke('b', { ctrl: true }))).toBeUndefined()
    expect(ctrlNavigationKey(stroke('ArrowDown', { ctrl: true }))).toBeUndefined()
    expect(ctrlNavigationKey(stroke('Enter', { ctrl: true }))).toBeUndefined()
  })
})

describe('ctrlNavigationDirection', () => {
  it('maps n/j down and p/k up, h/l sideways', () => {
    expect(ctrlNavigationDirection(stroke('n', { ctrl: true }))).toBe('down')
    expect(ctrlNavigationDirection(stroke('j', { ctrl: true }))).toBe('down')
    expect(ctrlNavigationDirection(stroke('p', { ctrl: true }))).toBe('up')
    expect(ctrlNavigationDirection(stroke('k', { ctrl: true }))).toBe('up')
    expect(ctrlNavigationDirection(stroke('h', { ctrl: true }))).toBe('left')
    expect(ctrlNavigationDirection(stroke('l', { ctrl: true }))).toBe('right')
  })

  it('is undefined for non-aliases and extra modifiers', () => {
    expect(ctrlNavigationDirection(stroke('j'))).toBeUndefined()
    expect(ctrlNavigationDirection(stroke('j', { ctrl: true, shift: true }))).toBeUndefined()
    expect(ctrlNavigationDirection(stroke('k', { ctrl: true, alt: true }))).toBeUndefined()
    expect(ctrlNavigationDirection(stroke('ArrowDown', { ctrl: true }))).toBeUndefined()
  })
})
