/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Contract guard for the generated built-in theme JSONs:
 * every `colors` value in `extensions/theme-defaults/themes/universe-*.json`
 * must be a hex literal.
 *
 * Theme documents are materialized through `Color.fromHex`-style parsing
 * (hex only); anything else (notably `rgba(...)`, which the source-of-truth
 * slots in universeColorIds.ts legitimately use) must be converted by
 * `scripts/emit-theme-defaults.mjs` at generation time. A non-hex value here
 * used to collapse to solid red (#ff0000) across the whole workbench.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
)
const themesDir = join(repoRoot, 'extensions', 'theme-defaults', 'themes')

const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

describe('built-in theme json contract', () => {
  for (const file of ['universe-dark.json', 'universe-light.json']) {
    it(`${file} colors are all hex literals`, () => {
      const doc = JSON.parse(readFileSync(join(themesDir, file), 'utf8')) as {
        colors: Record<string, string>
      }
      const invalid: string[] = []
      for (const [colorId, value] of Object.entries(doc.colors)) {
        if (!HEX_COLOR_PATTERN.test(value)) {
          invalid.push(`${file}: ${colorId} = ${value}`)
        }
      }
      expect(invalid).toEqual([])
    })
  }
})
