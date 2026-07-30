/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/platform/theme/common/tokenClassificationRegistry.ts
 *--------------------------------------------------------------------------------------------*/

/**
 * Semantic-token 选择器解析与打分（VSCode tokenClassificationRegistry 的纯函数内核）。
 *
 * 选择器语法 `[type|*](.modifier)*(:language)?`：
 * - `parseClassifierString` 反向扫描拆出 type / modifiers / language；
 * - `parseTokenSelector` 产出打分闭包：语言不匹配 -1（匹配 +10）；type 经
 *   superType 层级匹配得分 100-level（通配 `*` 恒 0 分）；selector 的每个
 *   modifier 必须出现在 token modifiers 中否则 -1；最终加 modifiers.length*100。
 *   得分越高越特化；同分时后处理者胜（见 ColorThemeData.getSemanticTokenStyle）。
 * - `parseSemanticTokenStyle` 把 semanticTokenColors 的值解析成 TokenStyle
 *   （fontStyle 正则解析四布尔；显式布尔字段仅在 fontStyle 缺席时生效）。
 * - `resolveScopeToStyle` 是默认 rules 的 scopesToProbe 回退：把 TextMate scope
 *   链按「段前缀匹配 + (depth+1)*0x10000+len 打分」在 theme/custom tokenColors
 *   上逐属性取 max-score（移植 VSCode resolveScopes/nameMatcher）。
 */

import { Color } from '@universe-editor/platform'
import type { ISemanticTokenColorSettings, ITokenColorRule } from './colorThemeData.js'

export interface ITokenClassifier {
  readonly type: string
  readonly modifiers: string[]
  readonly language: string | undefined
}

const CHAR_LANGUAGE = ':'.charCodeAt(0)
const CHAR_MODIFIER = '.'.charCodeAt(0)

export function parseClassifierString(s: string, defaultLanguage?: string): ITokenClassifier {
  let k = s.length
  let language: string | undefined = defaultLanguage
  const modifiers: string[] = []

  for (let i = k - 1; i >= 0; i--) {
    const ch = s.charCodeAt(i)
    if (ch === CHAR_LANGUAGE || ch === CHAR_MODIFIER) {
      const segment = s.substring(i + 1, k)
      k = i
      if (ch === CHAR_LANGUAGE) {
        language = segment
      } else {
        modifiers.push(segment)
      }
    }
  }
  const type = s.substring(0, k)
  return { type, modifiers, language }
}

// ---------------------------------------------------------------------------
// Token types & hierarchy
// ---------------------------------------------------------------------------

/**
 * superType 边表（VSCode 默认注册表只声明了 member→method 一条）。层级用于
 * selector 打分：token type 沿 superType 链向上找 selector type，每上一层 -1 分。
 */
const SUPER_TYPES: Readonly<Record<string, string>> = {
  member: 'method',
}

const TOKEN_TYPE_WILDCARD = '*'

const typeHierarchyCache = new Map<string, string[]>()

function getTypeHierarchy(typeId: string): string[] {
  let hierarchy = typeHierarchyCache.get(typeId)
  if (!hierarchy) {
    hierarchy = [typeId]
    let superType = SUPER_TYPES[typeId]
    while (superType !== undefined) {
      hierarchy.push(superType)
      superType = SUPER_TYPES[superType]
    }
    typeHierarchyCache.set(typeId, hierarchy)
  }
  return hierarchy
}

export interface ITokenSelector {
  match(type: string, modifiers: string[], language: string): number
  readonly id: string
}

