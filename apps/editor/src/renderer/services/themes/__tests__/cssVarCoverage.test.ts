/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Guards the `--vscode-*` CSS variable system against drift:
 *
 * 1. Every `var(--vscode-X)` referenced from any renderer css/ts/tsx file must
 *    resolve to a color id registered in `universeColorIds.ts` (typo guard).
 * 2. No legacy `--color-*` / `--workbench-menu-*` / `--git-blame-decoration-fg`
 *    occurrences may survive the codemod — in css OR in inline ts/tsx style
 *    strings (e.g. an svg `stroke="var(--color-...)"`).
 * 3. No css file may DEFINE `--vscode-*` variables statically: colors come from
 *    the contributed theme at runtime (`style.contributedColorTheme`), and a
 *    static definition would out-specify the injected `:root` block and shadow
 *    every theme switch / color customization.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LEGACY_CSS_VARIABLE_IDS, UNIVERSE_COLOR_DEFINITIONS } from '../universeColorIds.js'

const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      yield* walk(path)
    } else if (name.endsWith('.css')) {
      yield path
    }
  }
}

// Style references also live inline in ts/tsx (svg stroke/fill, style props,
// const color = 'var(--vscode-...)'). Scan those too for unknown / legacy vars,
// but skip the __tests__ fixtures that legitimately mention the patterns.
function* walkTs(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__') continue
      yield* walkTs(path)
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      yield path
    }
  }
}

const commentPattern = /\/\*[\s\S]*?\*\//g
const lineCommentPattern = /(^|[^:])\/\/[^\n]*/g
function maskComments(text: string): string {
  return text
    .replace(commentPattern, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(lineCommentPattern, (m, prefix: string) => `${prefix} `)
}

function toCssVariableName(colorId: string): string {
  return `--vscode-${colorId.replace(/\./g, '-')}`
}

const registeredVariableNames = new Set(
  UNIVERSE_COLOR_DEFINITIONS.map((def) => toCssVariableName(def.id)),
)

const cssFiles = [...walk(rendererRoot)]
const maskedContents = cssFiles.map((file) => ({
  file,
  text: maskComments(readFileSync(file, 'utf8')),
}))

// ts/tsx inline references: same unknown/legacy checks, but only inside
// `var(--...)` calls (a plain `--color-x` substring in ts could be a test id or
// unrelated token, so we require the var() wrapper there).
const tsFiles = [...walkTs(rendererRoot)]
const tsContents = tsFiles.map((file) => ({
  file,
  text: maskComments(readFileSync(file, 'utf8')),
}))

describe('css variable coverage', () => {
  it('found renderer css files to scan', () => {
    expect(cssFiles.length).toBeGreaterThan(40)
  })

  it('every var(--vscode-X) reference resolves to a registered color id', () => {
    const unknown: string[] = []
    const referencePattern = /var\(\s*(--vscode-[A-Za-z0-9-]+)/g
    for (const { file, text } of [...maskedContents, ...tsContents]) {
      for (const match of text.matchAll(referencePattern)) {
        if (!registeredVariableNames.has(match[1]!)) {
          unknown.push(`${file}: ${match[1]}`)
        }
      }
    }
    expect(unknown).toEqual([])
  })

  it('no legacy --color-* / --workbench-menu-* / --git-blame-decoration-fg remains', () => {
    // css: any legacy token occurrence is a leftover. ts/tsx: only flag it when
    // consumed as a CSS variable via var(...), to avoid matching unrelated
    // identifiers that merely share the prefix.
    const cssLegacyPattern =
      /--(color-[a-z0-9-]+|workbench-menu-[a-z-]+|git-blame-decoration-fg)(?![\w-])/
    const tsLegacyPattern =
      /var\(\s*--(color-[a-z0-9-]+|workbench-menu-[a-z-]+|git-blame-decoration-fg)(?![\w-])/
    const leftovers: string[] = []
    for (const { file, text } of maskedContents) {
      if (cssLegacyPattern.test(text)) {
        leftovers.push(file)
      }
    }
    for (const { file, text } of tsContents) {
      if (tsLegacyPattern.test(text)) {
        leftovers.push(file)
      }
    }
    expect(leftovers).toEqual([])
  })

  it('no css file defines --vscode-* variables on global selectors', () => {
    // Colors come from the contributed theme at runtime (style.contributedColorTheme
    // on :root). A static definition on :root/html/body would out-specify the
    // injected block and shadow every theme switch / color customization.
    // Scoped overrides on component selectors (e.g. making an embedded Monaco
    // transparent inside .promptEditorInner) remain a legitimate technique.
    const rulePattern = /(^|\})\s*([^{}@][^{}]*)\{([^{}]*)\}/g
    const globalSelector = /^(:root\b|html\b|body\b)/i
    const violations: string[] = []
    for (const { file, text } of maskedContents) {
      for (const match of text.matchAll(rulePattern)) {
        const selector = match[2]!.trim()
        const body = match[3]!
        if (!globalSelector.test(selector)) {
          continue
        }
        for (const def of body.matchAll(/(--vscode-[A-Za-z0-9-]+)\s*:/g)) {
          violations.push(`${file}: ${selector} defines ${def[1]}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('legacy mapping covers every pre-migration variable name', () => {
    // The codemod required a complete mapping; keep it complete so re-runs and
    // external branches hit a descriptive error instead of silently skipping.
    expect(LEGACY_CSS_VARIABLE_IDS.size).toBeGreaterThan(100)
    for (const [legacy, id] of LEGACY_CSS_VARIABLE_IDS) {
      expect(registeredVariableNames.has(toCssVariableName(id)), `${legacy} -> ${id}`).toBe(true)
    }
  })
})
