/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/themes/common/colorThemeData.ts
 *--------------------------------------------------------------------------------------------*/

import {
  Color,
  ColorScheme,
  colorSchemeFromTypeSelector,
  DEFAULT_COLOR_CONFIG_VALUE,
  getColorRegistry,
  localize,
  ThemeTypeSelector,
  URI,
  type ColorIdentifier,
  type IColorTheme,
  type ITokenStyle,
} from '@universe-editor/platform'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'

// ---------------------------------------------------------------------------
// Theme file shapes
// ---------------------------------------------------------------------------

export interface ITokenColorSettings {
  foreground?: string
  background?: string
  fontStyle?: string
  fontFamily?: string
  fontSize?: string
  lineHeight?: number
}

export interface ITokenColorRule {
  name?: string
  scope?: string | string[]
  settings: ITokenColorSettings
}

export interface ISemanticTokenColorSettings {
  foreground?: string
  fontStyle?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
}

export type SemanticTokenColorValue = string | ISemanticTokenColorSettings | false

/** `contributes.themes[]` 条目（manifest DTO 形态，`path` 已为绝对路径）。 */
export interface IThemeContribution {
  id?: string
  label?: string
  description?: string
  uiTheme?: ThemeTypeSelector
  path: string
  _watch?: boolean
}

export interface IThemeExtensionData {
  extensionId: string
  extensionIsBuiltin: boolean
}

export interface IRawThemeDocument {
  colors: Record<string, string>
  tokenColors: ITokenColorRule[]
  semanticHighlighting: boolean
  semanticTokenColors: Record<string, SemanticTokenColorValue>
}

function emptyThemeDocument(): IRawThemeDocument {
  return { colors: {}, tokenColors: [], semanticHighlighting: false, semanticTokenColors: {} }
}

// ---------------------------------------------------------------------------
// Theme file loading (pure; the readText channel is injected)
// ---------------------------------------------------------------------------

/**
 * 加载并解析一个主题 JSON 文件，`include` 递归合并（后加载者覆盖先加载者；
 * `colors` 中值为 `"default"` 的键从合并结果删除，对齐 VSCode 语义）。
 * `visited` 给定的话收集整条 include 链访问过的文件（主题 watcher 用）。
 */
export async function loadThemeDocument(
  readText: (uri: URI) => Promise<string>,
  location: URI,
  seen: Set<string> = new Set(),
  visited?: URI[],
): Promise<IRawThemeDocument> {
  const key = location.toString()
  if (seen.has(key)) {
    throw new Error(
      localize('error.circularInclude', 'Circular include detected in theme file: {key}', {
        key,
      }),
    )
  }
  seen.add(key)
  visited?.push(location)

  if (!location.path.endsWith('.json')) {
    // tmTheme (plist) files are not supported; built-in themes must use the JSON form.
    throw new Error(
      localize(
        'error.unsupportedThemeFormat',
        'Unsupported theme file format (only .json is supported): {location}',
        { location: location.toString() },
      ),
    )
  }

  const content = await readText(location)
  const errors: ParseError[] = []
  const value = parse(content, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    throw new Error(
      localize('error.cannotParseJson', 'Problems parsing JSON theme file: {errors}', {
        errors: errors.map((e) => printParseErrorCode(e.error)).join(', '),
      }),
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      localize('error.invalidFormat', 'Invalid format for JSON theme file: Object expected.'),
    )
  }

  let base = emptyThemeDocument()
  if (typeof value.include === 'string') {
    const includeLocation = URI.joinPath(location, '..', value.include)
    base = await loadThemeDocument(readText, includeLocation, seen, visited)
  }
  return mergeThemeDocuments(base, parseThemeDocumentOverlay(value as Record<string, unknown>))
}

