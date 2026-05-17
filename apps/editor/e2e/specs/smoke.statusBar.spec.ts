/*---------------------------------------------------------------------------------------------
 *  S5 — StatusBar is visible and reports at least one entry (P1).
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/electronApp.js'

test.describe('@p1 statusbar', () => {
  test('statusbar is visible after Ready and probe reports entries', async ({ workbench }) => {
    await expect(workbench.statusBar.root).toBeVisible()

    // 一些 status bar contribution 在 Restored 阶段挂上,
    // 用 polling 避免与 phase 转换竞速.
    await expect.poll(() => workbench.statusBar.entriesFromProbe().then((e) => e.length)).toBeGreaterThan(0)
  })
})
