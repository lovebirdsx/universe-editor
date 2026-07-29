/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ColorScheme, ThemeTypeSelector, URI } from '@universe-editor/platform'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ColorThemeData,
  loadThemeDocument,
  mergeThemeDocuments,
  normalizeColor,
  toCSSSelector,
  type IRawThemeDocument,
} from '../colorThemeData.js'
import { registerUniverseColorIds } from '../universeColorIds.js'

function fileReader(files: Record<string, string>): (uri: URI) => Promise<string> {
  return async (uri: URI) => {
    const content = files[uri.path]
    if (content === undefined) {
      throw new Error(`ENOENT: ${uri.path}`)
    }
    return content
  }
}

const themeFile = (path: string) => URI.file(path)

describe('loadThemeDocument', () => {
  it('parses colors, tokenColors, semanticHighlighting and semanticTokenColors', async () => {
    const doc = await loadThemeDocument(
      fileReader({
        '/themes/a.json': `{
          // JSONC comments are allowed
          "colors": { "editor.background": "#112233", "sideBar.background": "#445566", },
          "tokenColors": [
            { "scope": "comment", "settings": { "foreground": "#777777" } }
          ],
          "semanticHighlighting": true,
          "semanticTokenColors": { "newOperator": "#C586C0", "*.declaration": { "bold": true } }
        }`,
      }),
      themeFile('/themes/a.json'),
    )
    expect(doc.colors).toEqual({
      'editor.background': '#112233',
      'sideBar.background': '#445566',
    })
    expect(doc.tokenColors).toHaveLength(1)
    expect(doc.semanticHighlighting).toBe(true)
    expect(doc.semanticTokenColors['newOperator']).toBe('#C586C0')
  })

  it('merges include chains with later files overriding earlier ones', async () => {
    const files = {
      '/themes/base.json': `{
        "colors": { "editor.background": "#111111", "editor.foreground": "#222222", "sideBar.background": "#333333" },
        "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#100000" } }]
      }`,
      '/themes/mid.json': `{
        "include": "./base.json",
        "colors": { "editor.background": "#aaaaaa" },
        "tokenColors": [{ "scope": "string", "settings": { "foreground": "#200000" } }]
      }`,
      '/themes/top.json': `{
        "include": "./mid.json",
        "colors": { "editor.foreground": "#bbbbbb" }
      }`,
    }
    const doc = await loadThemeDocument(fileReader(files), themeFile('/themes/top.json'))
    expect(doc.colors).toEqual({
      'editor.background': '#aaaaaa',
      'editor.foreground': '#bbbbbb',
      'sideBar.background': '#333333',
    })
    // token rules accumulate base-first so later rules win in scope matching
    expect(doc.tokenColors.map((r) => r.scope)).toEqual(['comment', 'string'])
  })

  it('"default" color values remove inherited keys', async () => {
    const files = {
      '/themes/base.json': `{ "colors": { "editor.background": "#111111", "editor.foreground": "#222222" } }`,
      '/themes/top.json': `{ "include": "./base.json", "colors": { "editor.background": "default" } }`,
    }
    const doc = await loadThemeDocument(fileReader(files), themeFile('/themes/top.json'))
    expect(doc.colors).toEqual({ 'editor.foreground': '#222222' })
  })

  it('detects circular includes', async () => {
    const files = {
      '/themes/a.json': `{ "include": "./b.json" }`,
      '/themes/b.json': `{ "include": "./a.json" }`,
    }
    await expect(loadThemeDocument(fileReader(files), themeFile('/themes/a.json'))).rejects.toThrow(
      /ircular/,
    )
  })

  it('rejects non-json theme files and tmTheme tokenColors references', async () => {
    await expect(
      loadThemeDocument(
        fileReader({ '/themes/a.tmtheme': '<plist/>' }),
        themeFile('/themes/a.tmtheme'),
      ),
    ).rejects.toThrow(/only \.json/)
    await expect(
      loadThemeDocument(
        fileReader({ '/themes/a.json': `{ "tokenColors": "./x.tmTheme" }` }),
        themeFile('/themes/a.json'),
      ),
    ).rejects.toThrow(/tmTheme/)
  })

  it('rejects malformed JSON and non-object documents', async () => {
    await expect(
      loadThemeDocument(
        fileReader({ '/themes/a.json': '{ "colors": ' }),
        themeFile('/themes/a.json'),
      ),
    ).rejects.toThrow(/arsing/)
    await expect(
      loadThemeDocument(fileReader({ '/themes/a.json': '[1,2]' }), themeFile('/themes/a.json')),
    ).rejects.toThrow(/Object expected/)
    await expect(
      loadThemeDocument(
        fileReader({ '/themes/a.json': '{ "colors": [1] }' }),
        themeFile('/themes/a.json'),
      ),
    ).rejects.toThrow(/colors/)
  })
})

