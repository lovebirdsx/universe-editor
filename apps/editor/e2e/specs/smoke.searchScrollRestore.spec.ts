/*---------------------------------------------------------------------------------------------
 *  Search results scroll-restore smoke (P1).
 *
 *  搜索结果树接了 ScrollStateKey（scrollStateKey="search"）：切到别的 SideBar 容器
 *  再切回来，结果列表应停在切走前的滚动位置，而不是被重置到顶部。search 结果几乎总是
 *  越过 Tree 的虚拟化阈值（200）走虚拟路径，所以这里同时守护“虚拟模式下的滚动恢复”。
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'

const SEARCH = 'workbench.view.search'
const EXPLORER = 'workbench.view.explorer'
const NEEDLE = 'search-scroll-restore-needle'
const MATCH_LINES = 600

function writeWorkspace(): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-searchscrollrestore-'))
  const lines = Array.from({ length: MATCH_LINES }, (_, i) => `${NEEDLE} occurrence ${i + 1}`)
  writeFileSync(join(dir, 'big.txt'), lines.join('\n'), 'utf8')
  return { dir }
}

test.describe('@p1 search scroll restore', () => {
  test('results keep their scroll position across a sidebar container switch @regression', async ({
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

    const tree = searchView.getByRole('tree', { name: 'Search results' })
    await expect(tree).toBeVisible()
    const scroller = tree.locator('div').first()

    // Wait for a large, virtualized result set (scroll range far exceeds viewport).
    await expect
      .poll(
        async () =>
          scroller.evaluate(
            (el) => (el as HTMLElement).scrollHeight - (el as HTMLElement).clientHeight,
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThan(1000)

    // Scroll to a mid position and record it.
    const target = await scroller.evaluate((el) => {
      const s = el as HTMLElement
      s.scrollTop = Math.floor((s.scrollHeight - s.clientHeight) / 2)
      s.dispatchEvent(new Event('scroll'))
      return s.scrollTop
    })
    expect(target).toBeGreaterThan(0)

    // Switch away to Explorer (unmounts SearchView) and back.
    await workbench.activityBar.click(EXPLORER)
    await expect(searchView).toBeHidden()
    await workbench.activityBar.click(SEARCH)
    await expect(searchView).toBeVisible()

    // The restored scroller should land back at (approximately) the saved offset.
    const restoredScroller = searchView
      .getByRole('tree', { name: 'Search results' })
      .locator('div')
      .first()
    await expect
      .poll(async () => restoredScroller.evaluate((el) => (el as HTMLElement).scrollTop), {
        timeout: 8000,
        intervals: [100],
      })
      .toBeGreaterThan(target - 40)
  })
})
