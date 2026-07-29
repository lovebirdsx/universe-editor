#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * One-shot codemod: rename legacy CSS variables (`--color-*`, `--workbench-menu-*`,
 * `--git-blame-decoration-fg`) to the theme-registry `--vscode-<colorId>` form.
 *
 * The mapping is derived from `src/renderer/services/themes/universeColorIds.ts`
 * (the single source of truth) — each `d('<id>', <dark>, <light>, <desc>, '<legacy>')`
 * entry with a 5th string argument contributes `<legacy>` → `<id>`.
 *
 * Usage:
 *   node scripts/codemod-css-vars.mjs [--dry]
 *
 * Exits non-zero if any legacy `--color-*`-style occurrence has no mapping, so the
 * mapping table can never silently drift from the CSS.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const rendererRoot = join(here, '..', 'src', 'renderer')
const colorIdsFile = join(rendererRoot, 'services', 'themes', 'universeColorIds.ts')
const dryRun = process.argv.includes('--dry')

// ---------------------------------------------------------------------------
// 1. Derive the mapping from universeColorIds.ts
// ---------------------------------------------------------------------------

const source = readFileSync(colorIdsFile, 'utf8')
const mapping = new Map() // legacy name (no --) -> color id

// Split the file at every `d(` call site instead of matching balanced parens —
// color values like rgba(...) would terminate a naive `\(([^)]*)\)` match early.
const callSites = [...source.matchAll(/\bd\(/g)].map((m) => m.index)
// Anchor the end of the last entry on the array's closing `]` at line start —
// a plain indexOf(']') would stop at the `UniverseColorDefinition[]` type bracket.
callSites.push(source.indexOf('\n]', source.indexOf('UNIVERSE_COLOR_DEFINITIONS')))
for (let i = 0; i < callSites.length - 1; i++) {
  const block = source.slice(callSites[i], callSites[i + 1])
  const strings = [...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1])
  // d('<id>', <dark>, <light>, <desc>, ...legacy) — every string from the 5th on
  // is a legacy variable name mapped to the id.
  if (strings.length >= 5) {
    const [id, ...rest] = strings
    for (const legacy of rest.slice(3)) {
      if (mapping.has(legacy)) {
        throw new Error(`duplicate legacy mapping: ${legacy}`)
      }
      mapping.set(legacy, id)
    }
  }
}

if (mapping.size === 0) {
  throw new Error('no legacy mappings derived — is universeColorIds.ts still in the d() form?')
}

function toCssVariableName(colorId) {
  return `--vscode-${colorId.replace(/\./g, '-')}`
}

// ---------------------------------------------------------------------------
// 2. Walk all css files under src/renderer
// ---------------------------------------------------------------------------

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      yield* walk(path)
    } else if (name.endsWith('.css')) {
      yield path
    }
  }
}

const legacyPattern = /--(color-[a-z0-9-]+|workbench-menu-[a-z-]+|git-blame-decoration-fg)(?![\w-])/g
const commentPattern = /\/\*[\s\S]*?\*\//g
const unmapped = []
let totalReplacements = 0
const changedFiles = []

// Mask /* */ comments with same-length placeholders (preserving newlines) so
// prose mentions like "the --color-scm-* tokens" are not rewritten.
function maskComments(text) {
  return text.replace(commentPattern, (comment) =>
    comment.replace(/[^\n]/g, ' '),
  )
}

for (const file of walk(rendererRoot)) {
  const before = readFileSync(file, 'utf8')
  const masked = maskComments(before)
  let count = 0
  const maskedAfter = masked.replace(legacyPattern, (whole, legacy) => {
    const id = mapping.get(legacy)
    if (id === undefined) {
      unmapped.push(`${relative(rendererRoot, file)}: ${whole}`)
      return whole
    }
    count++
    return toCssVariableName(id)
  })
  if (count > 0) {
    // Re-apply the same replacements to the original text: the masked and
    // original strings have identical offsets, so splice by match positions.
    let after = ''
    let cursor = 0
    masked.replaceAll(legacyPattern, (whole, legacy, offset) => {
      const id = mapping.get(legacy)
      if (id === undefined) {
        return whole
      }
      after += before.slice(cursor, offset) + toCssVariableName(id)
      cursor = offset + whole.length
      return whole
    })
    after += before.slice(cursor)
    totalReplacements += count
    changedFiles.push(`${relative(rendererRoot, file)} (${count})`)
    if (!dryRun) {
      writeFileSync(file, after)
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Report
// ---------------------------------------------------------------------------

console.log(`${dryRun ? '[dry] ' : ''}replaced ${totalReplacements} occurrences in ${changedFiles.length} files`)
for (const f of changedFiles) {
  console.log(`  ${f}`)
}

if (unmapped.length > 0) {
  console.error(`\nERROR: ${unmapped.length} legacy occurrences have no mapping:`)
  for (const u of unmapped) {
    console.error(`  ${u}`)
  }
  process.exit(1)
}
