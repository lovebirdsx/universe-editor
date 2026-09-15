/*---------------------------------------------------------------------------------------------
 *  Smoke spec: Reveal Active File in Explorer scrolls the target row into view
 *  when the Explorer tree was unmounted (another view container was active).
 *
 *  Regression guard for the "have to press it twice" bug: with focus in the
 *  Search view, the first Reveal Active File in Explorer switches the side bar
 *  to Explorer and selects the right row — but the reveal's layout effect ran
 *  before the remounted tree's layout was computed, read a pre-layout
 *  clientHeight spanning the whole content, judged the last row "already
 *  visible" and dropped the scroll. A second invocation worked because the
 *  tree was already mounted and laid out.
 *
 *  Repro: seed a flat folder with enough files to overflow the viewport, scroll
 *  the tree to the top, switch to the Search view (unmounting the tree), open
 *  the last file, then invoke Reveal Active File in Explorer — the row must be
 *  scrolled into view on the FIRST invocation.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

// Same budget as smoke.explorerRevealScroll.spec.ts: enough rows to overflow the
// viewport, under the 200 virtualization threshold so the tree renders flat and
// the root `[role="tree"]` element owns the scroll position.
const FILE_COUNT = 120
const TARGET = `file-${String(FILE_COUNT - 1).padStart(3, '0')}.txt`

test.describe('@p1 explorer reveal scroll on remount', () => {
  test('Reveal Active File scrolls the target row into view when the Explorer tree was unmounted @regression', async ({
    workbench,
    page,
  }) => {
    const tmpDir = mkTempDir('ue2-reveal-remount-')
    await Promise.all(
      Array.from({ length: FILE_COUNT }, (_, i) =>
        fs.writeFile(path.join(tmpDir, `file-${String(i).padStart(3, '0')}.txt`), 'x'),
      ),
    )

    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    await expect
      .poll(() => workbench.getContextKey<boolean>('sideBarVisible'), { timeout: 5000 })
      .toBe(true)

    const rows = page.locator('[role="treeitem"]')
    await expect(rows.first()).toBeVisible({ timeout: 5000 })
    await expect.poll(() => rows.count(), { timeout: 5000 }).toBeGreaterThan(30)

    // Scroll the tree to the very top and let the position stick, so
    // useScrollRestore has a saved position (0) that is far from the target row
    // (the last of 120). Re-assert inside the poll: the tree's reveal
    // useLayoutEffect re-runs on structure-version changes (e.g. the file watcher
    // arming) and would silently undo our scroll if we only set it once.
    await expect
      .poll(
        async () => {
          await page
            .locator('[role="tree"]')
            .first()
            .evaluate((el) => {
              el.scrollTop = 0
            })
          return page
            .locator('[role="tree"]')
            .first()
            .evaluate((el) => el.scrollTop)
        },
        { timeout: 5000 },
      )
      .toBe(0)

    // Switch to the Search view. This unmounts the Explorer tree; its
    // useScrollRestore cleanup saves scrollTop = 0 into ScrollStateCache.
    // ViewContainerLocation.SideBar = 0 (const enum, packages/platform/src/workbench/viewRegistry.ts).
    await workbench.runCommand('workbench.action.findInFiles')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveViewContainerId(0)), {
        timeout: 5000,
      })
      .toBe('workbench.view.search')

    // Open the last file. Focus lands in the editor; the Explorer tree is still
    // unmounted.
    const targetUri = path.join(tmpDir, TARGET)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), targetUri)

    // Invoke Reveal Active File in Explorer. This switches back to the Explorer
    // container (remounting the tree) and reveals the target. The FIRST
    // invocation must already scroll the row into view — previously the reveal
    // ran against the remount's pre-layout viewport and was silently dropped.
    await workbench.runCommand('workbench.files.action.revealActiveFileInExplorer')

    // The target row is selected (model state is always correct — the bug is
    // scroll-only). Don't assert focusedView here: focus settles on a separate
    // timing track and isn't the symptom under test.
    const targetRow = page.locator('[role="treeitem"]', { hasText: TARGET })
    await expect(targetRow).toHaveAttribute('aria-selected', 'true', { timeout: 5000 })

    // The target row must be inside the tree's scroll viewport. Assert against
    // the tree container's rect (not the window's) via boundingClientRect — the
    // tree is what scrolls. Poll to ride out the single top:0 transient frame a
    // re-mounted row shows before React commits its real offset (see
    // smoke.explorerRevealScroll.spec.ts).
    await expect
      .poll(
        () =>
          page.evaluate((targetName) => {
            const tree = document.querySelector<HTMLElement>('[role="tree"]')
            if (!tree) return { ok: false, reason: 'no tree' }
            const treeRect = tree.getBoundingClientRect()
            const rows = Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'))
            const row = rows.find((el) => el.textContent?.includes(targetName))
            if (!row) return { ok: false, reason: 'no row' }
            const rowRect = row.getBoundingClientRect()
            return {
              ok: rowRect.top >= treeRect.top && rowRect.bottom <= treeRect.bottom,
              reason: `rowTop=${rowRect.top} rowBottom=${rowRect.bottom} treeTop=${treeRect.top} treeBottom=${treeRect.bottom} scrollTop=${tree.scrollTop} scrollHeight=${tree.scrollHeight}`,
            }
          }, TARGET),
        { timeout: 5000 },
      )
      .toEqual(expect.objectContaining({ ok: true }))

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
