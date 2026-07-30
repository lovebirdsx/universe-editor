/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/themes/browser/productIconThemeData.ts
 *--------------------------------------------------------------------------------------------*/

/**
 * ProductIconThemeData —— VSCode `ProductIconThemeData` 的对等物（裁剪版）。
 *
 * 产品图标主题 = 一份 JSON：自带 fonts（@font-face 定义）+ iconDefinitions
 * （codicon id → fontCharacter/fontId 覆盖）。加载后 `getIcon(contribution)`
 * 沿 IconContribution 的 defaults 链解析最终定义；样式表由
 * `generateProductIconThemeCss` 遍历 IconRegistry 生成
 * （`.codicon-<id>:before { content: ...; font-family: ... }` + @font-face），
 * 注入 `style.contributedProductIconTheme`。
 */

import {
  getIconRegistry,
  ThemeIcon,
  URI,
  type IconContribution,
  type IconDefinition,
  type IconFontDefinition,
  type IProductIconTheme,
} from '@universe-editor/platform'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import { generateProductIconThemeCss } from './generateProductIconThemeCss.js'

export const DEFAULT_PRODUCT_ICON_THEME_ID = 'Default'

interface IRawFontSource {
  readonly path?: unknown
  readonly format?: unknown
}

interface IRawFontDefinition {
  readonly id?: unknown
  readonly weight?: unknown
  readonly style?: unknown
  readonly src?: unknown
}

interface IRawIconDefinition {
  readonly fontCharacter?: unknown
  readonly fontId?: unknown
}

interface IRawProductIconThemeDocument {
  readonly iconDefinitions?: unknown
  readonly fonts?: unknown
}

// VSCode fontIdRegex / fontWeightRegex / fontStyleRegex / fontFormatRegex.
const FONT_ID_REGEX = /^[-_a-zA-Z0-9]+$/
const FONT_WEIGHT_REGEX = /^(normal|bold|lighter|bolder|[1-9]00)$/
const FONT_STYLE_REGEX = /^(normal|italic|oblique)$/
const FONT_FORMAT_REGEX = /^(woff|woff2|truetype|opentype|embedded-opentype|svg)$/

export class ProductIconThemeData implements IProductIconTheme {
  id: string
  label: string
  settingsId: string
  description?: string
  isLoaded = false
  location?: URI
  extensionData?: { readonly extensionId: string; readonly extensionIsBuiltin: boolean }
  watch = false
  styleSheetContent?: string
  loadedFiles: readonly URI[] = []

  /** iconId → resolved definition (post defaults-chain resolution). */
  private _iconDefinitions = new Map<string, IconDefinition>()

  private constructor(id: string, label: string, settingsId: string) {
    this.id = id
    this.label = label
    this.settingsId = settingsId
  }

  getIcon(iconContribution: IconContribution): IconDefinition | undefined {
    return resolveIconDefinition(iconContribution, this._iconDefinitions)
  }

  async ensureLoaded(readText: (uri: URI) => Promise<string>): Promise<string | undefined> {
    return !this.isLoaded ? this.reload(readText) : this.styleSheetContent
  }

  async reload(readText: (uri: URI) => Promise<string>): Promise<string | undefined> {
    const location = this.location
    if (location === undefined) {
      return this.styleSheetContent
    }
    this._iconDefinitions = await loadProductIconThemeDocument(readText, location)
    this.loadedFiles = [location]
    this.isLoaded = true
    return this.styleSheetContent
  }

  /**
   * (Re)build the injected stylesheet. Called by the theme service after load
   * and whenever the icon registry changes (new codicons registered by an
   * activated extension must pick up the current theme's overrides).
   */
  buildStyleSheet(resolveResourceUrl: (location: string) => string): void {
    // The default theme contributes no rules — codicon.css is the baseline.
    this.styleSheetContent =
      this.id === ''
        ? ''
        : generateProductIconThemeCss(this, (location) => resolveResourceUrl(location))
  }

  static fromExtensionTheme(
    contribution: { readonly id: string; readonly label?: string; readonly path: string },
    location: URI,
    extensionData: { readonly extensionId: string; readonly extensionIsBuiltin: boolean },
  ): ProductIconThemeData {
    const id = `${extensionData.extensionId}-${contribution.id}`
    const theme = new ProductIconThemeData(
      id,
      contribution.label ?? contribution.id,
      contribution.id,
    )
    theme.location = location
    theme.extensionData = extensionData
    return theme
  }

  static createUnloadedTheme(id: string): ProductIconThemeData {
    return new ProductIconThemeData(id, '', `__${id}`)
  }

