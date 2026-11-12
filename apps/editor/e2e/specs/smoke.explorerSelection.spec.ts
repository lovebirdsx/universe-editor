/*---------------------------------------------------------------------------------------------
 *  Smoke spec: Explorer selection feedback (P1).
 *
 *  Three regressions this guards:
 *   A) Single-clicking a file previews it. The preview open must NOT steal DOM
 *      focus away from the Explorer, otherwise the tree loses `data-focused`
 *      and its selected row's blue highlight degrades to the grey inactive tint
 *      (indistinguishable from the active-editor marker). `data-focused` on the
 *      tree container is precisely what the CSS keys the active-selection colour
 *      off, so it is the visual bug's direct signal.
 *   B) Right-clicking a row selects that row (VSCode parity) so the context menu
 *      operates on it — not on whatever was selected before.
 *   C) Escape collapses a multi-selection to the focused row instead of being
 *      swallowed by the global focus-editor-group binding.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { test, expect } from '../fixtures/sharedApp.js'
import { mkTempDir } from '@universe-editor/e2e-harness'

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
    const tmpDir = mkTempDir('ue2-sel-')
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
    const tmpDir = mkTempDir('ue2-sel-ctx-')
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

  test('Escape collapses a multi-selection to the focused row @regression', async ({
    workbench,
    page,
  }) => {
    const tmpDir = mkTempDir('ue2-sel-esc-')
    await fs.writeFile(path.join(tmpDir, 'alpha.txt'), 'a')
    await fs.writeFile(path.join(tmpDir, 'beta.txt'), 'b')
    await fs.writeFile(path.join(tmpDir, 'gamma.txt'), 'c')

    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    await expect
      .poll(() => workbench.getContextKey<boolean>('sideBarVisible'), { timeout: 5000 })
      .toBe(true)

    const alpha = page.locator('[role="treeitem"]', { hasText: 'alpha.txt' })
    await expect(alpha).toBeVisible({ timeout: 5000 })
    // Let the post-workspace focus-restore window elapse, then click once more:
    // the initial preview must not leave keyboard focus in the editor.
    await alpha.click()
    await page.waitForTimeout(RESTORE_WINDOW_MS)
    await alpha.click()
    await expect(page.locator('[role="tree"][data-focused="true"]').first()).toBeVisible()

    // alpha → beta → gamma; focus ends on gamma.
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Shift+ArrowDown')
    const selected = page.locator('[role="treeitem"][aria-selected="true"]')
    await expect(selected).toHaveCount(3)

    await page.keyboard.press('Escape')

    // Exactly the focused row survives, and the tree keeps keyboard focus.
    await expect(selected).toHaveCount(1)
    await expect(selected).toContainText('gamma.txt')
    await expect(page.locator('[role="tree"][data-focused="true"]').first()).toBeVisible()

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  test('Ctrl+P/N/J/K walk the tree without leaking to quick open, new file or panel', async ({
    workbench,
    page,
  }) => {
    const tmpDir = mkTempDir('ue2-sel-ctrl-')
    await fs.writeFile(path.join(tmpDir, 'alpha.txt'), 'a')
    await fs.writeFile(path.join(tmpDir, 'beta.txt'), 'b')
    await fs.writeFile(path.join(tmpDir, 'gamma.txt'), 'c')

    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    const alpha = page.locator('[role="treeitem"]', { hasText: 'alpha.txt' })
    await expect(alpha).toBeVisible({ timeout: 5000 })
    await alpha.click()
    await page.waitForTimeout(RESTORE_WINDOW_MS)
    await alpha.click()
    await expect(page.locator('[role="tree"][data-focused="true"]').first()).toBeVisible()

    const selected = page.locator('[role="treeitem"][aria-selected="true"]')
    const expectSelected = (name: string) =>
      expect.poll(() => selected.textContent()).toContain(name)

    // Ctrl+N / Ctrl+J step down, Ctrl+K / Ctrl+P step back up. Every one of
    // them has a global meaning (new file, toggle panel, chord, quick open)
    // that must not fire while the tree itself holds focus.
    await page.keyboard.press('Control+n')
    await expectSelected('beta.txt')
    await page.keyboard.press('Control+j')
    await expectSelected('gamma.txt')
    await page.keyboard.press('Control+k')
    await expectSelected('beta.txt')
    await page.keyboard.press('Control+p')
    await expectSelected('alpha.txt')

    await expect.poll(() => workbench.getContextKey<boolean>('quickInputVisible')).toBe(false)
    await expect.poll(() => workbench.getActiveEditorUri()).toContain('alpha.txt')

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  test('Ctrl+H/L collapse, expand and descend the tree without leaking to replace', async ({
    workbench,
    page,
  }) => {
    const tmpDir = mkTempDir('ue2-sel-ctrl-hl-')
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'src', 'child.ts'), 'export {}\n')

    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    const src = page.locator('[role="treeitem"]', { hasText: 'src' })
    const child = page.locator('[role="treeitem"]', { hasText: 'child.ts' })
    await expect(src).toBeVisible({ timeout: 5000 })

    // Opening the workspace arms a focus-restore window; wait it out, then click
    // the child so the tree (not the editor) owns the keyboard.
    await src.click()
    await page.waitForTimeout(RESTORE_WINDOW_MS)
    await child.click()
    await expect(page.locator('[role="tree"][data-focused="true"]').first()).toBeVisible()
    await expect(child).toHaveAttribute('aria-selected', 'true')

    // Left from the child selects its parent; Left again collapses it.
    await page.keyboard.press('Control+h')
    await expect(src).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Control+h')
    await expect(child).toHaveCount(0)
    await expect(src).toHaveAttribute('aria-expanded', 'false')

    // Right expands, then steps into the first child; Left comes back.
    await page.keyboard.press('Control+l')
    await expect(child).toBeVisible()
    await page.keyboard.press('Control+l')
    await expect(child).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Control+h')
    await expect(src).toHaveAttribute('aria-selected', 'true')

    // None of the strokes reached the global replace / quick-open commands.
    await expect.poll(() => workbench.getContextKey<boolean>('findWidgetVisible')).toBe(false)
    await expect.poll(() => workbench.getContextKey<boolean>('quickInputVisible')).toBe(false)
    await expect(page.locator('[role="tree"][data-focused="true"]').first()).toBeVisible()

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
