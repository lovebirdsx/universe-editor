/*---------------------------------------------------------------------------------------------
 *  Smoke spec: Explorer selection feedback (P1).
 *
 *  Two regressions this guards:
 *   A) Single-clicking a file previews it. The preview open must NOT steal DOM
 *      focus away from the Explorer, otherwise the tree loses `data-focused`
 *      and its selected row's blue highlight degrades to the grey inactive tint
 *      (indistinguishable from the active-editor marker). `data-focused` on the
 *      tree container is precisely what the CSS keys the active-selection colour
 *      off, so it is the visual bug's direct signal.
 *   B) Right-clicking a row selects that row (VSCode parity) so the context menu
 *      operates on it — not on whatever was selected before.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { test, expect } from '../fixtures/sharedApp.js'

// After a workspace change the workbench opens a ~1.5s window during which it
// restores focus to the active editor on any editor/group change (see
// WorkspaceFocusRestoreContribution). A file clicked inside that window would
// have its focus pulled to the editor by that restore, not by the code under
// test. Wait the window out so the click reflects steady-state behaviour — the
// same as a user who opens a folder and only then starts clicking files.
const RESTORE_WINDOW_MS = 1700

test.describe('@p1 explorer selection feedback', () => {
  test('single-click previews the file without stealing focus from the tree @regression', async ({
    workbench,
    page,
  }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-sel-'))
    await fs.writeFile(path.join(tmpDir, 'alpha.txt'), 'a')
    await fs.writeFile(path.join(tmpDir, 'beta.txt'), 'b')

    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    await expect
      .poll(() => workbench.getContextKey<boolean>('sideBarVisible'), { timeout: 5000 })
      .toBe(true)

    const alpha = page.locator('[role="treeitem"]', { hasText: 'alpha.txt' })
    await expect(alpha).toBeVisible({ timeout: 5000 })

    // Focus the tree and let the post-workspace focus-restore window elapse.
    await alpha.click()
    await page.waitForTimeout(RESTORE_WINDOW_MS)

    // Now single-click to preview: focus must stay in the Explorer.
    await alpha.click()

    // The file previews (becomes the active editor)…
    await expect
      .poll(() => workbench.getActiveEditorUri(), { timeout: 5000 })
      .toContain('alpha.txt')

    // …but focus stays in the Explorer tree: the tree keeps `data-focused="true"`
    // (what drives the selected row's blue highlight) and the row stays selected.
    await expect(page.locator('[role="tree"][data-focused="true"]').first()).toBeVisible()
    await expect(alpha).toHaveAttribute('aria-selected', 'true')

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  test('right-click selects the clicked row @regression', async ({ workbench, page }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-sel-ctx-'))
    await fs.writeFile(path.join(tmpDir, 'alpha.txt'), 'a')
    await fs.writeFile(path.join(tmpDir, 'beta.txt'), 'b')

    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    await expect
      .poll(() => workbench.getContextKey<boolean>('sideBarVisible'), { timeout: 5000 })
      .toBe(true)

    const alpha = page.locator('[role="treeitem"]', { hasText: 'alpha.txt' })
    const beta = page.locator('[role="treeitem"]', { hasText: 'beta.txt' })
    await expect(alpha).toBeVisible({ timeout: 5000 })
    await expect(beta).toBeVisible({ timeout: 5000 })

    // Select alpha first, then right-click beta.
    await alpha.click()
    await expect(alpha).toHaveAttribute('aria-selected', 'true')

    await beta.click({ button: 'right' })

    // The context-menu target is now beta; alpha is no longer selected.
    await expect(beta).toHaveAttribute('aria-selected', 'true')
    await expect(alpha).toHaveAttribute('aria-selected', 'false')

    // Dismiss the context menu so teardown finds a clean overlay state.
    await page.keyboard.press('Escape')

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