  private static _defaultTheme: ProductIconThemeData | undefined

  /** The built-in default: raw codicons from `codicon.css` (no override rules). */
  static get defaultTheme(): ProductIconThemeData {
    let theme = ProductIconThemeData._defaultTheme
    if (theme === undefined) {
      theme = ProductIconThemeData._defaultTheme = new ProductIconThemeData(
        '',
        'Default',
        DEFAULT_PRODUCT_ICON_THEME_ID,
      )
      theme.isLoaded = true
      theme.watch = false
    }
    return theme
  }
}

/** Resolve an icon against a definition map, following the contribution's defaults chain. */
export function resolveIconDefinition(
  iconContribution: IconContribution,
  iconDefinitions: ReadonlyMap<string, IconDefinition>,
): IconDefinition | undefined {
  let definition: IconDefinition | undefined = iconDefinitions.get(iconContribution.id)
  let defaults = iconContribution.defaults
  const registry = getIconRegistry()
  while (definition === undefined && ThemeIcon.isThemeIcon(defaults)) {
    const ic = registry.getIcon(defaults.id)
    if (ic === undefined) {
      return undefined
    }
    definition = iconDefinitions.get(ic.id)
    defaults = ic.defaults
  }
  if (definition !== undefined) {
    return definition
  }
  if (!ThemeIcon.isThemeIcon(defaults)) {
    return defaults
  }
  return undefined
}

/**
 * Read + validate a product icon theme JSON document. Returns the resolved
 * definition map (fonts sanitized; unknown/invalid entries skipped). Font src
 * locations are resolved against the theme file's directory.
 */
export async function loadProductIconThemeDocument(
  readText: (uri: URI) => Promise<string>,
  location: URI,
): Promise<Map<string, IconDefinition>> {
  const content = await readText(location)
  const errors: ParseError[] = []
  const value = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as IRawProductIconThemeDocument
  if (errors.length > 0) {
    throw new Error(
      `Problems parsing product icons file: ${errors
        .map((e) => printParseErrorCode(e.error))
        .join(', ')}`,
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid format for product icons theme file: Object expected.')
  }
  if (
    typeof value.iconDefinitions !== 'object' ||
    value.iconDefinitions === null ||
    !Array.isArray(value.fonts) ||
    value.fonts.length === 0
  ) {
    throw new Error(
      'Invalid format for product icons theme file: Must contain iconDefinitions and fonts.',
    )
  }

  const themeDirname = URI.joinPath(location, '..')

  const sanitizedFonts = new Map<string, IconFontDefinition>()
  for (const font of value.fonts as readonly IRawFontDefinition[]) {
    const fontId = font.id
    if (typeof fontId !== 'string' || !FONT_ID_REGEX.test(fontId)) {
      continue
    }
    const weight =
      typeof font.weight === 'string' && FONT_WEIGHT_REGEX.test(font.weight)
        ? font.weight
        : undefined
    const style =
      typeof font.style === 'string' && FONT_STYLE_REGEX.test(font.style) ? font.style : undefined
    const src: IconFontDefinition['src'][number][] = []
    if (Array.isArray(font.src)) {
      for (const s of font.src as readonly IRawFontSource[]) {
        if (
          typeof s.path === 'string' &&
          typeof s.format === 'string' &&
          FONT_FORMAT_REGEX.test(s.format)
        ) {
          src.push({ location: URI.joinPath(themeDirname, s.path).toString(), format: s.format })
        }
      }
    }
    if (src.length > 0) {
      sanitizedFonts.set(fontId, {
        src,
        ...(weight !== undefined ? { weight } : {}),
        ...(style !== undefined ? { style } : {}),
      })
    }
  }

  const iconDefinitions = new Map<string, IconDefinition>()
  const primaryFontId = (value.fonts[0] as IRawFontDefinition).id as string
  for (const [iconId, definition] of Object.entries(
    value.iconDefinitions as Record<string, IRawIconDefinition>,
  )) {
    if (typeof definition.fontCharacter !== 'string') {
      continue
    }
    const fontId = typeof definition.fontId === 'string' ? definition.fontId : primaryFontId
    const fontDefinition = sanitizedFonts.get(fontId)
    if (fontDefinition === undefined) {
      continue
    }
    // `pi-` prefix avoids collisions with the built-in codicon font-family.
    iconDefinitions.set(iconId, {
      fontCharacter: definition.fontCharacter,
      font: { id: `pi-${fontId}`, definition: fontDefinition },
    })
  }
  return iconDefinitions
}