function parseThemeDocumentOverlay(value: Record<string, unknown>): IRawThemeDocument {
  const doc = emptyThemeDocument()

  doc.semanticHighlighting = value.semanticHighlighting === true

  const colors = value.colors
  if (colors !== undefined) {
    if (typeof colors !== 'object' || colors === null || Array.isArray(colors)) {
      throw new Error(
        localize(
          'error.invalidColors',
          "Problem parsing color theme file: 'colors' is not an object.",
        ),
      )
    }
    for (const [colorId, colorValue] of Object.entries(colors)) {
      if (typeof colorValue === 'string') {
        doc.colors[colorId] = colorValue
      }
    }
  }

  const tokenColors = value.tokenColors
  if (tokenColors !== undefined) {
    if (Array.isArray(tokenColors)) {
      for (const rule of tokenColors) {
        if (typeof rule === 'object' && rule !== null) {
          doc.tokenColors.push(rule as ITokenColorRule)
        }
      }
    } else if (typeof tokenColors === 'string') {
      throw new Error(
        localize(
          'error.externalTokenColors',
          "Problem parsing color theme file: 'tokenColors' pointing to a tmTheme file is not supported.",
        ),
      )
    } else {
      throw new Error(
        localize(
          'error.invalidTokenColors',
          "Problem parsing color theme file: 'tokenColors' should be an array of rules.",
        ),
      )
    }
  }

  const semanticTokenColors = value.semanticTokenColors
  if (semanticTokenColors !== undefined) {
    if (typeof semanticTokenColors !== 'object' || semanticTokenColors === null) {
      throw new Error(
        localize(
          'error.invalidSemanticTokenColors',
          "Problem parsing color theme file: 'semanticTokenColors' is not an object.",
        ),
      )
    }
    for (const [selector, ruleValue] of Object.entries(semanticTokenColors)) {
      if (
        typeof ruleValue === 'string' ||
        ruleValue === false ||
        (typeof ruleValue === 'object' && ruleValue !== null)
      ) {
        doc.semanticTokenColors[selector] = ruleValue as SemanticTokenColorValue
      }
    }
  }

  return doc
}

export function mergeThemeDocuments(
  base: IRawThemeDocument,
  overlay: IRawThemeDocument,
): IRawThemeDocument {
  const colors: Record<string, string> = { ...base.colors }
  for (const [colorId, colorValue] of Object.entries(overlay.colors)) {
    if (colorValue === DEFAULT_COLOR_CONFIG_VALUE) {
      delete colors[colorId]
    } else {
      colors[colorId] = colorValue
    }
  }
  return {
    colors,
    tokenColors: [...base.tokenColors, ...overlay.tokenColors],
    semanticHighlighting: base.semanticHighlighting || overlay.semanticHighlighting,
    semanticTokenColors: { ...base.semanticTokenColors, ...overlay.semanticTokenColors },
  }
}

// ---------------------------------------------------------------------------
// ColorThemeData
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_COLORS: { [scheme: string]: ITokenColorRule[] } = {
  [ColorScheme.LIGHT]: [
    { scope: 'token.info-token', settings: { foreground: '#316bcd' } },
    { scope: 'token.warn-token', settings: { foreground: '#cd9731' } },
    { scope: 'token.error-token', settings: { foreground: '#cd3131' } },
    { scope: 'token.debug-token', settings: { foreground: '#800080' } },
  ],
  [ColorScheme.DARK]: [
    { scope: 'token.info-token', settings: { foreground: '#6796e6' } },
    { scope: 'token.warn-token', settings: { foreground: '#cd9731' } },
    { scope: 'token.error-token', settings: { foreground: '#f44747' } },
    { scope: 'token.debug-token', settings: { foreground: '#b267e6' } },
  ],
}

export interface ISerializedColorThemeData {
  id: string
  label: string
  settingsId: string
  type: ColorScheme
  colorMap: Record<string, string>
  tokenColors: ITokenColorRule[]
  semanticTokenColors: Record<string, SemanticTokenColorValue>
  semanticHighlighting: boolean
}

