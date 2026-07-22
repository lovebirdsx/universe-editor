/*---------------------------------------------------------------------------------------------
 *  MCP observability smoke test (@p1).
 *
 *  全链路烟雾：注入一个 stdio JSON-RPC agent，它在 prompt 时通过
 *  `_claude/sdkMessage` extNotification 推送 Claude SDK system-init 的 MCP 快照，
 *  并跑一个带 `_meta.claudeCode.toolName='mcp__fs__read_file'` 的 tool_call。断言：
 *    - 快照流到 session.mcpServers（真实连接状态 connected/failed）；
 *    - 工具调用被归因到来源 server（mcpServer==='fs'）；
 *    - 标题栏 AI 按钮的 tooltip 汇总 MCP 连接状态；
 *    - 打开 Agents 容器后 MCP Servers view 渲染出每个 server 一行。
 *
 *  注意: mcpAgent.cjs 是源码（不经过构建），spec 直接拿源码绝对路径喂给探针。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MCP_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'mcpAgent.cjs')

test.describe('@p1 mcp servers', () => {
  test('prompt surfaces MCP snapshot, attributes tool calls, and updates the UI', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    // 1. 注入 MCP agent 并设为默认。
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'mcp',
      MCP_AGENT_PATH,
    ] as const)

    // 2. 命令面板触发 newSession（fire-and-forget — createSession 内含 spawn + initialize）。
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })

    // 3. 等待 session 出现。
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)

    // 4. 发送 prompt 并等待回合结束（agent 在这一回合推快照 + 跑工具调用）。
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('go'))

    // 5. MCP 快照应一路流到 session.mcpServers（按名排序后断言，避免顺序耦合）。
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            window
              .__E2E__!.getAcpMcpServers()
              .map((s) => ({ name: s.name, status: s.status }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          ),
        { timeout: 5000 },
      )
      .toEqual([
        { name: 'docs', status: 'failed' },
        { name: 'fs', status: 'connected' },
      ])

    // 6. MCP 工具调用应被归因到来源 server。
    const toolCalls = await page.evaluate(() => window.__E2E__!.getAcpToolCalls())
    const fsCall = toolCalls.find((t) => t.mcpServer === 'fs')
    expect(fsCall).toMatchObject({ title: 'read_file', status: 'completed' })

    // 7. 标题栏 AI 按钮：MCP 信息只进 tooltip（状态栏 AI 入口已迁到标题栏）。
    const aiTooltip = page.getByTestId('titlebar-ai-button')
    await expect(aiTooltip).toHaveAttribute('title', /MCP 1\/2 connected/)
    await expect(aiTooltip).toHaveAttribute('title', /1 failed/)

    // 8. 打开 Agents 容器后，MCP Servers view 每个 server 渲染一行。
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.openView')
    })
    await expect(page.getByTestId('acp-mcp-row')).toHaveCount(2)
  })
})
