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
import {
  parseClassifierString,
  parseSemanticTokenStyle,
  parseTokenSelector,
  resolveScopeToStyle,
  SEMANTIC_TOKEN_DEFAULT_RULES,
  type ISemanticTokenStyle,
  type ITokenSelector,
} from './semanticSelector.js'

interface ISemanticTokenRule {
  readonly selector: ITokenSelector
  readonly style: ISemanticTokenStyle
}

/**
 * semanticTokenColors 记录 → 带打分闭包的规则表（对齐 VSCode readSemanticTokenRule）。
 * 值为 `false` 或不含任何已知属性的对象时不产规则——`false` 的 reset 语义发生在
 * JSON merge 层（overlay 的 false 顶掉 include 链/base 的同 key 值）。
 */
function buildSemanticTokenRules(
  colors: Record<string, SemanticTokenColorValue>,
): ISemanticTokenRule[] {
  const rules: ISemanticTokenRule[] = []
  for (const [selectorString, value] of Object.entries(colors)) {
    if (value === false) {
      continue
    }
    const settings: ISemanticTokenColorSettings =
      typeof value === 'string' ? { foreground: value } : value
    if (
      typeof settings.foreground !== 'string' &&
      typeof settings.fontStyle !== 'string' &&
      typeof settings.bold !== 'boolean' &&
      typeof settings.italic !== 'boolean' &&
      typeof settings.underline !== 'boolean' &&
      typeof settings.strikethrough !== 'boolean'
    ) {
      continue
    }
    const selector = parseTokenSelector(selectorString)
    if (selector.id === '$invalid') {
      continue
    }
    rules.push({ selector, style: parseSemanticTokenStyle(settings) })
  }
  return rules
}

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
      // 对齐 VSCode getTokenColorIndex：semantic 规则的前景色也进 colorMap，
      // 否则 getTokenStyleMetadata 返回的索引在 map 里查不到色值。
      for (const rule of this.getSemanticTokenRules()) {
        if (rule.style.foreground) {
          this.getTokenColorIndexId(rule.style.foreground)
        }
      }
      for (const rule of this.getCustomSemanticTokenRules()) {
        if (rule.style.foreground) {
          this.getTokenColorIndexId(rule.style.foreground)
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

  /**
   * Semantic-token 样式解析（移植 VSCode ColorThemeData.getTokenStyle）：
   * theme rules 后 custom rules 逐属性（foreground/bold/italic/underline/
   * strikethrough）取 max-score（同分后者胜）；未命中的属性钉到 MAX_VALUE 后
   * 跑 scopesToProbe 默认 rules（resolveScopeToStyle 回退到 tokenColors 取色）。
   * 返回的 foreground 是归一化大写 hex；需要 colorMap 索引时走 getTokenStyleMetadata。
   */
  getSemanticTokenStyle(
    type: string,
    modifiers: string[],
    language: string,
  ): ISemanticTokenStyle | undefined {
    const result: {
      foreground: string | undefined
      bold: boolean | undefined
      underline: boolean | undefined
      strikethrough: boolean | undefined
      italic: boolean | undefined
    } = {
      foreground: undefined,
      bold: undefined,
      underline: undefined,
      strikethrough: undefined,
      italic: undefined,
    }
    const score = {
      foreground: -1,
      bold: -1,
      underline: -1,
      strikethrough: -1,
      italic: -1,
    }

    const processStyle = (matchScore: number, style: ISemanticTokenStyle) => {
      if (style.foreground !== undefined && score.foreground <= matchScore) {
        score.foreground = matchScore
        result.foreground = style.foreground
      }
      for (const p of ['bold', 'underline', 'strikethrough', 'italic'] as const) {
        const value = style[p]
        if (value !== undefined && score[p] <= matchScore) {
          score[p] = matchScore
          result[p] = value
        }
      }
    }
    const processRule = (rule: ISemanticTokenRule) => {
      const matchScore = rule.selector.match(type, modifiers, language)
      if (matchScore >= 0) {
        processStyle(matchScore, rule.style)
      }
    }

    this.getSemanticTokenRules().forEach(processRule)
    this.getCustomSemanticTokenRules().forEach(processRule)

    let hasUndefinedStyleProperty = false
    for (const k of Object.keys(score) as Array<keyof typeof score>) {
      if (score[k] === -1) {
        hasUndefinedStyleProperty = true
      } else {
        // 已被 theme/custom 规则覆盖的属性不再被默认 rules 顶掉
        score[k] = Number.MAX_VALUE
      }
    }
    if (hasUndefinedStyleProperty) {
      for (const rule of SEMANTIC_TOKEN_DEFAULT_RULES) {
        const matchScore = rule.selector.match(type, modifiers, language)
        if (matchScore >= 0) {
          const style = resolveScopeToStyle(
            rule.scopesToProbe,
            this.themeTokenColors,
            this.customTokenColors,
          )
          if (style) {
            processStyle(matchScore, style)
          }
        }
      }
    }

    if (
      result.foreground === undefined &&
      result.bold === undefined &&
      result.underline === undefined &&
      result.strikethrough === undefined &&
      result.italic === undefined
    ) {
      return undefined
    }
    return result
  }

  /**
   * 语义规则缓存（theme/custom 分开；`false` 值在 theme 块尾展开为空规则，
   * 语义 reset——对齐 VSCode 对 semanticTokenColors false 的处理）。
   */
  private semanticTokenRules: ISemanticTokenRule[] | undefined
  private customSemanticTokenRules: ISemanticTokenRule[] | undefined

  private getSemanticTokenRules(): ISemanticTokenRule[] {
    if (!this.semanticTokenRules) {
      this.semanticTokenRules = buildSemanticTokenRules(this.themeSemanticTokenColors)
    }
    return this.semanticTokenRules
  }

  private getCustomSemanticTokenRules(): ISemanticTokenRule[] {
    if (!this.customSemanticTokenRules) {
      this.customSemanticTokenRules = buildSemanticTokenRules(this.customSemanticTokenColors)
    }
    return this.customSemanticTokenRules
  }

  getTokenStyleMetadata(
    type: string,
    modifiers: string[],
    modelLanguage: string,
  ): ITokenStyle | undefined {
    const classifier = parseClassifierString(type, modelLanguage)
    const style = this.getSemanticTokenStyle(
      classifier.type,
      modifiers,
      classifier.language ?? modelLanguage,
    )
    if (!style) {
      return undefined
    }
    return {
      foreground:
        style.foreground !== undefined ? this.getTokenColorIndexId(style.foreground) : undefined,
      bold: style.bold,
      underline: style.underline,
      strikethrough: style.strikethrough,
      italic: style.italic,
    }
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
      const parsed = parseThemeColor(colorValue, `${this.label} / ${colorId}`)
      if (parsed) {
        this.colorMap[colorId] = parsed
      }
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
      const parsed = parseThemeColor(colorValue, `${label} / ${colorId}`)
      if (parsed) {
        theme.colorMap[colorId] = parsed
      }
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
        const parsed = parseThemeColor(colorValue, `colorCustomizations / ${colorId}`)
        if (parsed) {
          this.customColorMap[colorId] = parsed
        }
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
    this.semanticTokenRules = undefined
    this.customSemanticTokenRules = undefined
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
      const parsed = parseThemeColor(colorValue, `snapshot ${data.settingsId} / ${colorId}`)
      if (parsed) {
        theme.colorMap[colorId] = parsed
      }
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
  const parsed = typeof color === 'string' ? parseCssColorLenient(color) : color
  if (!parsed) {
    return undefined
  }
  return Color.Format.CSS.formatHexA(parsed, true).toUpperCase()
}

/** `CSS.parse` 对畸形 rgba()/hsla() 会 throw；这里统一吞掉按解析失败处理。 */
function parseCssColorLenient(value: string): Color | null {
  try {
    return Color.Format.CSS.parse(value)
  } catch {
    return null
  }
}

/** 宽容解析主题颜色值：非法值跳过（返回 undefined）并告警，调用方落回注册表默认。
 *  VSCode 此处用 `Color.fromHex`——非法值静默回退 `Color.red`，整片 UI 被染成纯红
 *  而无任何线索；跳过缺色比静默纯红更易排查。 */
function parseThemeColor(colorValue: string, context: string): Color | undefined {
  const parsed = parseCssColorLenient(colorValue)
  if (!parsed) {
    console.warn(`[ColorThemeData] skipped invalid color value "${colorValue}" (${context})`)
    return undefined
  }
  return parsed
}
