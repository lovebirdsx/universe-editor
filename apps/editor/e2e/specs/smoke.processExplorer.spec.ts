/*---------------------------------------------------------------------------------------------
 *  Process Explorer smoke (P0).
 *
 *  验证「Developer: Open Process Explorer」命令打开进程管理器页签：
 *    - 面板根容器渲染
 *    - 首次采样后行数 ≥ 3（main / window / extension-host 等）
 *    - data-role="main" 的行恰有一行
 *  不覆盖 kill（破坏性操作，不进 @p0）。
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'

test.describe('@p0 process explorer', () => {
  test('opens via command and lists the process tree', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    await workbench.runCommand('workbench.action.openProcessExplorer')

    const root = page.locator('[data-testid="process-explorer"]')
    await expect(root).toBeVisible()

    const rows = root.locator('[data-testid="process-explorer-row"]')
    // First sample lands ~1s after mount; windows-process-tree CPU sampling can
    // take another ~1s, so give the poll generous headroom.
    await expect.poll(() => rows.count(), { timeout: 15000 }).toBeGreaterThanOrEqual(3)

    await expect.poll(() => root.locator('[data-role="main"]').count()).toBe(1)
  })
})
