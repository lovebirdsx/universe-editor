/*---------------------------------------------------------------------------------------------
 *  S — Release notes (P1).
 *
 *  验证「Show Release Notes」命令打开 releaseNotes 类型的编辑器标签页。
 *  （升级后自动弹出的链路由单测覆盖；E2E 只冒烟手动命令的展示。）
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'

test.describe('@p1 release notes', () => {
  test('Show Release Notes opens a releaseNotes editor', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    await workbench.runCommand('workbench.action.showReleaseNotes')

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('releaseNotes')
  })
})