export function parseTokenSelector(selectorString: string, language?: string): ITokenSelector {
  const selector = parseClassifierString(selectorString, language)

  if (!selector.type) {
    return {
      match: () => -1,
      id: '$invalid',
    }
  }

  return {
    match: (type: string, modifiers: string[], tokenLanguage: string) => {
      let score = 0
      if (selector.language !== undefined) {
        if (selector.language !== tokenLanguage) {
          return -1
        }
        score += 10
      }
      if (selector.type !== TOKEN_TYPE_WILDCARD) {
        const hierarchy = getTypeHierarchy(type)
        const level = hierarchy.indexOf(selector.type)
        if (level === -1) {
          return -1
        }
        score += 100 - level
      }
      // all selector modifiers must be present
      for (const selectorModifier of selector.modifiers) {
        if (modifiers.indexOf(selectorModifier) === -1) {
          return -1
        }
      }
      return score + selector.modifiers.length * 100
    },
    id: `${[selector.type, ...selector.modifiers.sort()].join('.')}${
      selector.language !== undefined ? ':' + selector.language : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// TokenStyle
// ---------------------------------------------------------------------------

export interface ISemanticTokenStyle {
  readonly foreground: string | undefined
  readonly bold: boolean | undefined
  readonly underline: boolean | undefined
  readonly strikethrough: boolean | undefined
  readonly italic: boolean | undefined
}

const FONT_STYLE_EXPRESSION = /italic|bold|underline|strikethrough/g

/** 移植 VSCode TokenStyle.fromSettings：fontStyle 出席时覆盖全部显式布尔字段。 */
export function parseSemanticTokenStyle(
  settings: ISemanticTokenColorSettings,
): ISemanticTokenStyle {
  let { bold, italic, underline, strikethrough } = settings
  if (settings.fontStyle !== undefined) {
    bold = italic = underline = strikethrough = false
    let match
    FONT_STYLE_EXPRESSION.lastIndex = 0
    while ((match = FONT_STYLE_EXPRESSION.exec(settings.fontStyle))) {
      switch (match[0]) {
        case 'bold':
          bold = true
          break
        case 'italic':
          italic = true
          break
        case 'underline':
          underline = true
          break
        case 'strikethrough':
          strikethrough = true
          break
      }
    }
  }
  let foreground: string | undefined
  if (settings.foreground !== undefined) {
    const color = Color.Format.CSS.parse(settings.foreground)
    if (color) {
      foreground = Color.Format.CSS.formatHexA(color, true).toUpperCase()
    }
  }
  return { foreground, bold, underline, strikethrough, italic }
}

// ---------------------------------------------------------------------------
// scopesToProbe 默认 rules
// ---------------------------------------------------------------------------

export interface ISemanticTokenStyleDefaultRule {
  readonly selector: ITokenSelector
  readonly scopesToProbe: readonly string[]
}

/**
 * VSCode 内建默认 rules（tokenClassificationRegistry createDefaultTokenClassificationRegistry
 * 的 registerTokenStyleDefault 全量）。未命中 theme/custom 规则的属性沿这些
 * TextMate scope 链回退到 tokenColors 取色。
 */
export const SEMANTIC_TOKEN_DEFAULT_RULES: readonly ISemanticTokenStyleDefaultRule[] = [
  { selector: parseTokenSelector('variable.readonly'), scopesToProbe: ['variable.other.constant'] },
  {
    selector: parseTokenSelector('property.readonly'),
    scopesToProbe: ['variable.other.constant.property'],
  },
  { selector: parseTokenSelector('type.defaultLibrary'), scopesToProbe: ['support.type'] },
  { selector: parseTokenSelector('class.defaultLibrary'), scopesToProbe: ['support.class'] },
  { selector: parseTokenSelector('interface.defaultLibrary'), scopesToProbe: ['support.class'] },
  {
    selector: parseTokenSelector('variable.defaultLibrary'),
    scopesToProbe: ['support.variable', 'support.other.variable'],
  },
  {
    selector: parseTokenSelector('variable.defaultLibrary.readonly'),
    scopesToProbe: ['support.constant'],
  },
  {
    selector: parseTokenSelector('property.defaultLibrary'),
    scopesToProbe: ['support.variable.property'],
  },
  {
    selector: parseTokenSelector('property.defaultLibrary.readonly'),
    scopesToProbe: ['support.constant.property'],
  },
  { selector: parseTokenSelector('function.defaultLibrary'), scopesToProbe: ['support.function'] },
  { selector: parseTokenSelector('member.defaultLibrary'), scopesToProbe: ['support.function'] },
]

// ---------------------------------------------------------------------------
// TextMate scope → style（resolveScopes）
// ---------------------------------------------------------------------------

function scopesAreMatching(thisScopeName: string, scopeName: string): boolean {
  if (!thisScopeName) {
    return false
  }
  if (thisScopeName === scopeName) {
    return true
  }
  const len = scopeName.length
  return (
    thisScopeName.length > len &&
    thisScopeName.substring(0, len) === scopeName &&
    thisScopeName[len] === '.'
  )
}

/** 移植 nameMatcher：selector 的每个 identifier 都要在 probe 祖先链某条上前缀命中，得分为最深命中段。 */
function matchProbe(identifiers: string[], probe: readonly string[]): number {
  if (probe.length < identifiers.length) {
    return -1
  }
  let score: number | undefined
  const every = identifiers.every((identifier) => {
    for (let i = probe.length - 1; i >= 0; i--) {
      const scope = probe[i]
      if (scope !== undefined && scopesAreMatching(scope, identifier)) {
        score = (i + 1) * 0x10000 + identifier.length
        return true
      }
    }
    return false
  })
  return every && score !== undefined ? score : -1
}

/** 一条 tokenColor rule 的 scope 列表 → probe 打分（多 scope 取最大）。 */
function scoreRuleAgainstProbe(rule: ITokenColorRule, probe: readonly string[]): number {
  if (!rule.scope) {
    return -1
  }
  const scopes = Array.isArray(rule.scope)
    ? rule.scope
    : rule.scope
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
  let max = -1
  for (const scopeSelector of scopes) {
    // 不支持逗号外的复杂 selector 语法（-, |, 括号, R:/L:）；默认 rules 的
    // probe 只走普通层级 scope，escape `*` 前缀即可。
    const escaped = scopeSelector.startsWith('*')
      ? scopeSelector.substring(1).trim()
      : scopeSelector
    const identifiers = escaped.split(/\s+/).filter((s) => s.length > 0)
    if (identifiers.length === 0) {
      continue
    }
    max = Math.max(max, matchProbe(identifiers, probe))
  }
  return max
}

/**
 * 移植 VSCode ColorThemeData.resolveScopes：按序 probe 每条 scope 链，在 theme
 * rules（后 custom rules）上逐属性（foreground/fontStyle）取 max-score，首个
 * 产出任何属性的 probe 胜出。返回解析出的 style（foreground 归一化为大写 hex）。
 *
 * VSCode 的 probe 不是「scope 点分段」，而是逐截短的祖先链：
 * `variable.other.constant` → `['variable.other.constant', 'variable.other', 'variable']`
 * —— 规则 scope 任一前缀命中链上某段即算匹配（详见 nameMatcher 的打分循环）。
 */
function probeChain(probeScope: string): string[] {
  const chain: string[] = []
  let rest = probeScope
  while (rest.length > 0) {
    chain.push(rest)
    const dotIndex = rest.lastIndexOf('.')
    if (dotIndex === -1) {
      break
    }
    rest = rest.substring(0, dotIndex)
  }
  // nameMatcher 用 `(index+1)*0x10000` 给「更靠前的链段」更高分；把链反转成
  // 祖先在前（['variable', 'variable.other', 'variable.other.constant']），让
  // 更深的规则 scope（在更靠后的链段命中）自然拿到更高分。
  return chain.reverse()
}

export function resolveScopeToStyle(
  probes: readonly string[],
  themeTokenColors: readonly ITokenColorRule[],
  customTokenColors: readonly ITokenColorRule[],
): ISemanticTokenStyle | undefined {
  for (const probeScope of probes) {
    const probe = probeChain(probeScope)
    let foreground: string | undefined
    let fontStyle: string | undefined
    let foregroundScore = -1
    let fontStyleScore = -1

    const collect = (rules: readonly ITokenColorRule[]) => {
      for (const rule of rules) {
        const score = scoreRuleAgainstProbe(rule, probe)
        if (score < 0) {
          continue
        }
        if (score >= foregroundScore && rule.settings.foreground) {
          const parsed = Color.Format.CSS.parse(rule.settings.foreground)
          if (parsed) {
            foreground = Color.Format.CSS.formatHexA(parsed, true).toUpperCase()
            foregroundScore = score
          }
        }
        if (score >= fontStyleScore && typeof rule.settings.fontStyle === 'string') {
          fontStyle = rule.settings.fontStyle
          fontStyleScore = score
        }
      }
    }
    collect(themeTokenColors)
    collect(customTokenColors)

    if (foreground !== undefined || fontStyle !== undefined) {
      const settings: { foreground?: string; fontStyle?: string } = {}
      if (foreground !== undefined) {
        settings.foreground = foreground
      }
      if (fontStyle !== undefined) {
        settings.fontStyle = fontStyle
      }
      return parseSemanticTokenStyle(settings)
    }
  }
  return undefined
}
