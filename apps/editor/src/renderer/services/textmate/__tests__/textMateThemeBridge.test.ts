/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ColorScheme } from '@universe-editor/platform'
import { describe, expect, it } from 'vitest'
import { ColorThemeData } from '../../themes/colorThemeData.js'
import { toTextMateRawTheme } from '../textMateThemeBridge.js'

describe('toTextMateRawTheme', () => {
  it('keeps scope/fontStyle/colors and drops the font channel', () => {
    const theme = ColorThemeData.createUnloadedTheme('My Theme', ColorScheme.DARK, {
      'editor.foreground': '#D4D4D4',
      'editor.background': '#1E1E1E',
    })
    theme.setCustomTokenColors([
      {
        name: 'Keywords',
        scope: ['keyword', 'storage'],
        settings: { foreground: '#FF0000', fontStyle: 'bold italic' },
      },
      {
        scope: 'comment',
        settings: {
          foreground: '#00FF00',
          background: '#102010',
          fontFamily: 'Fira Code',
          fontSize: '13',
          lineHeight: 18,
        },
      },
    ])

    const raw = toTextMateRawTheme(theme)
    expect(raw.name).toBe('My Theme')

    // First rule is the synthesized default rule from editor fg/bg.
    expect(raw.settings[0]).toEqual({
      settings: { foreground: '#D4D4D4', background: '#1E1E1E' },
    })

    // VSCode's tokenColors getter drops rule names; match by scope instead.
    const keyword = raw.settings.find((r) => Array.isArray(r.scope) && r.scope[0] === 'keyword')
    expect(keyword).toEqual({
      scope: ['keyword', 'storage'],
      settings: { foreground: '#FF0000', fontStyle: 'bold italic' },
    })

    const comment = raw.settings.find((r) => r.scope === 'comment')
    expect(comment?.settings).toEqual({ foreground: '#00FF00', background: '#102010' })
    expect('fontFamily' in (comment?.settings ?? {})).toBe(false)
    expect('fontSize' in (comment?.settings ?? {})).toBe(false)
    expect('lineHeight' in (comment?.settings ?? {})).toBe(false)
  })

  it('produces a color map whose index 0 is the None slot', () => {
    const theme = ColorThemeData.createUnloadedTheme('Map', ColorScheme.DARK, {
      'editor.foreground': '#D4D4D4',
      'editor.background': '#1E1E1E',
    })
    const map = theme.tokenColorMap
    expect(map[0]).toBe('')
    // The default rule colors occupy ColorId.DefaultForeground (1) and
    // ColorId.DefaultBackground (2), like VSCode's TokenColorIndex.
    expect(map[1]).toBe('#D4D4D4')
    expect(map[2]).toBe('#1E1E1E')
  })

  it('normalizes rule colors to the tokenColorMap entry form (frozen map lookup)', () => {
    const theme = ColorThemeData.createUnloadedTheme('Norm', ColorScheme.DARK, {
      'editor.foreground': '#D4D4D4',
      'editor.background': '#1E1E1E',
    })
    theme.setCustomTokenColors([
      // Lower-case + alpha'd hex: vscode-textmate's frozen ColorMap looks the
      // rule color up literally, so it must match the table entry byte-for-byte.
      { scope: 'constant', settings: { foreground: '#ae81ffa0', background: '#10201080' } },
      { scope: 'invalid', settings: { foreground: 'garbage' } },
    ])

    const raw = toTextMateRawTheme(theme)
    const constant = raw.settings.find((r) => r.scope === 'constant')
    expect(constant?.settings).toEqual({ foreground: '#AE81FF', background: '#102010' })
    expect(theme.tokenColorMap).toContain('#AE81FF')
    expect(theme.tokenColorMap).toContain('#102010')
    // Unparseable colors are dropped from the rule instead of poisoning the
    // frozen color map with a value it cannot resolve.
    const invalid = raw.settings.find((r) => r.scope === 'invalid')
    expect(invalid?.settings).toEqual({})
  })
})
