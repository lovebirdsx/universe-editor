// @vitest-environment node
/*---------------------------------------------------------------------------------------------
 *  Context menu highlight contract. A menu row takes a *virtual* focus rather
 *  than DOM focus, so the highlight rules in `ContextMenu.module.css` have equal
 *  specificity and are decided by source order alone — a relationship happy-dom
 *  cannot reproduce (it never loads the stylesheet), hence the static assertions
 *  on the CSS source. What this guards is silent: move the keyboard rule above
 *  the hover rule and a row under the pointer wins the tie again, which is the
 *  "the cursor and the pointer look identical" bug this split replaced.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const KEYBOARD_CURSOR = ".item[data-active='keyboard']"

// Comments carry prose (a declaration spelled out in a doc block) and must never
// be read as one.
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

const css = stripCssComments(
  readFileSync(join(srcRoot, 'contextMenu', 'ContextMenu.module.css'), 'utf8'),
)

/** The declarations of the first rule whose selector list contains `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`[^{}]*${escaped}[^{}]*\\{([^}]*)\\}`))?.[1] ?? ''
}

describe('context menu highlight contract', () => {
  it('keeps the keyboard cursor rule after the hover rule', () => {
    // Equal specificity: this order is what makes the cursor outrank a pointer
    // resting on the very row the arrow keys just stepped onto.
    const hover = css.indexOf('.item:hover')
    const cursor = css.indexOf(KEYBOARD_CURSOR)
    expect(hover).toBeGreaterThan(-1)
    expect(cursor).toBeGreaterThan(hover)

    // And the disabled override has to stay last of all, or an inert row would
    // be highlighted again.
    expect(css.indexOf('.disabled[data-active]')).toBeGreaterThan(cursor)
  })

  it('paints the keyboard cursor with its own fill plus a focus outline', () => {
    const body = ruleBody(KEYBOARD_CURSOR)
    expect(body).toMatch(/background:\s*var\(--vscode-list-activeSelectionBackground/)
    // The outline is load-bearing, not decoration: under the light themes the
    // two selection colours collapse onto the same value.
    expect(body).toMatch(/outline:\s*1px solid var\(--vscode-list-focusOutline/)
    expect(body).toMatch(/outline-offset:\s*-1px/)
  })

  it('leaves the pointer row and the open trail on the shared hover fill', () => {
    expect(ruleBody('.item:hover')).toMatch(/--vscode-list-hoverBackground/)
    expect(ruleBody(".item[data-active='open']")).toMatch(/--vscode-list-hoverBackground/)
  })

  it('gives the pointer row no highlight rule of its own', () => {
    // `:hover` paints it. A rule on `data-active='mouse'` would survive the
    // pointer leaving the menu, leaving a lit row behind.
    expect(css).not.toContain("data-active='mouse'")
  })
})
