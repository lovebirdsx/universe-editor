/*---------------------------------------------------------------------------------------------
 *  Open Recent onto a vanished local folder: the main-process guard probes the
 *  folder before opening, removes it from recents, and aborts. The same guard
 *  covers the new-window path. Native dialogs are suppressed under E2E (the
 *  probe call would otherwise hang on the modal), which these tests also rely
 *  on implicitly: any failure to suppress shows up as a timeout here.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs'
import * as path from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

function toFsPath(dir: string): string {
  return dir.replace(/\\/g, '/')
}

test.describe('workspace open recent missing folder', () => {
  test('aborts opening a deleted local folder and drops it from recents @p0', async ({
    workbench,
    scratchDir,
  }) => {
    await workbench.waitForRestored()
    const root = scratchDir('ue2-recent-missing-')
    const folderA = path.join(root, 'a')
    const folderB = path.join(root, 'b')
    fs.mkdirSync(folderA)
    fs.mkdirSync(folderB)
    const aPath = toFsPath(folderA)
    const bPath = toFsPath(folderB)

    await workbench.openWorkspace(folderA)
    await expect.poll(() => workbench.getCurrentWorkspacePath(), { timeout: 8000 }).toBe(aPath)
    await expect.poll(() => workbench.getRecentWorkspacePaths(), { timeout: 8000 }).toContain(aPath)

    // Switch the same window to B; A stays in recents.
    await workbench.openWorkspace(folderB)
    await expect.poll(() => workbench.getCurrentWorkspacePath(), { timeout: 8000 }).toBe(bPath)
    await expect.poll(() => workbench.getRecentWorkspacePaths(), { timeout: 8000 }).toContain(aPath)

    // A was a live workspace moments ago; Windows can still hold watcher
    // handles, so retry the delete instead of racing EPERM.
    fs.rmSync(folderA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    await workbench.openWorkspace(folderA)

    // The window kept B and A was pruned from recents.
    expect(await workbench.getCurrentWorkspacePath()).toBe(bPath)
    await expect
      .poll(() => workbench.getRecentWorkspacePaths(), { timeout: 8000 })
      .not.toContain(aPath)
  })

  test('a missing folder opened in a new window creates no window and is not added @p0', async ({
    workbench,
    scratchDir,
  }) => {
    await workbench.waitForRestored()
    const root = scratchDir('ue2-recent-missing-nw-')
    const missing = path.join(root, 'never-existed')
    const missingPath = toFsPath(missing)
    const windowsBefore = (await workbench.getOpenWindows()).length

    await workbench.openFolderInNewWindow(missing)

    // openFolderInNewWindow resolves only after main finished probing, so a new
    // window appearing later is not a race we can miss here.
    expect((await workbench.getOpenWindows()).length).toBe(windowsBefore)
    expect(await workbench.getRecentWorkspacePaths()).not.toContain(missingPath)
  })
})
