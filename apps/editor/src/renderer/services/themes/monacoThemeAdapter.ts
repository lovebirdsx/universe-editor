/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ColorThemeData → Monaco `IStandaloneThemeData` 的转换（纯函数）。
 *
 * - `base` 由主题 ColorScheme 推导；
 * - `rules` 由 tokenColors 转换（首条无 scope 默认规则 → `token: ''`；多 scope 拆多条；
 *   foreground/background 去 `#`；fontStyle 直通）；
 * - `colors` 收集所有 `editor*` / `diffEditor*` 命名空间的已注册颜色（这些 id 与
 *   Monaco 内部颜色 key 同名），外加 lineHighlight 配置覆盖（原 ThemeContribution
 *   的 `editor.lineHighlight*` 行为）。
 */

import { ColorScheme, getColorRegistry } from '@universe-editor/platform'
import type { ColorThemeData, ITokenColorRule } from './colorThemeData.js'

export interface IMonacoTokenThemeRule {
  token: string
  foreground?: string
  background?: string
  fontStyle?: string
}

export interface IStandaloneThemeDataLike {
  base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'
  inherit: boolean
  rules: IMonacoTokenThemeRule[]
  encodedTokensColors?: string[]
  colors: Record<string, string>
}

export interface IMonacoThemeOverrides {
  lineHighlightBackground?: string
  lineHighlightBorder?: string
}

export function toMonacoThemeName(settingsId: string): string {
  return `universe-${settingsId.replace(/[^a-zA-Z0-9-]/g, '-')}`
}

export function toMonacoBase(scheme: ColorScheme): IStandaloneThemeDataLike['base'] {
  switch (scheme) {
    case ColorScheme.LIGHT:
      return 'vs'
    case ColorScheme.HIGH_CONTRAST_DARK:
      return 'hc-black'
    case ColorScheme.HIGH_CONTRAST_LIGHT:
      return 'hc-light'
    default:
      return 'vs-dark'
  }
}

function stripHash(hex: string): string {
  return hex.startsWith('#') ? hex.slice(1) : hex
}

export function tokenColorRulesToMonacoRules(
  rules: readonly ITokenColorRule[],
): IMonacoTokenThemeRule[] {
  const result: IMonacoTokenThemeRule[] = []
  for (const rule of rules) {
    const scopes =
      rule.scope === undefined
        ? ['']
        : Array.isArray(rule.scope)
          ? rule.scope
          : rule.scope
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
    for (const scope of scopes) {
      const monacoRule: IMonacoTokenThemeRule = { token: scope }
      if (rule.settings.foreground) {
        monacoRule.foreground = stripHash(rule.settings.foreground)
      }
      if (rule.settings.background) {
        monacoRule.background = stripHash(rule.settings.background)
      }
      if (rule.settings.fontStyle) {
        monacoRule.fontStyle = rule.settings.fontStyle
      }
      result.push(monacoRule)
    }
  }
  return result
}

export function toStandaloneThemeData(
  theme: ColorThemeData,
  overrides: IMonacoThemeOverrides = {},
): { name: string; data: IStandaloneThemeDataLike } {
  const colors: Record<string, string> = {}

  for (const item of getColorRegistry().getColors()) {
    if (!item.id.startsWith('editor') && !item.id.startsWith('diffEditor')) {
      continue
    }
    const color = theme.getColor(item.id, true)
    if (color) {
      // Color.toString() yields #rrggbb for opaque colors and rgba(...)
      // otherwise; Monaco theme colors accept both forms.
      colors[item.id] = color.toString()
    }
  }

  if (overrides.lineHighlightBackground) {
    colors['editor.lineHighlightBackground'] = overrides.lineHighlightBackground
  }
  if (overrides.lineHighlightBorder) {
    colors['editor.lineHighlightBorder'] = overrides.lineHighlightBorder
  }

  return {
    name: toMonacoThemeName(theme.settingsId),
    data: {
      base: toMonacoBase(theme.type),
      inherit: true,
      rules: tokenColorRulesToMonacoRules(theme.tokenColors),
      colors,
    },
  }
}
