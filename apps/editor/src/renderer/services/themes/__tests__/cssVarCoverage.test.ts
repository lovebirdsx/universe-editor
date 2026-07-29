/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Guards the `--vscode-*` CSS variable system against drift:
 *
 * 1. Every `var(--vscode-X)` referenced from any renderer css file must resolve
 *    to a color id registered in `universeColorIds.ts` (typo / stale-id guard).
 * 2. No legacy `--color-*` / `--workbench-menu-*` / `--git-blame-decoration-fg`
 *    occurrences may survive the codemod.
 * 3. The static `:root` blocks in `workbench.css` (the pre-Phase-3 fallback
 *    source) must stay in sync with the registry — regenerate them with
 *    `node scripts/emit-theme-blocks.mjs` after editing universeColorIds.
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

const commentPattern = /\/\*[\s\S]*?\*\//g
function maskComments(text: string): string {
  return text.replace(commentPattern, (comment) => comment.replace(/[^\n]/g, ' '))
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

describe('css variable coverage', () => {
  it('found renderer css files to scan', () => {
    expect(cssFiles.length).toBeGreaterThan(40)
  })

  it('every var(--vscode-X) reference resolves to a registered color id', () => {
    const unknown: string[] = []
    const referencePattern = /var\(\s*(--vscode-[A-Za-z0-9-]+)/g
    for (const { file, text } of maskedContents) {
      for (const match of text.matchAll(referencePattern)) {
        if (!registeredVariableNames.has(match[1]!)) {
          unknown.push(`${file}: ${match[1]}`)
        }
      }
    }
    expect(unknown).toEqual([])
  })

  it('no legacy --color-* / --workbench-menu-* / --git-blame-decoration-fg remains', () => {
    const legacyPattern =
      /--(color-[a-z0-9-]+|workbench-menu-[a-z-]+|git-blame-decoration-fg)(?![\w-])/
    const leftovers: string[] = []
    for (const { file, text } of maskedContents) {
      if (legacyPattern.test(text)) {
        leftovers.push(file)
      }
    }
    expect(leftovers).toEqual([])
  })

  it('workbench.css :root blocks define exactly the registered variables', () => {
    const workbenchCss = maskedContents.find(({ file }) => file.endsWith('workbench.css'))
    expect(workbenchCss).toBeDefined()
    const definitionPattern = /^\s*(--vscode-[A-Za-z0-9-]+)\s*:/gm
    const defined = new Set<string>()
    for (const match of workbenchCss!.text.matchAll(definitionPattern)) {
      defined.add(match[1]!)
    }
    const expected = new Set(
      UNIVERSE_COLOR_DEFINITIONS.filter((def) => def.dark !== null).map((def) =>
        toCssVariableName(def.id),
      ),
    )
    expect([...defined].filter((name) => !expected.has(name))).toEqual([])
    expect([...expected].filter((name) => !defined.has(name))).toEqual([])
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
