/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Dev helper: regenerate `extensions/theme-defaults/themes/universe-{dark,light}.json`
 * from `universeColorIds.ts` (the single source of truth for built-in colors).
 *
 * Theme-JSON `colors` values must be color literals (VSCode compatibility), so
 * registry id references (e.g. 'editor.mutedForeground') are resolved to the
 * referenced id's slot value. Ids whose slot is `null` (editor.lineHighlight*)
 * are omitted — the theme leaves them to the registry default.
 *
 * Usage: node scripts/emit-theme-defaults.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const colorIdsFile = join(here, '..', 'src', 'renderer', 'services', 'themes', 'universeColorIds.ts')
const source = readFileSync(colorIdsFile, 'utf8')

const callSites = [...source.matchAll(/\bd\(/g)].map((m) => m.index)
callSites.push(source.indexOf('\n]', source.indexOf('UNIVERSE_COLOR_DEFINITIONS')))
const defs = []
for (let i = 0; i < callSites.length - 1; i++) {
  const block = source.slice(callSites[i], callSites[i + 1])
  const strings = [...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1])
  if (strings.length >= 4) {
    defs.push({ id: strings[0], dark: strings[1], light: strings[2] })
  }
}

const isLiteral = (v) => v !== undefined && v !== 'null' && (v.startsWith('#') || v.includes('('))

// Theme documents are consumed by hex-only parsing downstream, so rgba()/rgb()
// slot values must be converted here — a non-hex literal used to collapse to
// solid red across the whole workbench.
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const RGBA_PATTERN = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+(?:\.\d+)?)\s*\)$/
const RGB_PATTERN = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/

function toHexLiteral(value, id, slot) {
  if (value.startsWith('#')) {
    if (!HEX_COLOR_PATTERN.test(value)) {
      throw new Error(`invalid color literal: ${id} (${slot}) = ${value}`)
    }
    return value
  }
  const rgba = RGBA_PATTERN.exec(value)
  const rgb = RGB_PATTERN.exec(value)
  const match = rgba ?? rgb
  if (!match) {
    throw new Error(`invalid color literal: ${id} (${slot}) = ${value}`)
  }
  const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const a = rgba ? parseFloat(rgba[4]) : 1
  if (r > 255 || g > 255 || b > 255 || a > 1) {
    throw new Error(`color component out of range: ${id} (${slot}) = ${value}`)
  }
  const hex = (n) => n.toString(16).padStart(2, '0')
  const base = `#${hex(r)}${hex(g)}${hex(b)}`
  // Math.round keeps parity with platform's Color.Format.CSS.formatHexA.
  return a === 1 ? base : `${base}${hex(Math.round(a * 255))}`
}

function resolveSlot(slot) {
  const byId = new Map(defs.map((d) => [d.id, slot === 'dark' ? d.dark : d.light]))
  const colors = {}
  for (const def of defs) {
    let value = byId.get(def.id)
    if (value === undefined || value === 'null') continue
    // One hop is enough in practice; loop defensively for chained references.
    const seen = new Set([def.id])
    while (!isLiteral(value)) {
      if (seen.has(value)) throw new Error(`circular color reference: ${def.id} -> ${value}`)
      seen.add(value)
      const next = byId.get(value)
      if (next === undefined || next === 'null') {
        throw new Error(`unresolved color reference: ${def.id} -> ${value}`)
      }
      value = next
    }
    colors[def.id] = toHexLiteral(value, def.id, slot)
  }
  return colors
}

const themesDir = join(here, '..', '..', '..', 'extensions', 'theme-defaults', 'themes')
const targets = [
  { file: 'universe-dark.json', name: 'Universe Dark', include: './dark_plus.json', slot: 'dark' },
  { file: 'universe-light.json', name: 'Universe Light', include: './light_plus.json', slot: 'light' },
]

for (const target of targets) {
  const doc = {
    $schema: 'vscode://schemas/color-theme',
    name: target.name,
    include: target.include,
    colors: resolveSlot(target.slot),
  }
  const out = join(themesDir, target.file)
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`)
  console.log(`${target.file}: ${Object.keys(doc.colors).length} colors`)
}
