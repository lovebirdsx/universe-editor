/*---------------------------------------------------------------------------------------------
 *  ACP agent smoke test (@p1).
 *
 *  全链路烟雾：注入一个 stdio JSON-RPC echo agent，命令面板触发 newSession，
 *  发送 prompt，断言 messages 流式渲染 + 工具调用生命周期。
 *
 *  注意: echoAgent.cjs 是源码（不经过构建），spec 直接拿源码绝对路径喂给探针，
 *  跳过任何 npm 全局依赖。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

test.describe('@p1 agents', () => {
  test('newSession + sendPrompt → messages stream and tool_call completes', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    // 1. 注入 echo agent 并设为默认。
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    // 2. 命令面板触发 newSession（fire-and-forget — createSession 内含 spawn + initialize）。
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })

    // 3. 等待 session 出现。
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)

    // 4. 发送 prompt 并等待回合结束。
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('hello'))

    // 5. 消息序列应该是: user 'hello' + agent 'echo: hello'。
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 5000 })
      .toEqual([
        { role: 'user', text: 'hello' },
        { role: 'agent', text: 'echo: hello' },
      ])

    // 6. 工具调用应在 prompt 完成后处于 completed 状态。
    const toolCalls = await page.evaluate(() => window.__E2E__!.getAcpToolCalls())
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toMatchObject({
      title: 'echo',
      status: 'completed',
      text: 'hello',
    })
  })
})
