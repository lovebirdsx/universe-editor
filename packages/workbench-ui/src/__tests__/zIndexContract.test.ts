// @vitest-environment node
/*---------------------------------------------------------------------------------------------
 *  Overlay z-index ordering contract. Many overlays are portalled to
 *  document.body while their trigger sits somewhere else entirely (the Select
 *  popover inside a fixed dialog, a menu over a toast), so their paint order is
 *  decided purely by these numbers — a relationship happy-dom cannot reproduce
 *  (it has no layout), hence the static assertions on the CSS sources.
 *
 *  The same reasoning covers the rest of the ladder: a layer's position is a
 *  fact about how the workbench stacks, not about the component that happens to
 *  sit in it.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const tokens = stripCssComments(readFileSync(join(srcRoot, 'theme', 'tokens.css'), 'utf8'))
const selectCss = readFileSync(join(srcRoot, 'atoms', 'Select.module.css'), 'utf8')
const anchoredSurfaceTsx = readFileSync(join(srcRoot, 'overlay', 'AnchoredSurface.tsx'), 'utf8')

// The highest z-index monaco puts on a node inside the editor's own DOM: glyph
// hover 11, parameter hints 39, suggest 40, hover 40/41, content hover 50, and
// the rename widget at 100. workbench-ui does not depend on monaco, so the
// ceiling lives here with its provenance rather than being imported. (monaco's
// inline message uses 10000 and therefore ties with `--z-tooltip`; DOM order
// settles that one, and nothing in this package should try to go above it.)
const MONACO_EDITOR_Z_INDEX_MAX = 100

// Bottom to top. Order is the whole point — see `theme/tokens.css`. The first two
// are a view covering itself, `--z-workbench-chrome` is the app frame a view may
// not cover, and everything from `--z-popover` up is workbench-wide.
const LADDER = [
  '--z-view-backdrop',
  '--z-view-overlay',
  '--z-workbench-chrome',
  '--z-popover',
  '--z-dialog',
  '--z-dropdown',
  '--z-toast-center',
  '--z-toast',
  '--z-menu',
  '--z-tooltip',
] as const

// Comments carry prose (`--z-menu: 9999` in a sentence, a literal spelled out in
// a doc block) and must never be read as definitions or as declarations.
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function readToken(name: string): number {
  const raw = tokens.match(new RegExp(`${name}:\\s*(\\d+)`))?.[1]
  if (raw === undefined) throw new Error(`missing ${name} in tokens.css`)
  return Number(raw)
}

function* walk(dir: string, extensions: readonly string[]): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') yield* walk(path, extensions)
    } else if (extensions.some((extension) => name.endsWith(extension))) {
      yield path
    }
  }
}

// Reads a declaration's whole value, so shapes that hide a literal from a plain
// `z-index: (\d+)` match still count: `Z-INDEX: 9999` (property names are
// case-insensitive), `calc(1400 - 1)` and a bare fallback. `var(…)` spans are
// removed first — `var(--z-tooltip, 10000)` is token-driven, the number is only
// what a test environment without tokens would fall back to.
function literalZIndexOffenders(value: string): string[] {
  const offenders: string[] = []
  for (const [digits] of value.replace(/var\([^()]*\)/g, '').matchAll(/\d+/g)) {
    if (Number(digits) >= 100) offenders.push(digits)
  }
  return offenders
}

function cssZIndexOffenders(css: string): string[] {
  const offenders: string[] = []
  for (const [, value] of stripCssComments(css).matchAll(/z-index\s*:\s*([^;{}]+)/gi)) {
    offenders.push(...literalZIndexOffenders(value!))
  }
  return offenders
}

function inlineZIndexOffenders(source: string): string[] {
  const offenders: string[] = []
  for (const [, value] of source.matchAll(/zIndex\s*:\s*([^,;}\n]+)/g)) {
    offenders.push(...literalZIndexOffenders(value!))
  }
  return offenders
}

function rel(path: string): string {
  return relative(srcRoot, path).split(sep).join('/')
}

describe('overlay z-index contract', () => {
  it('orders the ladder bottom-up', () => {
    for (let i = 1; i < LADDER.length; i++) {
      const lowerName = LADDER[i - 1]!
      const upperName = LADDER[i]!
      const lower = readToken(lowerName)
      const upper = readToken(upperName)
      expect(lower, `${lowerName} (${lower}) must stay below ${upperName} (${upper})`).toBeLessThan(
        upper,
      )
    }
  })

  it('keeps every layer above monaco widgets living inside the editor DOM', () => {
    for (const name of LADDER) {
      expect(
        readToken(name),
        `${name} must clear monaco's editor-internal widgets`,
      ).toBeGreaterThan(MONACO_EDITOR_Z_INDEX_MAX)
    }
  })

  it('uses --z-dropdown for the Select popover', () => {
    const block = stripCssComments(selectCss).match(/\.popover\s*\{([^}]*)\}/)
    expect(block?.[1]).toMatch(/z-index:\s*var\(--z-dropdown\)/)
  })

  it('uses --z-menu for anchored surfaces instead of a literal', () => {
    expect(anchoredSurfaceTsx).toMatch(/zIndex:\s*'var\(--z-menu\)'/)
  })

  it('routes every workbench-wide overlay in this package through a token', () => {
    const offenders: string[] = []
    for (const file of walk(srcRoot, ['.css'])) {
      for (const digits of cssZIndexOffenders(readFileSync(file, 'utf8'))) {
        offenders.push(`${rel(file)} → ${digits}`)
      }
    }
    // Local indices (tab strips, sash separators, nested submenus, …) stay
    // literal by design — see the token block's comment. Anything that could
    // cover more than its own container must not.
    expect(offenders, 'use a --z-* token instead of a literal').toEqual([])
  })

  it('keeps inline z-index in this package on tokens too', () => {
    const offenders: string[] = []
    for (const file of walk(srcRoot, ['.ts', '.tsx'])) {
      for (const digits of inlineZIndexOffenders(readFileSync(file, 'utf8'))) {
        offenders.push(`${rel(file)} → ${digits}`)
      }
    }
    expect(offenders, 'use a --z-* token instead of a numeric inline zIndex').toEqual([])
  })
})
