/*---------------------------------------------------------------------------------------------
 *  Terminal file links across a wrapped line — regression guard.
 *
 *  Two independent defects made a wrapped path unclickable, and each one alone
 *  is enough to break it. Only a real pty + real xterm + a real mouse exercises
 *  both; the provider unit tests drive provideLinks() directly and see neither.
 *
 *    1. On Windows, conpty below build 21376 has no wraparound mode: a line
 *       running past the last column arrives as a hard `\r\n` and the buffer
 *       line is never flagged isWrapped. The provider's wrapped window then
 *       never joins the rows, so the path is not even matched. xterm has a
 *       heuristic for exactly this, but only enables it when told which pty
 *       backend is in play.
 *    2. provideLinks(y) answered with every match in the wrapped window,
 *       including links lying entirely on other rows. xterm's
 *       Linkifier._removeIntersectingLinks projects those onto the hovered row
 *       (start.y < y ⇒ x=0), they claim the low columns, and the genuinely
 *       wrapped link — also projected from x=0 — collides and is spliced out of
 *       the cached reply.
 *    3. The wrapped-window string is joined with translateToString(true)
 *       (trimRight) while the coordinate mapping walked the full cell grid, so
 *       the trailing NULL cells of a row that is flagged wrapped without being
 *       full each ate one string character. The range slid left and collapsed
 *       onto one row — the link still opened the right file, but the underline
 *       was drawn over the wrong columns.
 *
 *  The range assertions below guard the geometry (1) and (2) produce. They do
 *  NOT reproduce (3): xterm only flags a row wrapped when the PREVIOUS row's
 *  last column is non-blank (WindowsMode.updateWindowsModeWrappedState), so a
 *  single echo can never leave a wrapped row with trailing NULL cells. That
 *  shape needs conpty's erase-to-end-of-line repaints, and it is reproduced by
 *  the "wrapped rows with trailing blank cells" unit tests instead. Asserting
 *  the range here is still what makes (3)-class regressions visible at all —
 *  "the right file opened" is blind to every rendering error.
 *
 *  Landing the pointer on the row's blank tail before moving onto the path is
 *  what makes xterm read that pruned cache instead of asking again, so it is
 *  load-bearing for (2), not incidental.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

// A short path that is NOT the target. It shares the wrapped window with the
// long path and is what makes xterm prune — a real terminal almost always has
// one, since the shell prompt itself matches as a path.
const SIBLING = 'a/sib.ts'

// Long enough to run past the last column at the default terminal width.
const TARGET_REL =
  'src/wrapped-link-target-aaaaaaaaaa-bbbbbbbbbb-cccccccccc-dddddddddd-eeeeeeeeee-ffffffffff-gggggggggg-hhhhhhhhhh-endmarker.ts'

interface ClickTargets {
  /** Center of a character on the continuation row, inside the link. */
  readonly target: { x: number; y: number }
  /** Blank tail of that same row — the pointer lands here first. */
  readonly blank: { x: number; y: number }
  /** Text of the continuation row, for the wrap assertion. */
  readonly continuation: string
}

test.use({
  workspaceSeeder: {
    seed(dir) {
      mkdirSync(resolve(dir, 'src'), { recursive: true })
      writeFileSync(resolve(dir, TARGET_REL), 'export const wrapped = 1\n')
    },
  },
})

