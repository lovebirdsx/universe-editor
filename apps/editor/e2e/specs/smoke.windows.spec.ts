/*---------------------------------------------------------------------------------------------
 *  Multi-window / multi-workspace smoke (P0).
 *
 *  Covers the VSCode-consistent capabilities added on top of "one window =
 *  one workspace":
 *    - Open Folder in New Window (bypassing the native dialog via the probe)
 *    - getOpenWindows tracking (backs Switch Window + Open Recent open-state icons)
 *    - Open Recent marks the workspace already open in a window
 *    - Remove from Recently Opened
 *    - Exit (workbench.action.quit) closes every window
 *
 *  Multi-window outcomes live in the main-process IWindowsService, so these
 *  specs drive the probe's window helpers rather than the DOM. New windows
 *  inherit the E2E probe because createWindow forwards --enable-e2e-probe.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'
import type { Page } from '@playwright/test'

// URI.fsPath returns forward slashes in this codebase; normalize to match.
function tmpFolder(): { dir: string; fsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-win-'))
  return { dir, fsPath: dir.replace(/\\/g, '/') }
}

async function waitForProbe(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
  )
  await page.evaluate(() => window.__E2E__!.whenRestored())
}

test.describe('@p0 windows', () => {
  test('Open Folder in New Window creates a second window loading that folder', async ({
    electronApp,
    workbench,
  }) => {
    await workbench.waitForRestored()
    const folder = tmpFolder()

    const newWindow = electronApp.waitForEvent('window')
    await workbench.openFolderInNewWindow(folder.dir)
    const newPage = await newWindow
    await waitForProbe(newPage)

    await expect
      .poll(() => newPage.evaluate(() => window.__E2E__!.getCurrentWorkspacePath()), {
        timeout: 8000,
      })
      .toBe(folder.fsPath)
  })

  test('getOpenWindows tracks every open window', async ({ electronApp, workbench }) => {
    await workbench.waitForRestored()
    const folder = tmpFolder()

    const newWindow = electronApp.waitForEvent('window')
    await workbench.openFolderInNewWindow(folder.dir)
    await waitForProbe(await newWindow)

    await expect
      .poll(() => workbench.getOpenWindows().then((w) => w.length), { timeout: 8000 })
      .toBe(2)
    const windows = await workbench.getOpenWindows()
    expect(windows.map((w) => w.folder)).toContain(folder.fsPath)
  })

  test('Open Recent marks the workspace already open in a window', async ({ workbench, page }) => {
    await workbench.waitForRestored()
    const folder = tmpFolder()
    await workbench.openWorkspace(folder.dir)
    await expect
      .poll(() => workbench.getCurrentWorkspacePath(), { timeout: 5000 })
      .toBe(folder.fsPath)

    // showCommands-style action awaits the quick pick → fire-and-forget.
    void page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.openRecent'))

    await workbench.quickInput.waitForVisible()
    await expect(
      workbench.quickInput.dialog.locator('[data-testid="quick-input-item-icon-slot"]').first(),
    ).toHaveAttribute('data-icon-id', 'check')

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })

  test('Remove from Recently Opened drops the entry from the recent list', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()
    const folder = tmpFolder()
    await workbench.openWorkspace(folder.dir)
    await expect
      .poll(() => workbench.getRecentWorkspacePaths().then((p) => p.includes(folder.fsPath)), {
        timeout: 5000,
      })
      .toBe(true)

    await workbench.removeRecentWorkspace(folder.dir)
    await expect
      .poll(() => workbench.getRecentWorkspacePaths().then((p) => p.includes(folder.fsPath)), {
        timeout: 5000,
      })
      .toBe(false)
  })

  test('Exit closes every window', async ({ electronApp, workbench, page }) => {
    await workbench.waitForRestored()

    const newWindow = electronApp.waitForEvent('window')
    await workbench.openFolderInNewWindow(tmpFolder().dir)
    await waitForProbe(await newWindow)
    expect(electronApp.windows().length).toBe(2)

    // app.quit() tears down the process; fire-and-forget and watch windows drain.
    void page
      .evaluate(() => void window.__E2E__!.runCommand('workbench.action.quit'))
      .catch(() => {})

    await expect.poll(() => electronApp.windows().length, { timeout: 8000 }).toBe(0)
  })
})
