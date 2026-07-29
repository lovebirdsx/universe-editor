/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Dev helper: emit the full `--vscode-*` variable blocks (dark / light) derived
 * from `universeColorIds.ts`. Used to keep workbench.css's static `:root` blocks
 * in sync with the registry until WorkbenchThemeService takes over (Phase 3),
 * and as the data source for the built-in theme JSON files.
 *
 * Usage: node scripts/emit-theme-blocks.mjs [--json]
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const colorIdsFile = join(here, '..', 'src', 'renderer', 'services', 'themes', 'universeColorIds.ts')
const source = readFileSync(colorIdsFile, 'utf8')

const callSites = [...source.matchAll(/\bd\(/g)].map((m) => m.index)
// Anchor the end of the last entry on the array's closing `]` at line start —
// a plain indexOf(']') would stop at the `UniverseColorDefinition[]` type bracket.
callSites.push(source.indexOf('\n]', source.indexOf('UNIVERSE_COLOR_DEFINITIONS')))
const defs = []
for (let i = 0; i < callSites.length - 1; i++) {
  const block = source.slice(callSites[i], callSites[i + 1])
  const strings = [...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1])
  if (strings.length >= 4) {
    defs.push({ id: strings[0], dark: strings[1], light: strings[2] })
  }
}

const toName = (id) => `--vscode-${id.replace(/\./g, '-')}`
const isColor = (v) => v !== undefined && v !== 'null'
// Registry ColorValue references (e.g. 'editor.mutedForeground') must become
// var() references in CSS; literals (#hex, rgb(a)) pass through.
const toCssValue = (v) => (v.startsWith('#') || v.includes('(') ? v : `var(${toName(v)})`)

if (process.argv.includes('--json')) {
  const out = {}
  for (const def of defs) {
    out[def.id] = { dark: def.dark, light: def.light }
  }
  console.log(JSON.stringify(out, null, 2))
} else {
  const dark = defs.filter((d) => isColor(d.dark)).map((d) => `  ${toName(d.id)}: ${toCssValue(d.dark)};`)
  const light = defs.filter((d) => isColor(d.light)).map((d) => `  ${toName(d.id)}: ${toCssValue(d.light)};`)
  console.log(`:root { /* ${dark.length} variables */`)
  console.log(dark.join('\n'))
  console.log('}')
  console.log(`\n:root[data-theme='light'] { /* ${light.length} variables */`)
  console.log(light.join('\n'))
  console.log('}')
}