test.describe('terminal file links', () => {
  test('opens a file whose path wraps across terminal rows @regression', async ({
    workbench,
    page,
    launchWorkspace,
  }) => {
    if (!launchWorkspace) throw new Error('workspace seeder did not run')
    await workbench.waitForRestored()

    // Room for the prompt plus the wrapped echo and the wrapped output.
    await page.evaluate(() => window.__E2E__!.setLayoutSize('panel', 420))

    // Workspace-relative paths in the output only resolve when the terminal
    // inherits the workspace cwd, which is what newTerminal() does.
    const id = await page.evaluate(() => window.__E2E__!.terminalCreateInWorkspace())
    expect(id, 'terminal was not created').not.toBeNull()

    await workbench.runCommand('workbench.action.terminal.toggleTerminal')
    await workbench.panel.waitForVisible()
    await workbench.panel.waitForActiveTab('workbench.view.terminal')
    await page.locator(`[data-terminal-id="${id}"] .xterm-rows`).waitFor({ state: 'attached' })

    await page.evaluate(
      ([tid, line]) => window.__E2E__!.terminalInput(tid!, `echo "${line}"\r`),
      [id, `${SIBLING} ${TARGET_REL}`],
    )
    await expect
      .poll(() => page.evaluate((tid) => window.__E2E__!.terminalReadBuffer(tid!), id), {
        timeout: 15_000,
      })
      .toContain('endmarker.ts')

    // Poll: the pty echo lands before xterm has painted the rows.
    const targets = await pollClickTargets(page, id!)

    // The whole point of the fixture is that the path spans rows. Without this
    // the assertions below could pass on a single-row link.
    expect(
      TARGET_REL.includes(targets.continuation),
      `continuation row "${targets.continuation}" is not a slice of the target path — the line did not wrap as expected`,
    ).toBe(true)

    await page.mouse.move(targets.blank.x, targets.blank.y)
    await page.mouse.move(targets.target.x, targets.target.y)
    await page.mouse.down()
    await page.mouse.up()

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorUri()), { timeout: 10_000 })
      .toContain('endmarker.ts')

    // Opening the right file says nothing about where the underline was drawn:
    // xterm renders it straight from the range the provider returns, and a range
    // that has collapsed onto one row still activates correctly. So assert the
    // range itself.
    //
    // Ask on the row pollClickTargets already located and clicked — deriving the
    // row from a fixed marker substring instead would break whenever the wrap
    // lands mid-marker, and the clicked row is the one whose underline the
    // screenshot was about anyway.
    const clickedRow = await page.evaluate(
      ([tid, needle]) => window.__E2E__!.terminalFindRow(tid!, needle!),
      [id, targets.continuation],
    )
    expect(clickedRow, 'the continuation row was not found in the buffer').toBeGreaterThan(0)

    const links = await page.evaluate(
      ([tid, row]) => window.__E2E__!.terminalProvideLinks(tid as string, row as number),
      [id, clickedRow] as const,
    )
    const link = links.find((l) => l.text.includes(TARGET_REL.slice(-12)))
    expect(link, `no link on row ${clickedRow}; got ${JSON.stringify(links)}`).toBeDefined()

    // The path is longer than one row, so its range must span rows. A single-row
    // range here is exactly the bug: the underline stays on one row and runs to
    // the row end instead of hugging the path.
    expect(link!.startY, `link range ${JSON.stringify(link)} did not span rows`).toBeLessThan(
      link!.endY,
    )

    // The range must end at the path's last character on its final row, not at
    // the row's edge. `endX` is the exclusive end column, so it counts exactly
    // the columns the path occupies there — and those columns must hold the
    // path's own tail.
    const tailText = await page.evaluate(
      ([tid, row]) => window.__E2E__!.terminalRowText(tid as string, row as number),
      [id, link!.endY] as const,
    )
    expect(tailText.slice(0, link!.endX)).toBe(TARGET_REL.slice(-link!.endX))
    // A range dragged past the path would overrun the row's rendered text; the
    // row is trimmed, so its length is the hard upper bound.
    expect(link!.endX).toBeLessThanOrEqual(tailText.length)

    // ...and start at the path's first character on the head row. This is the
    // half the screenshot showed drifting: a mis-mapped range slid the start
    // left into the text preceding the path.
    const headText = await page.evaluate(
      ([tid, row]) => window.__E2E__!.terminalRowText(tid as string, row as number),
      [id, link!.startY] as const,
    )
    expect(headText.slice(link!.startX - 1)).toBe(
      TARGET_REL.slice(0, headText.length - link!.startX + 1),
    )
  })
})

/**
 * Locate the row that continues the echoed path, and two points on it: a
 * character inside the link, and the blank tail to its right.
 *
 * Reading xterm's row DOM is the only way to turn a buffer position into screen
 * coordinates, and screen coordinates are the only way to drive a real mouse
 * through xterm's hit-testing. The DOM is used for aiming only — every
 * assertion in this spec goes through a probe.
 */
async function pollClickTargets(
  page: import('@playwright/test').Page,
  terminalId: string,
): Promise<ClickTargets> {
  let last: ClickTargets | null = null
  await expect
    .poll(
      async () => {
        last = await page.evaluate(
          ([id, sibling]) => {
            const host = document.querySelector(`[data-terminal-id="${id}"]`)
            const rows = host ? Array.from(host.querySelectorAll('.xterm-rows > div')) : []
            const texts = rows.map((el) => el.textContent ?? '')
            // Last occurrence = the echoed output. The typed command line above
            // it contains the same text.
            let head = -1
            for (let i = texts.length - 1; i >= 0; i--) {
              if (texts[i]!.includes(sibling!)) {
                head = i
                break
              }
            }
            const row = head >= 0 ? rows[head + 1] : undefined
            const continuation = (texts[head + 1] ?? '').trim()
            if (!row || !continuation) return null

            // A character rect, not a column-width estimate: xterm merges cells
            // into spans, so arithmetic off the row rect would drift.
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
            const node = walker.nextNode()
            if (!node || (node.textContent ?? '').length === 0) return null
            const range = document.createRange()
            range.setStart(node, 0)
            range.setEnd(node, 1)
            const char = range.getBoundingClientRect()
            const rect = row.getBoundingClientRect()
            if (char.width === 0 || rect.width === 0) return null
            return {
              target: { x: char.left + char.width / 2, y: char.top + char.height / 2 },
              blank: { x: rect.right - 6, y: rect.top + rect.height / 2 },
              continuation,
            }
          },
          [terminalId, SIBLING],
        )
        return last !== null
      },
      { timeout: 15_000 },
    )
    .toBe(true)
  if (!last) throw new Error('terminal rows never rendered the wrapped path')
  return last
}
