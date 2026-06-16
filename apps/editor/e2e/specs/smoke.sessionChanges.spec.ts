/*---------------------------------------------------------------------------------------------
 *  Session Changes (会话级 diff) smoke test (@p1).
 *
 *  全链路烟雾：注入一个 stdio agent，它在 prompt 时把一个文件真实写到磁盘，并推送带
 *  `_meta.claudeCode.toolResponse.{filePath, structuredPatch}` 的 `Write` tool_call。断言：
 *    - SessionChangeTrackerService 记录该变更（读盘 current + 逆推 baseline）；
 *    - Session Editor 右上角出现 `diff` 入口图标（MenuId.EditorTitle，门控 acp.session）；
 *    - 点击入口打开 Session Changes 容器，CHANGES 列表渲染出被修改文件一行；
 *    - 点击该行打开整文件 diff editor（typeId='diff'）。
 *
 *  数据通路（agent → structuredPatch → tracker → Side Bar 列表 → diff editor）此前只有
 *  单测覆盖；本 spec 在真实打包产物里跑全链路。
 *
 *  注意: sessionDiffAgent.cjs 是源码（不经过构建），spec 直接拿源码绝对路径喂给探针。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SD_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'sessionDiffAgent.cjs')

const SHOW_CHANGES_CMD = 'workbench.action.agent.showSessionChanges'

test.describe('@p1 session changes', () => {
  test('a session Write surfaces a whole-file diff in the Session Changes list', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    // 1. 注入 session-diff agent 并设为默认。
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'sd',
      SD_AGENT_PATH,
    ] as const)

    // 2. newSession（默认 chat location 为 'editor'，会话作为全屏 editor 打开）。
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('acp.session')

    // 3. 右上角 Session Changes 入口图标可见（门控 activeEditorType=='acp.session'）。
    await expect(
      page.locator(`[data-testid="view-title-action-${SHOW_CHANGES_CMD}"]`),
    ).toBeVisible()

    // 4. 发送 prompt（agent 写盘 + 推送 Write structuredPatch）。
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('go'))

    // 5. 打开 Session Changes 容器，列表渲染出被修改文件一行。
    await page.evaluate(
      ([cmd]) => {
        void window.__E2E__!.runCommand(cmd)
      },
      [SHOW_CHANGES_CMD] as const,
    )
    await expect(page.getByTestId('acp-changes-row')).toHaveCount(1)
    await expect(page.getByTestId('acp-changes-row')).toHaveAttribute('data-status', 'modified')

    // 5b. 右上角列表/树切换按钮可见且可点（切到树形不应破坏列表）。
    const toggle = page.getByTestId('session-changes-toggle-view-mode')
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(page.getByTestId('acp-changes-row')).toHaveCount(1)
    await toggle.click()

    // 6. 点击行打开整文件 diff editor。
    await page.getByTestId('acp-changes-row').click()
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('diff')
  })
})