export class ColorThemeData implements IColorTheme {
  id: string
  label: string
  settingsId: string
  description?: string
  isLoaded = false
  location?: URI
  watch = false
  extensionData?: IThemeExtensionData
  /** 整条 include 链访问过的文件（reload 后刷新；主题 watcher 订阅这些路径）。 */
  loadedFiles: readonly URI[] = []

  private readonly _type: ColorScheme
  private themeTokenColors: ITokenColorRule[] = []
  private customTokenColors: ITokenColorRule[] = []
  private colorMap: Record<string, Color> = {}
  private customColorMap: Record<string, Color | typeof DEFAULT_COLOR_CONFIG_VALUE> = {}
  private themeSemanticTokenColors: Record<string, SemanticTokenColorValue> = {}
  private customSemanticTokenColors: Record<string, SemanticTokenColorValue> = {}
  private themeSemanticHighlighting = false
  private customSemanticHighlighting: boolean | undefined

  private textMateThemingRules: ITokenColorRule[] | undefined
  private tokenColorIndex: Map<string, number> | undefined

  private constructor(id: string, label: string, settingsId: string, type: ColorScheme) {
    this.id = id
    this.label = label
    this.settingsId = settingsId
    this._type = type
  }

  get type(): ColorScheme {
    return this._type
  }

  get semanticHighlighting(): boolean {
    return this.customSemanticHighlighting ?? this.themeSemanticHighlighting
  }

  get semanticTokenColors(): Readonly<Record<string, SemanticTokenColorValue>> {
    return { ...this.themeSemanticTokenColors, ...this.customSemanticTokenColors }
  }

  /**
   * 最终 TextMate 规则表（VSCode `tokenColors` getter）：首条是无 scope 的默认
   * 规则（取 editor 前景/背景色），随后主题规则 + 用户定制规则（后者覆盖优先），
   * 未定义 token.info-token 时补默认的 info/warn/error/debug 四色。
   */
  get tokenColors(): ITokenColorRule[] {
    if (!this.textMateThemingRules) {
      const result: ITokenColorRule[] = []

      const foreground = this.getColor('editor.foreground')
      const background = this.getColor('editor.background')
      const defaultSettings: ITokenColorSettings = {}
      if (foreground) {
        defaultSettings.foreground = normalizeColor(foreground)
      }
      if (background) {
        defaultSettings.background = normalizeColor(background)
      }
      result.push({ settings: defaultSettings })

      let hasDefaultTokens = false
      const addRule = (rule: ITokenColorRule) => {
        if (rule.scope && rule.settings) {
          if (rule.scope === 'token.info-token') {
            hasDefaultTokens = true
          }
          const settings = rule.settings
          const newSettings: ITokenColorSettings = {}
          const ruleForeground = normalizeColor(settings.foreground)
          if (ruleForeground !== undefined) {
            newSettings.foreground = ruleForeground
          }
          const ruleBackground = normalizeColor(settings.background)
          if (ruleBackground !== undefined) {
            newSettings.background = ruleBackground
          }
          if (settings.fontStyle !== undefined) {
            newSettings.fontStyle = settings.fontStyle
          }
          result.push({ scope: rule.scope, settings: newSettings })
        }
      }

      this.themeTokenColors.forEach(addRule)
      // custom colors come after the theme colors so that they override them
      this.customTokenColors.forEach(addRule)

      if (!hasDefaultTokens) {
        const defaults =
          this._type === ColorScheme.LIGHT
            ? DEFAULT_TOKEN_COLORS[ColorScheme.LIGHT]!
            : DEFAULT_TOKEN_COLORS[ColorScheme.DARK]!
        defaults.forEach(addRule)
      }
      this.textMateThemingRules = result
    }
    return this.textMateThemingRules
  }

  getColor(colorId: ColorIdentifier, useDefault?: boolean): Color | undefined {
    const customColor = this.customColorMap[colorId]
    if (customColor instanceof Color) {
      return customColor
    }
    if (customColor === undefined) {
      const color = this.colorMap[colorId]
      if (color !== undefined) {
        return color
      }
    }
    if (useDefault !== false) {
      return this.getDefault(colorId)
    }
    return undefined
  }

