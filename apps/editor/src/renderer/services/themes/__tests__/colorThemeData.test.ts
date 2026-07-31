/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Color, ColorScheme, ThemeTypeSelector, URI } from '@universe-editor/platform'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ColorThemeData,
  loadThemeDocument,
  mergeThemeDocuments,
  normalizeColor,
  toCSSSelector,
  type IRawThemeDocument,
  type ISerializedColorThemeData,
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
        { "scope": ["string", "markup.inline"], "settings": { "foreground": "#a05050", "fontStyle": "italic" } },
        { "scope": "variable.other.constant", "settings": { "foreground": "#4FC1FF", "fontStyle": "bold" } },
        { "scope": "support.type", "settings": { "foreground": "#4EC9B0" } }
      ],
      "semanticHighlighting": true,
      "semanticTokenColors": {
        "newOperator": "#C586C0",
        "*.declaration": { "bold": true },
        "variable.readonly:typescript": { "foreground": "#FF0000" },
        "class.defaultLibrary": { "italic": true },
        "type.defaultLibrary": { "italic": true },
        "unsupportedProperty": { "unknownThing": 1 },
        "resetMe": false
      }
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
    expect(rules[0]?.settings.foreground).toBe('#d0d0d0'.toUpperCase())
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

  it('tokenColorMap assigns stable deduplicated indices starting at 1', async () => {
    const theme = await loadTestTheme()
    const map = theme.tokenColorMap
    expect(map.length).toBeGreaterThan(2)
    // Index 0 is the ColorId.None slot and never a real color.
    expect(map[0]).toBe('')
    const first = theme.getTokenColorIndexId('#608060')
    expect(first).toBeGreaterThanOrEqual(1)
    expect(theme.getTokenColorIndexId('#608060')).toBe(first)
    expect(theme.getTokenColorIndexId('#608060'.toUpperCase())).toBe(first)
    expect(map[first]).toBe('#608060'.toUpperCase())
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

  it('getSemanticTokenStyle resolves theme rules by selector scoring', async () => {
    const theme = await loadTestTheme()
    // exact string rule
    expect(theme.getSemanticTokenStyle('newOperator', [], 'typescript')).toEqual({
      foreground: '#C586C0',
      bold: undefined,
      underline: undefined,
      strikethrough: undefined,
      italic: undefined,
    })
    // wildcard + modifier subset
    expect(
      theme.getSemanticTokenStyle('variable', ['declaration', 'readonly'], 'typescript')?.bold,
    ).toBe(true)
    // language-scoped rule wins foreground over plain rules at same type
    expect(theme.getSemanticTokenStyle('variable', ['readonly'], 'typescript')?.foreground).toBe(
      '#FF0000',
    )
    // language mismatch falls through to default rules (variable.readonly -> variable.other.constant)
    const fallback = theme.getSemanticTokenStyle('variable', ['readonly'], 'javascript')
    expect(fallback?.foreground).toBe('#4FC1FF')
    expect(fallback?.bold).toBe(true)
  })

  it('getSemanticTokenStyle per-property merge keeps higher scores, fills misses from default rules', async () => {
    const theme = await loadTestTheme()
    // type.defaultLibrary sets italic; foreground is not set by any matching semantic rule,
    // so the default rule (type.defaultLibrary -> support.type) supplies it.
    const style = theme.getSemanticTokenStyle('type', ['defaultLibrary'], 'typescript')
    expect(style?.italic).toBe(true)
    expect(style?.foreground).toBe('#4EC9B0')
  })

  it('getSemanticTokenStyle returns undefined when nothing matches and no default rule applies', async () => {
    const theme = await loadTestTheme()
    expect(theme.getSemanticTokenStyle('keyword', [], 'typescript')).toBeUndefined()
  })

  it('skips rules with unknown properties, false values and invalid selectors', async () => {
    const theme = await loadTestTheme()
    // `unsupportedProperty` has no known style attribute -> no rule -> undefined.
    expect(theme.getSemanticTokenStyle('unsupportedProperty', [], 'typescript')).toBeUndefined()
    // `resetMe: false` produces no rule.
    expect(theme.getSemanticTokenStyle('resetMe', [], 'typescript')).toBeUndefined()
  })

  it('custom semantic rules override theme rules at equal score', async () => {
    const theme = await loadTestTheme()
    theme.setCustomSemanticTokenColors({ newOperator: '#00FF00' })
    expect(theme.getSemanticTokenStyle('newOperator', [], 'typescript')?.foreground).toBe('#00FF00')
  })

  it('getTokenStyleMetadata encodes foreground as a colorMap index', async () => {
    const theme = await loadTestTheme()
    const meta = theme.getTokenStyleMetadata('newOperator', [], 'typescript')
    expect(meta).toBeDefined()
    expect(meta!.foreground).toBeGreaterThanOrEqual(1)
    expect(theme.tokenColorMap[meta!.foreground!]).toBe('#C586C0')
    expect(meta!.bold).toBeUndefined()
    // modifiers must be passed separately; the wildcard declaration rule applies
    const decl = theme.getTokenStyleMetadata('variable', ['declaration'], 'typescript')
    expect(decl?.bold).toBe(true)
  })

  describe('non-hex color values (built-in themes historically used rgba())', () => {
    const loadThemeWithColors = async (colors: Record<string, string>): Promise<ColorThemeData> => {
      const theme = ColorThemeData.fromExtensionTheme(
        {
          id: 'Test Dark',
          label: 'Test Dark',
          uiTheme: ThemeTypeSelector.VS_DARK,
          path: './themes/colors.json',
        },
        themeFile('/themes/colors.json'),
        { extensionId: 'test.themes', extensionIsBuiltin: true },
      )
      await theme.ensureLoaded(fileReader({ '/themes/colors.json': JSON.stringify({ colors }) }))
      return theme
    }

    it('reload resolves rgba() theme colors to their real value instead of red', async () => {
      const theme = await loadThemeWithColors({ 'error.background': 'rgba(209, 36, 47, 0.12)' })
      expect(Color.Format.CSS.formatHexA(theme.getColor('error.background')!)).toBe('#d1242f1f')
    })

    it('reload skips malformed colors and falls back to the registry default', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const theme = await loadThemeWithColors({ 'editor.background': 'rgba(1,2)' })
        expect(theme.defines('editor.background')).toBe(false)
        expect(theme.getColor('editor.background')?.toString()).toBe('#1a1a1c')
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })

    it('setCustomColors accepts rgba() and skips garbage values', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const theme = await loadThemeWithColors({})
        theme.setCustomColors({
          'editor.background': 'rgba(209, 36, 47, 0.12)',
          'sideBar.background': 'rgba(1,2)',
          'editor.foreground': 'not-a-color',
        })
        expect(Color.Format.CSS.formatHexA(theme.getColor('editor.background')!)).toBe('#d1242f1f')
        // garbage skipped -> falls back to the registry default
        expect(theme.getColor('sideBar.background')?.toString()).toBe('#242427')
        expect(warn).toHaveBeenCalledTimes(2)
      } finally {
        warn.mockRestore()
      }
    })

    it('createUnloadedTheme parses rgba() color maps', () => {
      const theme = ColorThemeData.createUnloadedTheme('Fallback', ColorScheme.DARK, {
        'editor.background': 'rgba(16, 16, 16, 1)',
      })
      expect(theme.getColor('editor.background')?.toString()).toBe('#101010')
    })

    it('fromStorageSnapshot keeps valid entries and skips corrupted ones', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const snapshot: ISerializedColorThemeData = {
          id: 'vs-dark test-themes-themes-colors-json',
          label: 'Test Dark',
          settingsId: 'Test Dark',
          type: ColorScheme.DARK,
          colorMap: {
            'editor.background': '#101010',
            'error.background': 'rgba(209, 36, 47, 0.12)',
            'sideBar.background': 'bogus',
          },
          tokenColors: [],
          semanticTokenColors: {},
          semanticHighlighting: false,
        }
        const theme = ColorThemeData.fromStorageSnapshot(snapshot)!
        expect(theme.getColor('editor.background')?.toString()).toBe('#101010')
        expect(Color.Format.CSS.formatHexA(theme.getColor('error.background')!)).toBe('#d1242f1f')
        expect(theme.defines('sideBar.background')).toBe(false)
        expect(warn).toHaveBeenCalledTimes(1)
      } finally {
        warn.mockRestore()
      }
    })
  })
})

describe('normalizeColor', () => {
  it('normalizes hex strings to uppercase #RRGGBB(AA) (vscode-textmate looks up colors uppercased)', () => {
    expect(normalizeColor('#abc')).toBe('#AABBCC')
    expect(normalizeColor('#aabbccdd')).toBe('#AABBCCDD')
    expect(normalizeColor('rgba(1, 2, 3, 0.5)')).toBe('#01020380')
    expect(normalizeColor(undefined)).toBeUndefined()
    expect(normalizeColor('garbage')).toBeUndefined()
  })

  it('returns undefined for malformed rgba() instead of throwing (CSS.parse throws on it)', () => {
    expect(normalizeColor('rgba(banana)')).toBeUndefined()
    expect(normalizeColor('rgba(255, 255)')).toBeUndefined()
  })
})
