/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ColorScheme } from '@universe-editor/platform'
import { beforeEach, describe, expect, it } from 'vitest'
import { ColorThemeData } from '../colorThemeData.js'
import { generateColorThemeCSS } from '../generateColorThemeCss.js'
import { registerUniverseColorIds } from '../universeColorIds.js'

describe('generateColorThemeCSS', () => {
  beforeEach(() => {
    registerUniverseColorIds()
  })

  it('emits --vscode-* variables for every registered color under :root', () => {
    const theme = ColorThemeData.createUnloadedTheme('Test', ColorScheme.DARK, {
      'editor.background': '#101010',
    })
    const css = generateColorThemeCSS(theme)
    expect(css.startsWith(':root {')).toBe(true)
    expect(css).toContain('--vscode-editor-background: #101010;')
    // falls back to registry defaults for colors the theme does not define
    expect(css).toContain('--vscode-sideBar-background: #242427;')
    expect(css).toContain('--vscode-terminal-ansiBrightWhite: #ffffff;')
  })

  it('serializes translucent colors as rgba()', () => {
    const theme = ColorThemeData.createUnloadedTheme('Test', ColorScheme.DARK, {})
    const css = generateColorThemeCSS(theme)
    expect(css).toContain('--vscode-activityBar-hoverBackground: rgba(255, 255, 255, 0.06);')
  })

  it('honors a custom scope selector', () => {
    const theme = ColorThemeData.createUnloadedTheme('Test', ColorScheme.DARK, {})
    const css = generateColorThemeCSS(theme, '.monaco-workbench')
    expect(css.startsWith('.monaco-workbench {')).toBe(true)
  })

  it('applies user customizations through the theme', () => {
    const theme = ColorThemeData.createUnloadedTheme('Test', ColorScheme.DARK, {})
    theme.setCustomColors({ 'sideBar.background': '#ff0000' })
    const css = generateColorThemeCSS(theme)
    expect(css).toContain('--vscode-sideBar-background: #ff0000;')
  })
})
