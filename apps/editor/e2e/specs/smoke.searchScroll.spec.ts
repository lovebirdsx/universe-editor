/*---------------------------------------------------------------------------------------------
 *  Search results scrolling smoke (P1).
 *
 *  Guards against the virtualization regression where the inner scroll container
 *  reused a flex column class: the virtual spacer became a shrinkable flex item,
 *  collapsing the scrollable range so the thumb jumped while browsing a large
 *  result set. With a fixed-height, non-flex scroll container the range equals
 *  rowCount × rowHeight and scrollTop reaches the bottom deterministically.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'

const SEARCH = 'workbench.view.search'
const NEEDLE = 'search-scroll-needle'
// Enough matches to cross the Tree virtualization threshold (200) comfortably:
// one file with many matching lines yields file node + one row per match.
const MATCH_LINES = 600

function writeWorkspace(): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-searchscroll-'))
  const lines = Array.from({ length: MATCH_LINES }, (_, i) => `${NEEDLE} occurrence ${i + 1}`)
  writeFileSync(join(dir, 'big.txt'), lines.join('\n'), 'utf8')
  return { dir }
}

test.describe('@p1 search scroll', () => {
  test('large result set scrolls to the bottom without thumb jumping @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const { dir } = writeWorkspace()
    await workbench.openWorkspace(dir)
    await workbench.activityBar.click(SEARCH)

    const searchView = page.getByTestId('search-view')
    await expect(searchView).toBeVisible()
    await searchView.getByRole('textbox', { name: 'Search', exact: true }).fill(NEEDLE)

    // Wait until the results tree has virtualized (a spacer taller than the
    // viewport is present) — i.e. the search produced a large result set.
    const tree = searchView.getByRole('tree', { name: 'Search results' })
    await expect(tree).toBeVisible()

    // The inner virtual scroller is the element that actually scrolls.
    const scroller = tree.locator('div').first()

    // Poll for a scroll range that reflects the full result set: total height
    // must be far larger than the client height. With the flex-shrink bug the
    // spacer collapses and scrollHeight ≈ clientHeight, so this never holds.
    await expect
      .poll(
        async () =>
          scroller.evaluate((el) => {
            const scroll = el as HTMLElement
            return scroll.scrollHeight - scroll.clientHeight
          }),
        { timeout: 15000 },
      )
      .toBeGreaterThan(1000)

    // Scroll to the very bottom and assert scrollTop actually lands near the
    // maximum. A jumpy/collapsed range would clamp scrollTop back toward 0.
    const { top, max } = await scroller.evaluate((el) => {
      const scroll = el as HTMLElement
      scroll.scrollTop = scroll.scrollHeight
      return { top: scroll.scrollTop, max: scroll.scrollHeight - scroll.clientHeight }
    })
    expect(max - top).toBeLessThanOrEqual(2)
  })
})
