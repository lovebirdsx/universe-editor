/*---------------------------------------------------------------------------------------------
 *  ACP friendly session title (@p1).
 *
 *  全链路守卫：agent 在回合结束时推送 `session_info_update`（携带友好标题），
 *  渲染端应把它写入持久化历史，活动会话的解析标题随之更新。echoAgent 模拟真实
 *  Claude agent 的行为（真实 agent 从 SDK `getSessionInfo().summary` 取自动标题），
 *  二者走的是同一条渲染端接收管线，故本 spec 守卫整条链路。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

test.describe('@p1 agents — friendly session title', () => {
  test('agent session_info_update updates the active session title', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)

    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('summarize the universe'))

    // echoAgent pushes `Echo: <prompt>` via session_info_update once the turn
    // settles. The resolved title should reflect it (history title wins over the
    // initial timestamp-derived live title).
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveAcpSessionTitle()), { timeout: 5000 })
      .toBe('Echo: summarize the universe')
  })
})