describe('mergeThemeDocuments', () => {
  const base: IRawThemeDocument = {
    colors: { a: '#111111', b: '#222222' },
    tokenColors: [{ scope: 'x', settings: {} }],
    semanticHighlighting: false,
    semanticTokenColors: { s1: '#101010' },
  }

  it('overlays colors, concatenates token rules, ors semanticHighlighting', () => {
    const merged = mergeThemeDocuments(base, {
      colors: { b: '#333333', c: '#444444' },
      tokenColors: [{ scope: 'y', settings: {} }],
      semanticHighlighting: true,
      semanticTokenColors: { s2: '#202020' },
    })
    expect(merged.colors).toEqual({ a: '#111111', b: '#333333', c: '#444444' })
    expect(merged.tokenColors.map((r) => r.scope)).toEqual(['x', 'y'])
    expect(merged.semanticHighlighting).toBe(true)
    expect(merged.semanticTokenColors).toEqual({ s1: '#101010', s2: '#202020' })
  })
})

describe('toCSSSelector', () => {
  it('sanitizes extension id and path into a valid css selector', () => {
    expect(toCSSSelector('publisher.ext', './themes/dark.json')).toBe(
      'publisher-ext-themes-dark-json',
    )
    expect(toCSSSelector('publisher.ext', 'themes/1dark.json')).toBe(
      'publisher-ext-themes-1dark-json',
    )
    expect(toCSSSelector('1pub.ext', 'themes/dark.json')).toBe('_1pub-ext-themes-dark-json')
  })
})

