/*---------------------------------------------------------------------------------------------
 *  Smoke spec: Explorer DnD — drag a file to a subdirectory (P1).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { test, expect } from '../fixtures/sharedApp.js'

test.describe('@p1 explorer drag-and-drop', () => {
  // @flaky: HTML5 drag-and-drop gesture delivery is timing-sensitive under
  // Playwright + Electron headless (no GPU, 2-core CI runners). The move itself
  // is sound; the synthesized dragTo occasionally lands before the tree row is
  // droppable. Runs in a separate non-blocking CI pass — see e2e/RUNBOOK.md §2.
  test('drag file to subdirectory moves it', { tag: '@flaky' }, async ({ workbench }) => {
    // Create a temp workspace with one file and one subdirectory.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-dnd-'))
    await fs.writeFile(path.join(tmpDir, 'file.txt'), 'hello')
    await fs.mkdir(path.join(tmpDir, 'subdir'))

    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    // Wait for explorer tree to render the workspace contents.
    await expect
      .poll(() => workbench.getContextKey<boolean>('sideBarVisible'), { timeout: 5000 })
      .toBe(true)

    const sourceRow = workbench.page.locator('[role="treeitem"]', { hasText: 'file.txt' })
    const targetRow = workbench.page.locator('[role="treeitem"]', { hasText: 'subdir' })

    await expect(sourceRow).toBeVisible({ timeout: 5000 })
    await expect(targetRow).toBeVisible({ timeout: 5000 })

    // Native drag-and-drop via Playwright.
    await sourceRow.dragTo(targetRow)

    // Allow time for file service to propagate the rename.
    await workbench.page.waitForTimeout(800)

    const rootExists = await fs
      .access(path.join(tmpDir, 'file.txt'))
      .then(() => true)
      .catch(() => false)
    const subdirExists = await fs
      .access(path.join(tmpDir, 'subdir', 'file.txt'))
      .then(() => true)
      .catch(() => false)

    expect(rootExists).toBe(false)
    expect(subdirExists).toBe(true)

    // Cleanup. The app still holds this workspace open (the fixture closes it
    // after the test returns), so on Windows rmdir can hit EBUSY — retry it.
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
