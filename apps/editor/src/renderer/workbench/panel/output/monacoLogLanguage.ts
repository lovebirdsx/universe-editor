/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the 'log' language in Monaco with a Monarch tokenizer that mirrors
 *  the token scopes from VSCode's extensions/log/syntaxes/log.tmLanguage.json,
 *  and defines output-dark / output-light themes with matching log-level colors.
 *--------------------------------------------------------------------------------------------*/

import type * as monaco from 'monaco-editor'
import {
  OUTPUT_LINE_HIGHLIGHT_DARK,
  OUTPUT_LINE_HIGHLIGHT_LIGHT,
} from '../../../services/configuration/fontDefaults.js'

export interface LineHighlightOverrides {
  background?: string
  border?: string
}

// Exported for unit tests (regex-only, no Monaco runtime required)
export const LOG_LEVEL_RULES: Array<[RegExp, string]> = [
  // error — highest priority
  [/\[(error|err|critical|fatal|alert|failure)\]/i, 'log.error'],
  // warning
  [/\[(warn(?:ing)?|ww)\]/i, 'log.warning'],
  // info
  [/\[(info(?:rmation)?|notice|ii)\]/i, 'log.info'],
  // debug
  [/\[(debug|dbug|dbg|de|d)\]/i, 'log.debug'],
  // trace / verbose
  [/\[(trace|verbose|verb|vrb|vb|v)\]/i, 'log.trace'],
  // ISO-8601 timestamp  (2024-05-21T10:30:00)
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'log.date'],
]

const logMonarch: monaco.languages.IMonarchLanguage = {
  tokenizer: {
    root: [
      ...LOG_LEVEL_RULES,
      // anything else — advance by one character without a token so the
      // tokenizer doesn't stall on unrecognised input
      [/./, ''],
    ],
  },
}

const LOG_COLORS_DARK = {
  trace: '6a9955',
  debug: '9cdcfe',
  info: '4ec994',
  warning: 'd7a751',
  error: 'f48771',
  date: '8a8a92',
}

const LOG_COLORS_LIGHT = {
  trace: '267f99',
  debug: '0070c1',
  info: '0b7a3e',
  warning: 'b8860b',
  error: 'a31515',
  date: '6a6a7a',
}

function buildRules(colors: typeof LOG_COLORS_DARK): monaco.editor.ITokenThemeRule[] {
  return [
    { token: 'log.error', foreground: colors.error, fontStyle: 'bold' },
    { token: 'log.warning', foreground: colors.warning },
    { token: 'log.info', foreground: colors.info },
    { token: 'log.debug', foreground: colors.debug },
    { token: 'log.trace', foreground: colors.trace },
    { token: 'log.date', foreground: colors.date },
  ]
}

const MD_TOKEN_RULES_DARK: monaco.editor.ITokenThemeRule[] = [
  { token: 'keyword.md', foreground: '569cd6', fontStyle: 'bold' },
  { token: 'strong.md', foreground: '569cd6', fontStyle: 'bold' },
  { token: 'strong.emphasis.md', foreground: '569cd6', fontStyle: 'bold italic' },
  { token: 'emphasis.md', foreground: 'c586c0', fontStyle: 'italic' },
  { token: 'variable.md', foreground: 'ce9178' },
  { token: 'variable.source.md', foreground: 'ce9178' },
  { token: 'comment.md', foreground: '6a9955' },
  { token: 'string.link.md', foreground: '4fc1ff' },
  // YAML frontmatter: keys as a type colour, values as a string colour.
  { token: 'type.md', foreground: '4ec9b0' },
  { token: 'operators.md', foreground: 'd4d4d4' },
]

