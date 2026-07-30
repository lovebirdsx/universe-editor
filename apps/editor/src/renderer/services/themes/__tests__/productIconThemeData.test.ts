/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { getIconRegistry, URI } from '@universe-editor/platform'
import {
  DEFAULT_PRODUCT_ICON_THEME_ID,
  loadProductIconThemeDocument,
  ProductIconThemeData,
  resolveIconDefinition,
} from '../productIconThemeData.js'
import { generateProductIconThemeCss } from '../generateProductIconThemeCss.js'

function makeReader(files: Record<string, string>): (uri: URI) => Promise<string> {
  return async (uri) => {
    const text = files[uri.fsPath]
    if (text === undefined) {
      throw new Error(`ENOENT: ${uri.fsPath}`)
    }
    return text
  }
}

const LOCATION = URI.file('/ext/product/product-icons.json')

const PRODUCT_DOC = JSON.stringify({
  fonts: [{ id: 'elegant', src: [{ path: './elegant.woff', format: 'woff' }] }],
  iconDefinitions: {
    add: { fontCharacter: '\\43' },
    search: { fontCharacter: '\\44', fontColor: '#ff0000' },
  },
})

const TEST_ICON_IDS = ['pi-test-a', 'pi-test-b', 'pi-test-inherited']

function seedRegistry(): void {
  const registry = getIconRegistry()
  registry.registerIcon('pi-test-a', { fontCharacter: '\\ea01' })
  registry.registerIcon('pi-test-b', { fontCharacter: '\\ea02' })
  registry.registerIcon('pi-test-inherited', { id: 'pi-test-a' })
}

afterEach(() => {
  const registry = getIconRegistry()
  for (const id of TEST_ICON_IDS) {
    registry.deregisterIcon(id)
  }
})

describe('ProductIconThemeData', () => {
  it('defaultTheme is loaded, empty-id and contributes no stylesheet', () => {
    const theme = ProductIconThemeData.defaultTheme
    expect(theme.id).toBe('')
    expect(theme.settingsId).toBe(DEFAULT_PRODUCT_ICON_THEME_ID)
    expect(theme.isLoaded).toBe(true)
    theme.buildStyleSheet((l) => l)
    expect(theme.styleSheetContent).toBe('')
  })

  it('fromExtensionTheme composes id as extensionId-themeId', () => {
    const theme = ProductIconThemeData.fromExtensionTheme(
      { id: 'elegant', label: 'Elegant', path: './product-icons.json' },
      LOCATION,
      { extensionId: 'ext', extensionIsBuiltin: false },
    )
    expect(theme.id).toBe('ext-elegant')
    expect(theme.settingsId).toBe('elegant')
  })

  it('ensureLoaded parses + validates the document', async () => {
    const theme = ProductIconThemeData.fromExtensionTheme(
      { id: 'elegant', path: './product-icons.json' },
      LOCATION,
      { extensionId: 'ext', extensionIsBuiltin: false },
    )
    await theme.ensureLoaded(makeReader({ [LOCATION.fsPath]: PRODUCT_DOC }))
    expect(theme.isLoaded).toBe(true)
    expect(theme.loadedFiles.map((u) => u.fsPath)).toEqual([LOCATION.fsPath])
  })

  it('buildStyleSheet emits override rules + @font-face for registered icons', async () => {
    seedRegistry()
    const registry = getIconRegistry()
    // Pretend codicons registered under their real names for this test.
    registry.registerIcon('add', { fontCharacter: '\\ea60' })
    const theme = ProductIconThemeData.fromExtensionTheme(
      { id: 'elegant', path: './product-icons.json' },
      LOCATION,
      { extensionId: 'ext', extensionIsBuiltin: false },
    )
    await theme.ensureLoaded(makeReader({ [LOCATION.fsPath]: PRODUCT_DOC }))
    theme.buildStyleSheet((l) => `universe-app://root/_resource_${URI.parse(l).fsPath}`)
    const css = theme.styleSheetContent ?? ''
    expect(css).toContain(".codicon-add:before { content: '\\\\43'; font-family: 'pi-elegant'; }")
    expect(css).toContain(
      "@font-face { src: url('universe-app://root/_resource_/ext/product/elegant.woff') format('woff'); font-family: 'pi-elegant'; font-display: block; }",
    )
    expect(css).toContain('--vscode-icon-add-font-family')
    registry.deregisterIcon('add')
  })

  it('rejects documents without iconDefinitions/fonts', async () => {
    await expect(
      loadProductIconThemeDocument(
        makeReader({ [LOCATION.fsPath]: JSON.stringify({ iconDefinitions: {} }) }),
        LOCATION,
      ),
    ).rejects.toThrow('Must contain iconDefinitions and fonts')
  })

  it('skips icon definitions referencing unknown fonts', async () => {
    const doc = JSON.stringify({
      fonts: [{ id: 'elegant', src: [{ path: './e.woff', format: 'woff' }] }],
      iconDefinitions: { add: { fontCharacter: '\\43', fontId: 'missing' } },
    })
    const defs = await loadProductIconThemeDocument(
      makeReader({ [LOCATION.fsPath]: doc }),
      LOCATION,
    )
    expect(defs.size).toBe(0)
  })
})

describe('resolveIconDefinition', () => {
  it('resolves a direct definition hit', () => {
    seedRegistry()
    const defs = new Map([['pi-test-a', { fontCharacter: '\\43' }]])
    const contribution = getIconRegistry().getIcon('pi-test-a')!
    expect(resolveIconDefinition(contribution, defs)?.fontCharacter).toBe('\\43')
  })

  it('follows the defaults ThemeIcon chain', () => {
    seedRegistry()
    const defs = new Map([['pi-test-a', { fontCharacter: '\\43' }]])
    const contribution = getIconRegistry().getIcon('pi-test-inherited')!
    expect(resolveIconDefinition(contribution, defs)?.fontCharacter).toBe('\\43')
  })

  it('falls back to the contribution default when the theme has no definition', () => {
    seedRegistry()
    const contribution = getIconRegistry().getIcon('pi-test-a')!
    expect(resolveIconDefinition(contribution, new Map())?.fontCharacter).toBe('\\ea01')
  })
})

describe('generateProductIconThemeCss', () => {
  it('the default (unthemed) path emits codicon-font rules without a custom font-family', () => {
    seedRegistry()
    const css = generateProductIconThemeCss(ProductIconThemeData.defaultTheme, (l) => l)
    expect(css).toContain(".codicon-pi-test-a:before { content: '\\\\ea01'; }")
    // No custom @font-face / override family — only the :root var pointing at codicon.
    expect(css).not.toContain('@font-face')
    expect(css).not.toContain("font-family: 'pi-")
    expect(css).toContain("--vscode-icon-pi-test-a-font-family: 'codicon'")
  })
})
