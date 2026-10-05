/**
 * Structural guard for the git graph row fill.
 *
 * `.graphSvg` is a positioned sibling *before* `.rows` (both `z-index: auto`),
 * so it paints under the rows: a full-width row background covers that row's
 * lane lines and node dot. The fix is that the hover/selection fill only starts
 * at `--graph-width`, which is expressible in exactly one way — a `background`
 * shorthand or `background-color` on any row state silently brings the
 * occlusion back (the shorthand also resets `background-image` depending on
 * declaration order, which is why both shapes are banned here and not just the
 * colour property).
 *
 * Read as text rather than asserted in a browser: happy-dom does not lay out
 * `var()` gradients, and the invariant is "which property carries the colour",
 * not a computed value. The Perforce graph reuses this same stylesheet, so the
 * guard covers both views.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../GitGraphEditor.module.css', import.meta.url), 'utf8')

// Comments stripped first: the file's own comments sit right next to (and
// explain) these declarations, so matching them would let a renamed property
// pass on the strength of its prose.
const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')

interface Declaration {
  property: string
  value: string
}

interface Rule {
  selectors: string[]
  declarations: Declaration[]
}

function parseRules(text: string): Rule[] {
  const rules: Rule[] = []
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({
      selectors: match[1]!.split(',').map((selector) => selector.trim()),
      declarations: match[2]!
        .split(';')
        .map((declaration) => declaration.trim())
        .filter((declaration) => declaration.includes(':'))
        .map((declaration) => {
          const colon = declaration.indexOf(':')
          return {
            property: declaration.slice(0, colon).trim(),
            value: declaration.slice(colon + 1).trim(),
          }
        }),
    })
  }
  return rules
}

const rules = parseRules(cssWithoutComments)

function ruleFor(selector: string): Rule {
  const rule = rules.find((candidate) => candidate.selectors.includes(selector))
  if (!rule) throw new Error(`no rule found for ${selector}`)
  return rule
}

function declarationValue(rule: Rule, property: string): string | undefined {
  return rule.declarations.find((declaration) => declaration.property === property)?.value
}

// `background-color` paints the whole border box (lane column included) and the
// `background` shorthand additionally resets `background-image`.
const BACKGROUND_PROPERTIES = ['background', 'background-color', 'background-image']

function backgroundProperties(rule: Rule): string[] {
  return rule.declarations
    .map((declaration) => declaration.property)
    .filter((property) => BACKGROUND_PROPERTIES.includes(property))
}

const STATE_SELECTORS = ['.row:hover', '.rowSelected', '.rowSelected:hover']

describe('git graph row fill stays out of the swimlane column', () => {
  it('paints the fill as a gradient hard-stopped at --graph-width', () => {
    expect(backgroundProperties(ruleFor('.row'))).toEqual(['background-image'])

    const gradient = declarationValue(ruleFor('.row'), 'background-image')!
    expect(gradient).toContain('linear-gradient(')
    // Two stops at the same offset = a hard edge: the fill starts where the lane
    // column ends instead of ramping across it.
    expect(gradient).toContain('transparent 0 var(--graph-width, 0px)')
    expect(gradient).toContain('var(--row-background) var(--graph-width, 0px)')
  })

  it('defaults --row-background on .row so an un-styled row degrades to transparent', () => {
    expect(declarationValue(ruleFor('.row'), '--row-background')).toBe('transparent')
  })

  it.each(STATE_SELECTORS)('%s hands the colour over via --row-background', (selector) => {
    const rule = ruleFor(selector)
    expect(backgroundProperties(rule)).toEqual([])
    expect(declarationValue(rule, '--row-background')).toMatch(/^var\(--vscode-/)
  })
})