  defines(colorId: ColorIdentifier): boolean {
    const customColor = this.customColorMap[colorId]
    if (customColor instanceof Color) {
      return true
    }
    if (customColor === undefined) {
      return this.colorMap[colorId] !== undefined
    }
    return false
  }

  private getDefault(colorId: ColorIdentifier): Color | undefined {
    return getColorRegistry().resolveDefaultColor(colorId, this)
  }

  get tokenColorMap(): string[] {
    if (!this.tokenColorIndex) {
      this.tokenColorIndex = new Map()
      for (const rule of this.tokenColors) {
        if (rule.settings.foreground) {
          this.getTokenColorIndexId(rule.settings.foreground)
        }
        if (rule.settings.background) {
          this.getTokenColorIndexId(rule.settings.background)
        }
      }
    }
    // Index 0 is the ColorId.None slot and must never hold a real color:
    // vscode-textmate's frozen ColorMap treats id 0 as "missing". The empty
    // string is an invalid color no rule can reference. (VSCode TokenColorIndex
    // likewise starts assigning at 1.)
    return ['', ...this.tokenColorIndex.keys()]
  }

  getTokenColorIndexId(color: string): number {
    if (!this.tokenColorIndex) {
      this.tokenColorIndex = new Map()
    }
    const normalized = color.toUpperCase()
    let index = this.tokenColorIndex.get(normalized)
    if (index === undefined) {
      index = this.tokenColorIndex.size + 1
      this.tokenColorIndex.set(normalized, index)
    }
    return index
  }

  getTokenStyleMetadata(
    _type: string,
    _modifiers: string[],
    _modelLanguage: string,
  ): ITokenStyle | undefined {
    // Phase 6: semantic token selector scoring lands here.
    return undefined
  }

  // ------------------------------------------------------------------ loading

  async ensureLoaded(readText: (uri: URI) => Promise<string>): Promise<void> {
    if (!this.isLoaded) {
      await this.reload(readText)
    }
  }

  async reload(readText: (uri: URI) => Promise<string>): Promise<void> {
    if (!this.location) {
      return
    }
    const visited: URI[] = []
    const doc = await loadThemeDocument(readText, this.location, new Set(), visited)
    this.loadedFiles = visited
    this.isLoaded = true
    this.colorMap = {}
    for (const [colorId, colorValue] of Object.entries(doc.colors)) {
      this.colorMap[colorId] = Color.fromHex(colorValue)
    }
    this.themeTokenColors = doc.tokenColors
    this.themeSemanticTokenColors = doc.semanticTokenColors
    this.themeSemanticHighlighting = doc.semanticHighlighting
    this.clearCaches()
  }

  static fromExtensionTheme(
    contribution: IThemeContribution,
    location: URI,
    extensionData: IThemeExtensionData,
  ): ColorThemeData {
    const baseTheme = contribution.uiTheme ?? ThemeTypeSelector.VS_DARK
    const themeSelector = toCSSSelector(extensionData.extensionId, contribution.path)
    const id = `${baseTheme} ${themeSelector}`
    const label = contribution.label ?? basenameOf(contribution.path)
    const settingsId = contribution.id ?? label
    const theme = new ColorThemeData(id, label, settingsId, colorSchemeFromTypeSelector(baseTheme))
    if (contribution.description !== undefined) {
      theme.description = contribution.description
    }
    theme.watch = contribution._watch === true
    theme.location = location
    theme.extensionData = extensionData
    return theme
  }

  static createUnloadedTheme(
    label: string,
    type: ColorScheme = ColorScheme.DARK,
    colorMap: Record<string, string> = {},
  ): ColorThemeData {
    const theme = new ColorThemeData(`unloaded ${label}`, label, label, type)
    for (const [colorId, colorValue] of Object.entries(colorMap)) {
      theme.colorMap[colorId] = Color.fromHex(colorValue)
    }
    theme.isLoaded = true
    return theme
  }

