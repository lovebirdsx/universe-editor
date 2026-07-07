/*---------------------------------------------------------------------------------------------
 *  S8 — Open Folder sets workspace state and reveals Explorer (P0).
 *
 *  workbench.openWorkspace(path) 绕过原生对话框，直接调用
 *  IWorkspaceService.openFolder(URI.file(path))，验证：
 *    - 工作区路径正确写入 workspaceService.current
 *    - 打开文件夹后侧栏展示 Explorer 视图
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/sharedApp.js'

const EXPLORER = 'workbench.view.explorer'

// @serial: every case here opens a workspace (parcel watcher subscribe on the
// main process). @parcel/watcher's windows backend has a cross-process native
// race — concurrent subscribes/unsubscribes from several e2e worker instances
// can fault (0xC0000005) the main process, surfacing elsewhere as "Target page
// has been closed". Pin to one worker (same root cause as smoke.outline /
// smoke.simpleFileDialog / smoke.folderDragNewWindow). See `pnpm e2e`.
test.describe('@p0 workspace', () => {
  test('openWorkspace sets current workspace path', { tag: '@serial' }, async ({ workbench }) => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-ws-'))
    // URI.fsPath always returns forward slashes; normalize tmpDir to match
    const expectedPath = tmpDir.replace(/\\/g, '/')

    await workbench.openWorkspace(tmpDir)

    // Event propagates from main → renderer before the IPC response arrives,
    // so the path should already be set. Poll defensively for CI timing.
    await expect
      .poll(() => workbench.getCurrentWorkspacePath(), { timeout: 5000 })
      .toBe(expectedPath)
  })

  test('openFolder action reveals Explorer sidebar', { tag: '@serial' }, async ({ workbench }) => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-ws-'))

    // WorkspaceExplorerRevealContribution is instantiated at AfterRestore phase.
    // Wait for Restored so the contribution is listening before we fire the event.
    await workbench.waitForRestored()

    // Fire-and-forget: the real OpenFolderAction shows a native dialog in
    // production. In tests we bypass it by using the probe directly.
    await workbench.openWorkspace(tmpDir)

    // Sidebar must become visible.
    await expect
      .poll(() => workbench.getContextKey<boolean>('sideBarVisible'), { timeout: 5000 })
      .toBe(true)

    // Explorer container must be active in the sidebar.
    await expect(workbench.sideBar.root).toHaveAttribute('data-active-view-container', EXPLORER)
  })
})
