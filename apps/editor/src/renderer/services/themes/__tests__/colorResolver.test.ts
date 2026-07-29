/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Color, DEFAULT_COLOR_CONFIG_VALUE } from '@universe-editor/platform'
import { describe, expect, it } from 'vitest'
import {
  mergeColorCustomizations,
  resolveColorCustomizations,
  splitColorCustomizations,
} from '../colorResolver.js'

describe('resolveColorCustomizations', () => {
  it('parses hex values, keeps "default" literals and reports invalid entries', () => {
    const { colors, invalid } = resolveColorCustomizations({
      'editor.background': '#112233',
      'sideBar.background': DEFAULT_COLOR_CONFIG_VALUE,
      'panel.background': 'not-a-color',
      'titleBar.activeBackground': 42 as unknown as string,
    })
    expect(colors['editor.background']).toBeInstanceOf(Color)
    expect(colors['sideBar.background']).toBe('default')
    expect(colors['panel.background']).toBeUndefined()
    expect(colors['titleBar.activeBackground']).toBeUndefined()
    expect([...invalid].sort()).toEqual(['panel.background', 'titleBar.activeBackground'])
  })
})

describe('mergeColorCustomizations', () => {
  it('per-theme entries win over global ones', () => {
    const merged = mergeColorCustomizations(
      { a: '#111111', b: '#222222' },
      { b: '#333333', c: '#444444' },
    )
    expect(merged).toEqual({ a: '#111111', b: '#333333', c: '#444444' })
  })

  it('tolerates missing per-theme block', () => {
    expect(mergeColorCustomizations({ a: '#111111' }, undefined)).toEqual({ a: '#111111' })
  })
})

describe('splitColorCustomizations', () => {
  it('splits global keys from "[theme]" scoped blocks and filters non-strings', () => {
    const { global, perTheme } = splitColorCustomizations({
      'editor.background': '#111111',
      'editor.foreground': 5,
      '[Universe Dark]': { 'editor.background': '#222222', 'editor.foreground': true },
      '[Broken]': 'not-an-object',
    })
    expect(global).toEqual({ 'editor.background': '#111111' })
    expect(perTheme['Universe Dark']).toEqual({ 'editor.background': '#222222' })
    expect(perTheme['Broken']).toBeUndefined()
  })

  it('handles non-object input', () => {
    expect(splitColorCustomizations(undefined)).toEqual({ global: {}, perTheme: {} })
    expect(splitColorCustomizations('nope')).toEqual({ global: {}, perTheme: {} })
  })
})