  // ------------------------------------------------------------------ customizations

  setCustomColors(colors: Record<string, string>): void {
    this.customColorMap = {}
    for (const [colorId, colorValue] of Object.entries(colors)) {
      if (colorValue === DEFAULT_COLOR_CONFIG_VALUE) {
        this.customColorMap[colorId] = DEFAULT_COLOR_CONFIG_VALUE
      } else if (typeof colorValue === 'string') {
        this.customColorMap[colorId] = Color.fromHex(colorValue)
      }
    }
    this.clearCaches()
  }

  setCustomTokenColors(rules: ITokenColorRule[]): void {
    this.customTokenColors = rules
    this.clearCaches()
  }

  setCustomSemanticTokenColors(colors: Record<string, SemanticTokenColorValue>): void {
    this.customSemanticTokenColors = colors
    this.clearCaches()
  }

  setCustomSemanticHighlighting(enabled: boolean | undefined): void {
    this.customSemanticHighlighting = enabled
  }

  private clearCaches(): void {
    this.textMateThemingRules = undefined
    this.tokenColorIndex = undefined
  }

  // ------------------------------------------------------------------ storage snapshot

  toStorageSnapshot(): ISerializedColorThemeData {
    const colorMap: Record<string, string> = {}
    for (const [colorId, color] of Object.entries(this.colorMap)) {
      colorMap[colorId] = Color.Format.CSS.formatHexA(color, true)
    }
    return {
      id: this.id,
      label: this.label,
      settingsId: this.settingsId,
      type: this._type,
      colorMap,
      tokenColors: this.themeTokenColors,
      semanticTokenColors: this.themeSemanticTokenColors,
      semanticHighlighting: this.themeSemanticHighlighting,
    }
  }

  static fromStorageSnapshot(data: ISerializedColorThemeData): ColorThemeData | undefined {
    if (!data || typeof data.id !== 'string' || typeof data.settingsId !== 'string') {
      return undefined
    }
    const theme = new ColorThemeData(
      data.id,
      typeof data.label === 'string' ? data.label : data.settingsId,
      data.settingsId,
      data.type ?? ColorScheme.DARK,
    )
    for (const [colorId, colorValue] of Object.entries(data.colorMap ?? {})) {
      theme.colorMap[colorId] = Color.fromHex(colorValue)
    }
    theme.themeTokenColors = Array.isArray(data.tokenColors) ? data.tokenColors : []
    theme.themeSemanticTokenColors = data.semanticTokenColors ?? {}
    theme.themeSemanticHighlighting = data.semanticHighlighting === true
    theme.isLoaded = true
    return theme
  }
}

export function toCSSSelector(extensionId: string, path: string): string {
  let str = path
  if (str.startsWith('./')) {
    str = str.substr(2)
  }
  str = `${extensionId}-${str}`
  // remove all characters that are not allowed in css
  str = str.replace(/[^_a-zA-Z0-9-]/g, '-')
  if (str.charAt(0).match(/[0-9-]/)) {
    str = '_' + str
  }
  return str
}

function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  const name = slash === -1 ? normalized : normalized.slice(slash + 1)
  return name.endsWith('.json') ? name.slice(0, -'.json'.length) : name
}

/** 归一化为大写 #RRGGBB / #RRGGBBAA 形式（对齐 VSCode `normalizeColor`）。
 *  大写是硬约定：vscode-textmate 的 frozen ColorMap 按 toUpperCase 查找。 */
export function normalizeColor(color: Color): string
export function normalizeColor(color: Color | string | undefined | null): string | undefined
export function normalizeColor(color: Color | string | undefined | null): string | undefined {
  if (!color) {
    return undefined
  }
  const parsed = typeof color === 'string' ? Color.Format.CSS.parse(color) : color
  if (!parsed) {
    return undefined
  }
  return Color.Format.CSS.formatHexA(parsed, true).toUpperCase()
}
