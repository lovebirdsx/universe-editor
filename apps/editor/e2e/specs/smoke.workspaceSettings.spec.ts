/*---------------------------------------------------------------------------------------------
 *  Smoke spec: Settings UX — User/Workspace tab switching (P1).
 *
 *  Verifies:
 *    1. `openWorkspaceSettings` command opens the Settings editor.
 *    2. `openWorkspaceSettings` without workspace shows the editor (Workspace tab disabled).
 *    3. Without a workspace open, clicking the Workspace tab shows an Info notification.
 *    4. `openWorkspaceSettings` with workspace open activates the Workspace tab.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

test.describe('@p1 workspace settings UX', () => {
  test('openWorkspaceSettings opens Settings editor', async ({ workbench }) => {
    await workbench.waitForRestored()

    // Fire-and-forget to avoid deadlock (action opens editor asynchronously).
    await workbench.page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.openWorkspaceSettings')
    })

    await expect
      .poll(() => workbench.getActiveEditorUri(), { timeout: 5000 })
      .toMatch(/universe:\/settings/)
  })

  test('Workspace tab is visible in Settings editor', async ({ workbench }) => {
    await workbench.waitForRestored()

    await workbench.page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.openWorkspaceSettings')
    })

    await expect(workbench.page.getByRole('button', { name: 'User' })).toBeVisible({
      timeout: 5000,
    })
    await expect(workbench.page.getByRole('button', { name: 'Workspace' })).toBeVisible({
      timeout: 5000,
    })
  })

  test('no-workspace: clicking Workspace tab shows notification', async ({ workbench }) => {
    await workbench.waitForRestored()

    await workbench.page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.openSettings')
    })
    await expect
      .poll(() => workbench.getActiveEditorUri(), { timeout: 5000 })
      .toMatch(/universe:\/settings/)

    // Wait for the tab strip to render.
    await expect(workbench.page.getByRole('button', { name: 'Workspace' })).toBeVisible({
      timeout: 3000,
    })

    // Click Workspace tab — no workspace is open, should show Info toast.
    await workbench.page.getByRole('button', { name: 'Workspace' }).click()

    await expect(
      workbench.page.locator('[data-testid="notification-toast-item"]').first(),
    ).toBeVisible({ timeout: 3000 })
  })

  test('openWorkspaceSettings when workspace open activates Workspace tab', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()
    const tmpDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-ws-settings-'))
    await workbench.openWorkspace(tmpDir)
    await expect
      .poll(() => workbench.getCurrentWorkspacePath(), { timeout: 5000 })
      .toBeTruthy()

    await workbench.page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.openWorkspaceSettings')
    })

    await expect
      .poll(() => workbench.getActiveEditorUri(), { timeout: 5000 })
      .toMatch(/universe:\/settings/)

    // Workspace tab should be active — check via aria-selected (stable across CSS module hashing).
    const wsBtn = workbench.page.getByRole('button', { name: 'Workspace' })
    await expect(wsBtn).toBeVisible({ timeout: 5000 })
    await expect(wsBtn).toHaveAttribute('aria-selected', 'true', { timeout: 3000 })
  })
})
