/*---------------------------------------------------------------------------------------------
 *  Diff editor auto-reveal (P0).
 *
 *  Opening a diff should scroll the modified side to the first change instead of
 *  staying at the top. The first difference is placed well below the fold so the
 *  view must scroll for the assertion to hold — `firstVisibleLine` stays at 1
 *  when auto-reveal is broken.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '../fixtures/sharedApp.js'

const LINE_COUNT = 100
const FIRST_CHANGE_LINE = 60

function makeOriginal(): string {
  return Array.from({ length: LINE_COUNT }, (_, i) => `line ${i + 1}`).join('\n')
}

function makeModified(): string {
  return Array.from({ length: LINE_COUNT }, (_, i) =>
    i + 1 === FIRST_CHANGE_LINE ? `line ${i + 1} CHANGED` : `line ${i + 1}`,
  ).join('\n')
}

test.describe('@p0 diff auto reveal', () => {
  // Depend on `workbench` (not just `page`): the worker fixture's per-test
  // resetWindow — which reloads the window and re-mounts React after the prior
  // test's teardown gate unmounted it — only runs for tests that pull the
  // `workbench` fixture. Without it this spec inherits a dead (unmounted) page.
  test('scrolls the modified side to the first change on open', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    const original = makeOriginal()
    const modified = makeModified()

    await page.evaluate(
      ([original, modified]) =>
        window.__E2E__!.runCommand('_workbench.openDiff', {
          title: 'long.txt',
          originalUri: 'file:///ws/long.txt',
          original,
          modified,
          pinned: true,
        }),
      [original, modified] as const,
    )

    // Diff computation + reveal are async; poll until the view scrolls past the
    // top of the file onto the first change.
    await expect
      .poll(
        async () => {
          const state = await page.evaluate(() => window.__E2E__!.getActiveDiffViewState())
          return state?.firstVisibleLine ?? 0
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(1)

    const state = await page.evaluate(() => window.__E2E__!.getActiveDiffViewState())
    expect(state?.cursorLine).toBe(FIRST_CHANGE_LINE)
  })
})
