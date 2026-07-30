/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ColorScheme } from '@universe-editor/platform'
import { beforeEach, describe, expect, it } from 'vitest'
import { ColorThemeData } from '../colorThemeData.js'
import {
  toMonacoBase,
  toMonacoThemeName,
  tokenColorRulesToMonacoRules,
  toStandaloneThemeData,
} from '../monacoThemeAdapter.js'
import { registerUniverseColorIds } from '../universeColorIds.js'

describe('toMonacoBase / toMonacoThemeName', () => {
  it('maps color schemes to monaco base themes', () => {
    expect(toMonacoBase(ColorScheme.DARK)).toBe('vs-dark')
    expect(toMonacoBase(ColorScheme.LIGHT)).toBe('vs')
    expect(toMonacoBase(ColorScheme.HIGH_CONTRAST_DARK)).toBe('hc-black')
    expect(toMonacoBase(ColorScheme.HIGH_CONTRAST_LIGHT)).toBe('hc-light')
  })

  it('sanitizes theme names', () => {
    expect(toMonacoThemeName('Universe Dark')).toBe('universe-Universe-Dark')
    expect(toMonacoThemeName('Dark+ (2026)')).toBe('universe-Dark---2026-')
  })
})

describe('tokenColorRulesToMonacoRules', () => {
  it('splits multi-scope rules, strips hash prefixes and keeps fontStyle', () => {
    const rules = tokenColorRulesToMonacoRules([
      { settings: { foreground: '#d0d0d0', background: '#101010' } },
      {
        scope: ['string', 'markup.inline'],
        settings: { foreground: '#a05050', fontStyle: 'italic' },
      },
      { scope: 'comment, punctuation.definition.comment', settings: { foreground: '#608060' } },
      { scope: 'keyword', settings: {} },
    ])
    expect(rules[0]).toEqual({ token: '', foreground: 'd0d0d0', background: '101010' })
    expect(rules[1]).toEqual({ token: 'string', foreground: 'a05050', fontStyle: 'italic' })
    expect(rules[2]).toEqual({ token: 'markup.inline', foreground: 'a05050', fontStyle: 'italic' })
    expect(rules[3]).toEqual({ token: 'comment', foreground: '608060' })
    expect(rules[4]).toEqual({ token: 'punctuation.definition.comment', foreground: '608060' })
    expect(rules[5]).toEqual({ token: 'keyword' })
  })
})

describe('toStandaloneThemeData', () => {
  beforeEach(() => {
    registerUniverseColorIds()
  })

  it('collects editor*/diffEditor* colors only and converts rules', () => {
    const theme = ColorThemeData.createUnloadedTheme('Test', ColorScheme.DARK, {
      'editor.background': '#101010',
      'sideBar.background': '#202020',
    })
    const { name, data } = toStandaloneThemeData(theme)
    expect(name).toBe('universe-Test')
    expect(data.base).toBe('vs-dark')
    expect(data.inherit).toBe(true)
    expect(data.colors['editor.background']).toBe('#101010')
    expect(data.colors['editor.foreground']).toBe('#c8c8c8')
    expect(data.colors['sideBar.background']).toBeUndefined()
    expect(data.colors['diffEditor.insertedTextBackground']).toBe('rgba(46, 160, 67, 0.18)')
    expect(data.rules.length).toBeGreaterThan(0)
    expect(data.rules[0]?.token).toBe('')
    // The default rule's foreground goes through normalizeColor (uppercase,
    // like VSCode); monaco parses rule colors case-insensitively.
    expect(data.rules[0]?.foreground).toBe('C8C8C8')
  })

  it('applies lineHighlight overrides', () => {
    const theme = ColorThemeData.createUnloadedTheme('Test', ColorScheme.DARK, {})
    const { data } = toStandaloneThemeData(theme, {
      lineHighlightBackground: '#123456',
      lineHighlightBorder: '#654321',
    })
    expect(data.colors['editor.lineHighlightBackground']).toBe('#123456')
    expect(data.colors['editor.lineHighlightBorder']).toBe('#654321')
  })
})