describe('ColorThemeData', () => {
  beforeEach(() => {
    registerUniverseColorIds()
  })

  const files = {
    '/themes/dark.json': `{
      "colors": { "editor.background": "#101010", "editor.foreground": "#d0d0d0" },
      "tokenColors": [
        { "scope": "comment", "settings": { "foreground": "#608060" } },
        { "scope": ["string", "markup.inline"], "settings": { "foreground": "#a05050", "fontStyle": "italic" } }
      ],
      "semanticHighlighting": true
    }`,
  }

  async function loadTestTheme(): Promise<ColorThemeData> {
    const theme = ColorThemeData.fromExtensionTheme(
      {
        id: 'Test Dark',
        label: 'Test Dark',
        uiTheme: ThemeTypeSelector.VS_DARK,
        path: './themes/dark.json',
      },
      themeFile('/themes/dark.json'),
      { extensionId: 'test.themes', extensionIsBuiltin: true },
    )
    await theme.ensureLoaded(fileReader(files))
    return theme
  }

  it('fromExtensionTheme composes id / settingsId / type like VSCode', async () => {
    const theme = await loadTestTheme()
    expect(theme.id).toBe('vs-dark test-themes-themes-dark-json')
    expect(theme.settingsId).toBe('Test Dark')
    expect(theme.type).toBe(ColorScheme.DARK)
    expect(theme.semanticHighlighting).toBe(true)
    expect(theme.isLoaded).toBe(true)
  })

  it('getColor resolves theme colorMap then registry defaults', async () => {
    const theme = await loadTestTheme()
    expect(theme.getColor('editor.background')?.toString()).toBe('#101010')
    // not defined by the theme -> registry default (Universe Dark slot)
    expect(theme.getColor('sideBar.background')?.toString()).toBe('#242427')
    expect(theme.defines('editor.background')).toBe(true)
    expect(theme.defines('sideBar.background')).toBe(false)
    expect(theme.getColor('sideBar.background', false)).toBeUndefined()
  })

  it('custom colors override theme colors; "default" restores the registry default', async () => {
    const theme = await loadTestTheme()
    theme.setCustomColors({ 'editor.background': '#ff0000', 'sideBar.background': '#00ff00' })
    expect(theme.getColor('editor.background')?.toString()).toBe('#ff0000')
    expect(theme.getColor('sideBar.background')?.toString()).toBe('#00ff00')

    theme.setCustomColors({ 'editor.background': 'default' })
    expect(theme.getColor('editor.background')?.toString()).toBe('#1a1a1c')
    expect(theme.defines('editor.background')).toBe(false)
  })

  it('tokenColors start with the default rule from editor colors', async () => {
    const theme = await loadTestTheme()
    const rules = theme.tokenColors
    expect(rules[0]?.scope).toBeUndefined()
    expect(rules[0]?.settings.foreground).toBe('#d0d0d0')
    expect(rules[0]?.settings.background).toBe('#101010')
    expect(rules[1]?.scope).toBe('comment')
    expect(rules[2]?.scope).toEqual(['string', 'markup.inline'])
    expect(rules[2]?.settings.fontStyle).toBe('italic')
  })

  it('appends default token.info/warn/error/debug rules when the theme lacks them', async () => {
    const theme = await loadTestTheme()
    const scopes = theme.tokenColors.map((r) => r.scope)
    expect(scopes).toContain('token.info-token')
    expect(scopes).toContain('token.error-token')
  })

  it('custom token colors come after theme colors', async () => {
    const theme = await loadTestTheme()
    theme.setCustomTokenColors([{ scope: 'keyword', settings: { foreground: '#123456' } }])
    const scopes = theme.tokenColors.map((r) => r.scope)
    expect(scopes.indexOf('keyword')).toBeGreaterThan(scopes.indexOf('comment'))
  })

  it('tokenColorMap assigns stable deduplicated indices', async () => {
    const theme = await loadTestTheme()
    const map = theme.tokenColorMap
    expect(map.length).toBeGreaterThan(2)
    const first = theme.getTokenColorIndexId('#608060')
    expect(theme.getTokenColorIndexId('#608060')).toBe(first)
    expect(theme.getTokenColorIndexId('#608060'.toUpperCase())).toBe(first)
    expect(map[first]).toBe('#608060')
  })

  it('storage snapshot round-trips colors, token colors and semantic state', async () => {
    const theme = await loadTestTheme()
    const restored = ColorThemeData.fromStorageSnapshot(theme.toStorageSnapshot())
    expect(restored).toBeDefined()
    expect(restored!.id).toBe(theme.id)
    expect(restored!.settingsId).toBe('Test Dark')
    expect(restored!.type).toBe(ColorScheme.DARK)
    expect(restored!.getColor('editor.background')?.toString()).toBe('#101010')
    expect(restored!.tokenColors.map((r) => r.scope)).toEqual(theme.tokenColors.map((r) => r.scope))
    expect(restored!.semanticHighlighting).toBe(true)
    expect(restored!.isLoaded).toBe(true)
  })

  it('fromStorageSnapshot rejects malformed data', () => {
    expect(ColorThemeData.fromStorageSnapshot({} as never)).toBeUndefined()
  })

  it('createUnloadedTheme synthesizes a loaded theme from a color map', () => {
    const theme = ColorThemeData.createUnloadedTheme('Fallback', ColorScheme.DARK, {
      'editor.background': '#0f0f0f',
    })
    expect(theme.isLoaded).toBe(true)
    expect(theme.getColor('editor.background')?.toString()).toBe('#0f0f0f')
    expect(theme.getColor('sideBar.background')?.toString()).toBe('#242427')
  })
})

describe('normalizeColor', () => {
  it('normalizes hex strings to #rrggbb(aa)', () => {
    expect(normalizeColor('#abc')).toBe('#aabbcc')
    expect(normalizeColor('#aabbccdd')).toBe('#aabbccdd')
    expect(normalizeColor('rgba(1, 2, 3, 0.5)')).toBe('#01020380')
    expect(normalizeColor(undefined)).toBeUndefined()
    expect(normalizeColor('garbage')).toBeUndefined()
  })
})
