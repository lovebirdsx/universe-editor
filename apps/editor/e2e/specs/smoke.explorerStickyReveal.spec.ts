/*---------------------------------------------------------------------------------------------
 *  Smoke spec: revealing a row above the viewport lands it below the sticky
 *  father-folder stack (P1).
 *
 *  Regression guard for the sticky-scroll reveal: the tree top-aligns a
 *  revealed row (`scrollTop = rowTop`), which is exactly where the pinned
 *  ancestor stack is painted — the focused row ends up underneath it and cannot
 *  be seen. The fix reserves the band (VSCode's `List.reveal(..., paddingTop)`),
 *  so the real row lands just below the pinned rows.
 *
 *  Repro: open a folder with enough files to overflow the viewport, open the
 *  last file (auto-reveal scrolls down and pins the workspace root), scroll to
 *  the bottom, then press ArrowUp — the focused row moves above the viewport
 *  and must come back below the pinned root.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

// After a workspace change the workbench restores focus to the active editor on
// editor/group changes (~1.5s). Wait it out before driving the tree, otherwise
// the key presses land in the editor instead of the tree.
const RESTORE_WINDOW_MS = 1700

// Enough rows to overflow any reasonable viewport, but well under the 200 default
// virtualization threshold so the tree renders as a flat (non-virtual) list whose
// root `[role="tree"]` element is the scroll container.
const FILE_COUNT = 120
const BOTTOM_TARGET = `file-${String(FILE_COUNT - 1).padStart(3, '0')}.txt`

test.describe('@p1 explorer sticky reveal', () => {
  test('reveal stops below the pinned father-folder stack @regression', async ({
    workbench,
    page,
  }) => {
    const tmpDir = mkTempDir('ue2-sticky-reveal-')
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

    // Open the last file: auto-reveal selects it and scrolls the tree down.
    await page.evaluate((p) => window.__E2E__!.openFileUri(p), path.join(tmpDir, BOTTOM_TARGET))
    const bottomRow = page.locator('[role="treeitem"]', { hasText: BOTTOM_TARGET })
    await expect(bottomRow).toHaveAttribute('aria-selected', 'true', { timeout: 5000 })

    // `openFileUri` focuses the editor; click the row after the focus-restore
    // window so steady-state focus (and therefore the arrow keys) sits on the tree.
    const tree = page.locator('[role="tree"]').first()
    await bottomRow.click()
    await page.waitForTimeout(RESTORE_WINDOW_MS)
    await bottomRow.click()
    await expect(tree).toHaveAttribute('data-focused', 'true')

    // Bottom-align the scroller so the focused last row sits at the bottom edge
    // and the workspace root is pinned over the viewport top.
    await tree.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await expect(page.locator('[data-testid="tree-sticky-row"]').first()).toBeVisible({
      timeout: 5000,
    })

    // Walk focus above the viewport: the reveal must reserve the pinned band
    // instead of top-aligning the row underneath it.
    const presses = await tree.evaluate((el) => {
      const row = el.querySelector<HTMLElement>('[role="treeitem"]')
      return Math.ceil(el.clientHeight / (row?.offsetHeight ?? 22)) + 2
    })
    for (let i = 0; i < presses; i++) await page.keyboard.press('ArrowUp')

    const focused = page.locator('[role="treeitem"][aria-selected="true"]').first()
    // Rows are absolutely positioned with an inline `top`; poll until the
    // reveal (and the rAF-throttled sticky measurement) settles.
    await expect
      .poll(
        async () => {
          const { targetTop, stackBottom } = await page.evaluate(() => {
            const target = document.querySelector<HTMLElement>(
              '[role="treeitem"][aria-selected="true"]',
            )
            const targetTop = target?.getBoundingClientRect().top ?? Number.NEGATIVE_INFINITY
            const stackBottom = Math.max(
              0,
              ...[...document.querySelectorAll<HTMLElement>('[data-testid="tree-sticky-row"]')].map(
                (row) => row.getBoundingClientRect().bottom,
              ),
            )
            return { targetTop, stackBottom }
          })
          return targetTop - stackBottom
        },
        { timeout: 5000 },
      )
      .toBeGreaterThanOrEqual(-1)
    await expect(focused).toBeInViewport({ timeout: 5000 })

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
