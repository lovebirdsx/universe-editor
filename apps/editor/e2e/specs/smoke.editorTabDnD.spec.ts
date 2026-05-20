/*---------------------------------------------------------------------------------------------
 *  Smoke spec: Editor Tab DnD — drag a tab to another group (P1).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { test, expect } from '../fixtures/electronApp.js'

test.describe('@p1 editor tab drag-and-drop', () => {
  test('drag tab to another group moves the editor', async ({ workbench }) => {
    // Create a temp workspace with two files.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-tabdnd-'))
    await fs.writeFile(path.join(tmpDir, 'alpha.txt'), 'alpha')
    await fs.writeFile(path.join(tmpDir, 'beta.txt'), 'beta')

    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    await expect
      .poll(() => workbench.getContextKey<boolean>('sideBarVisible'), { timeout: 5000 })
      .toBe(true)

    // Open alpha.txt in the default group.
    const alphaRow = workbench.page.locator('[role="treeitem"]', { hasText: 'alpha.txt' })
    await expect(alphaRow).toBeVisible({ timeout: 5000 })
    await alphaRow.dblclick()

    // Split the editor to create a second group.
    await workbench.page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.splitEditorRight')
    })

    // Open beta.txt in the second group.
    const betaRow = workbench.page.locator('[role="treeitem"]', { hasText: 'beta.txt' })
    await expect(betaRow).toBeVisible({ timeout: 5000 })
    await betaRow.dblclick()

    // Get tab bars from both groups.
    const tabBars = workbench.page.locator('[data-testid="editor-group-tabbar"]')
    await expect(tabBars).toHaveCount(2, { timeout: 5000 })

    const firstTabBar = tabBars.nth(0)
    const secondTabBar = tabBars.nth(1)

    // beta.txt tab should be in the second group.
    const betaTab = secondTabBar.locator('[role="tab"]', { hasText: 'beta.txt' })
    await expect(betaTab).toBeVisible({ timeout: 3000 })

    // Drag beta.txt tab to the first group's tab bar.
    await betaTab.dragTo(firstTabBar)

    await workbench.page.waitForTimeout(500)

    // Now both files should be in the first group.
    const betaTabInSecond = secondTabBar.locator('[role="tab"]', { hasText: 'beta.txt' })
    await expect(betaTabInSecond).toBeHidden({ timeout: 3000 })

    const betaTabInFirst = firstTabBar.locator('[role="tab"]', { hasText: 'beta.txt' })
    await expect(betaTabInFirst).toBeVisible({ timeout: 3000 })

    // Cleanup.
    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})
