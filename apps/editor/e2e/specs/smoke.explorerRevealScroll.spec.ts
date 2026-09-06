/*---------------------------------------------------------------------------------------------
 *  Smoke spec: Reveal in Explorer scrolls an off-screen row back into view (P1).
 *
 *  Regression guard for `revealInExplorer` (RevealInExplorerAction): revealing a
 *  file that is ALREADY the tree's sole selection + focus must still scroll it
 *  into view when it has been scrolled off-screen. The bug: TreeModel.reveal ends
 *  with setSelection([id]), which early-returns without firing onReveal when the
 *  selection is unchanged — so the Tree's scrollIntoView never runs and the row
 *  stays out of view.
 *
 *  Repro: open a folder with enough files to overflow the viewport, open the last
 *  file (auto-reveal selects + scrolls to it), scroll the tree back to the top so
 *  the row leaves the viewport, then invoke Reveal in Explorer — the row must come
 *  back into view.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { test, expect } from '../fixtures/sharedApp.js'

// Enough rows to overflow any reasonable viewport, but well under the 200 default
// virtualization threshold so the tree renders as a flat (non-virtual) list whose
// root `[role="tree"]` element is the scroll container.
const FILE_COUNT = 120
const TARGET = `file-${String(FILE_COUNT - 1).padStart(3, '0')}.txt`

test.describe('@p1 explorer reveal scroll', () => {
  test('Reveal in Explorer scrolls an already-selected off-screen row into view @regression', async ({
    workbench,
    page,
  }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-reveal-'))
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

    // Open the last file. autoReveal selects the row and scrolls to it, so it is
    // the tree's sole selection + focus and initially in view.
    const targetUri = path.join(tmpDir, TARGET)
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), targetUri)

    const targetRow = page.locator('[role="treeitem"]', { hasText: TARGET })
    await expect(targetRow).toHaveAttribute('aria-selected', 'true', { timeout: 5000 })
    await expect(targetRow).toBeInViewport({ timeout: 5000 })

    // Scroll the tree back to the top so the (still-selected) target row leaves
    // the window viewport. Don't use toBeInViewport here: rows are absolutely
    // positioned with an inline `transform: translateY(...)`, and a row
    // re-mounted by the scroll reads as translateY(0) for one frame before
    // React commits the real offset. IntersectionObserver may report that
    // transient frame (ratio=1) even though the row's settled position is far
    // below the window. Also, the tree's reveal useLayoutEffect re-runs when
    // the tree structure version changes (e.g. the file watcher delivering its
    // initial refresh after arming), which calls scrollIntoView and silently
    // undoes our scroll-to-top. So keep re-asserting scrollTop = 0 inside the
    // poll until the bounding rect confirms the row is outside the window.
    await expect
      .poll(
        async () => {
          await page
            .locator('[role="tree"]')
            .first()
            .evaluate((el) => {
              el.scrollTop = 0
            })
          const r = await targetRow.evaluate((el) => {
            const rect = el.getBoundingClientRect()
            return { top: rect.top, bottom: rect.bottom, vh: window.innerHeight }
          })
          return r.bottom <= 0 || r.top >= r.vh
        },
        { timeout: 5000 },
      )
      .toBe(true)

    // Reveal in Explorer must scroll the already-selected row back into view.
    await workbench.runCommand('revealInExplorer', { resource: targetUri })

    await expect(targetRow).toBeInViewport({ timeout: 5000 })

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