const MD_TOKEN_RULES_LIGHT: monaco.editor.ITokenThemeRule[] = [
  { token: 'keyword.md', foreground: '0000ff', fontStyle: 'bold' },
  { token: 'strong.md', foreground: '0000ff', fontStyle: 'bold' },
  { token: 'strong.emphasis.md', foreground: '0000ff', fontStyle: 'bold italic' },
  { token: 'emphasis.md', foreground: 'af00db', fontStyle: 'italic' },
  { token: 'variable.md', foreground: 'a31515' },
  { token: 'variable.source.md', foreground: 'a31515' },
  { token: 'comment.md', foreground: '008000' },
  { token: 'string.link.md', foreground: '0070c1' },
  // YAML frontmatter: keys as a type colour, values as a string colour.
  { token: 'type.md', foreground: '267f99' },
  { token: 'operators.md', foreground: '000000' },
]

// Semantic-token colours (mirrors VSCode Dark+/Light+). Standalone Monaco matches
// a semantic token's `type.modifier` scope against these theme rules, so a plain
// token type maps by its bare name. The key fix: `property`/`parameter`/`variable`
// no longer inherit TextMate's "uppercase ⇒ type" guess — tsserver tells us what
// each identifier really is, so an uppercase interface field colours as a property.
const SEMANTIC_TOKEN_RULES_DARK: monaco.editor.ITokenThemeRule[] = [
  { token: 'class', foreground: '4ec9b0' },
  { token: 'interface', foreground: '4ec9b0' },
  { token: 'enum', foreground: '4ec9b0' },
  { token: 'type', foreground: '4ec9b0' },
  { token: 'typeParameter', foreground: '4ec9b0' },
  { token: 'namespace', foreground: '4ec9b0' },
  { token: 'property', foreground: '9cdcfe' },
  { token: 'member', foreground: '9cdcfe' },
  { token: 'parameter', foreground: '9cdcfe' },
  { token: 'variable', foreground: '9cdcfe' },
  { token: 'enumMember', foreground: '4fc1ff' },
  { token: 'function', foreground: 'dcdcaa' },
]

const SEMANTIC_TOKEN_RULES_LIGHT: monaco.editor.ITokenThemeRule[] = [
  { token: 'class', foreground: '267f99' },
  { token: 'interface', foreground: '267f99' },
  { token: 'enum', foreground: '267f99' },
  { token: 'type', foreground: '267f99' },
  { token: 'typeParameter', foreground: '267f99' },
  { token: 'namespace', foreground: '267f99' },
  { token: 'property', foreground: '001080' },
  { token: 'member', foreground: '001080' },
  { token: 'parameter', foreground: '001080' },
  { token: 'variable', foreground: '001080' },
  { token: 'enumMember', foreground: '0070c1' },
  { token: 'function', foreground: '795e26' },
]

function buildOutputThemeColors(
  variant: 'dark' | 'light',
  overrides?: LineHighlightOverrides,
): Record<string, string> {
  const base = variant === 'light' ? OUTPUT_LINE_HIGHLIGHT_LIGHT : OUTPUT_LINE_HIGHLIGHT_DARK
  const background =
    overrides?.background !== undefined && overrides.background.length > 0
      ? overrides.background
      : base.background
  const border =
    overrides?.border !== undefined && overrides.border.length > 0 ? overrides.border : base.border
  return {
    'editor.lineHighlightBackground': background,
    'editor.lineHighlightBorder': border,
  }
}

export function defineOutputThemes(m: typeof monaco, overrides?: LineHighlightOverrides): void {
  m.editor.defineTheme('output-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [...buildRules(LOG_COLORS_DARK), ...MD_TOKEN_RULES_DARK, ...SEMANTIC_TOKEN_RULES_DARK],
    colors: buildOutputThemeColors('dark', overrides),
  })

  m.editor.defineTheme('output-light', {
    base: 'vs',
    inherit: true,
    rules: [
      ...buildRules(LOG_COLORS_LIGHT),
      ...MD_TOKEN_RULES_LIGHT,
      ...SEMANTIC_TOKEN_RULES_LIGHT,
    ],
    colors: buildOutputThemeColors('light', overrides),
  })
}

export function registerLogLanguage(m: typeof monaco): void {
  m.languages.register({ id: 'log' })
  m.languages.setMonarchTokensProvider('log', logMonarch)

  defineOutputThemes(m)
}
