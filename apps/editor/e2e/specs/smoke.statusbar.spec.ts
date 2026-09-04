/*---------------------------------------------------------------------------------------------
 *  标题栏 agent 按钮 + 状态栏 AI 按钮（P1）。
 *
 *  - 标题栏右侧：`+` 新建会话（titlebar-new-session）与 Agent 图标选择默认
 *    Agent（titlebar-select-agent，只切类型不建会话）
 *  - 状态栏右下角：✨ AI 快捷设置（statusbar-entry-ai / statusbar-ai-button），
 *    向上弹浮层，Escape 关闭
 *
 *  ACP 会话是 main 进程态，必须用冷启 fixture（electronApp），sharedApp 的
 *  window reload 复位不了 session 数。
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/electronApp.js'

test.describe('@p1 agent session buttons', () => {
  test('status bar AI button opens quick settings', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await expect(page.getByTestId('statusbar-entry-ai')).toBeVisible()
    await expect(page.getByTestId('statusbar-ai-button')).toBeVisible()

    await page.getByTestId('statusbar-ai-button').click()
    await expect(page.getByTestId('ai-quick-settings')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('ai-quick-settings')).toHaveCount(0)
  })

  test('the new-session button creates a session', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await expect(page.getByTestId('titlebar-new-session')).toBeVisible()
    expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(0)

    await page.getByTestId('titlebar-new-session').click()

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)
  })

  test('choose-agent only switches the default without creating a session', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await expect(page.getByTestId('titlebar-select-agent')).toBeVisible()
    expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(0)

    await page.getByTestId('titlebar-select-agent').click()
    await workbench.quickInput.waitForVisible()

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()

    // Guard the new semantics: selecting (or cancelling) an agent must never
    // create a session on its own — the `+` button owns session creation.
    expect(await page.evaluate(() => window.__E2E__!.getAcpSessionCount())).toBe(0)
  })
})
