/*---------------------------------------------------------------------------------------------
 *  MCP 工具调用「重放」调试器（@p1）。
 *
 *  走一遍真实链路：会话里出现一张带 MCP 归因、带 rawInput 的卡片 → 点卡片上的重放
 *  按钮 → 二次确认 → 独立调试页签连上真的 MCP server（fixture 子进程，stdio）→
 *  列工具、改参数重发、看 server 自己的 isError 回复。
 *
 *  与 smoke.mcpServers 的分工：那条守「agent 报上来的 MCP 快照如何流到 UI」，这条
 *  守「编辑器自己 dial 出去的那条连接」——两条路径没有任何共用代码，agent fixture
 *  在这里只负责产出卡片（它报的 fs/docs 快照与本用例无关，本用例的 `fs` 来自
 *  `acp.mcpServers`）。
 *
 *  卡片上的工具名是 `read_file`（`mcp__fs__read_file` 拆出来的），而 fixture server
 *  只提供 echo / fail —— 打开面板后的自动重发因此必然被 server 拒绝，这正好是第一条
 *  断言：服务端拒绝要显示成 server 的回复，而不是编辑器故障。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MCP_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'mcpAgent.cjs')
const MCP_DEBUG_SERVER_PATH = resolve(
  __dirname,
  '..',
  '..',
  'src',
  'test-fixtures',
  'mcpDebugServer.cjs',
)

test.describe('@p1 mcp tool replay', () => {
  test('replays a card call in a debugger tab and re-runs it with edited args', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    // 1. 真的 MCP server：零依赖 fixture，用系统 node 跑（子进程 env 过 denylist，
    //    不能借 ELECTRON_RUN_AS_NODE 用编辑器自带的 runtime）。
    await page.evaluate(
      (p) =>
        window.__E2E__!.updateConfigValue('acp.mcpServers', { fs: { command: 'node', args: [p] } }),
      MCP_DEBUG_SERVER_PATH,
    )

    // 2. agent fixture 产出一张 MCP 归因卡片（带 rawInput）。
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'mcp',
      MCP_AGENT_PATH,
    ] as const)
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('acp.session')
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('go'))

    // 3. 卡片顶栏的重放按钮。
    const replay = page.getByTestId('acp-toolcall-mcp-replay')
    await expect(replay).toBeVisible({ timeout: 10000 })

    // 3b. 顶栏右侧的 ▶ / ⏱Ns / ✓ / ⌄ 必须落在同一条中心线上。四者分属三个容器
    //     （卡片标题行 / header 直挂的状态图标 / CollapsibleSlot 的折叠箭头），
    //     曾经一行里并存两套竖直对齐模型 —— 图标按钮与 ✓/⌄ 居中、耗时行随标题
    //     基线 —— 症状是耗时行高出中线约 2px。纯布局问题单测（happy-dom 不做布局）
    //     看不见，只有真渲染出的 rect 能守。
    const header = page.getByTestId('acp-collapsible-toggle').filter({ has: replay })
    const centres = await header.evaluate((el) =>
      [
        '[data-testid="acp-toolcall-mcp-replay"]',
        '[data-testid="acp-subagent-stats"]',
        '[role="img"]',
        '[class*="slotChevron"]',
      ].map((selector) => {
        const box = el.querySelector(selector)!.getBoundingClientRect()
        return box.top + box.height / 2
      }),
    )
    // 1px 容差：rect 的亚像素取整，外加 Check 路径在 24 单位画布里的 0.5 单位不对称。
    expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(1)

    await replay.click()

    // 4. 二次确认：写清连的是谁、跑的是什么，并点明绕过 agent 的权限确认。
    const dialog = page.locator('[data-renderer-dialog]')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Run MCP tool "read_file" on "fs"?')
    await expect(dialog).toContainText('bypassing the agent')
    await dialog.getByRole('button', { name: 'Run Tool' }).click()

    // 5. 独立调试页签（不是会话页签），连上后列出 server 的工具。
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('mcp.debug')
    const state = page.getByTestId('mcp-debug-panel-connection-state')
    await expect(state).toHaveAttribute('data-state', 'connected', { timeout: 20000 })
    await expect(page.getByTestId('mcp-debug-panel-tool-row')).toHaveCount(2)

    // 6. 自动重发用的是卡片上的 read_file，fixture 没有这个工具 —— server 的拒绝
    //    必须原样显示（这是 server 的回复，不是编辑器连不上，也不是「协议被破坏」）。
    const errorBanner = page.getByTestId('mcp-debug-panel-error')
    await expect(errorBanner).toContainText(/unknown tool/i, { timeout: 20000 })
    await expect(errorBanner).toContainText(/rejected the call/i)
    await expect(errorBanner).not.toContainText(/broke the MCP protocol/i)

    // 7. 换成 echo，改参数重发：结果里能看到回显，结构化内容也在。
    await page.getByTestId('mcp-debug-panel-tool-row').filter({ hasText: 'Echo' }).click()
    await page.getByTestId('mcp-debug-panel-params-input').fill('{"text": "hello"}')
    await page.getByTestId('mcp-debug-panel-call').click()
    const response = page.getByTestId('mcp-debug-panel-response')
    await expect(response).toContainText('echo: hello', { timeout: 20000 })
    await expect(response).toHaveAttribute('data-is-error', 'false')
    await expect(response).toContainText('"echoed": "hello"')

    // 8. fail 的 isError 是 server 自己的回复：走 warning 样式，不冒充编辑器故障。
    await page.getByTestId('mcp-debug-panel-tool-row').filter({ hasText: 'Fail' }).click()
    await page.getByTestId('mcp-debug-panel-params-input').fill('{"message": "boom"}')
    await page.getByTestId('mcp-debug-panel-call').click()
    await expect(response).toHaveAttribute('data-is-error', 'true', { timeout: 20000 })
    await expect(response).toContainText('ERROR: boom')
    await expect(response).toContainText('not an editor failure')

    // 9. 每次调用都进历史（自动重发 + 两次手发）。
    await expect(page.getByTestId('mcp-debug-panel-history-row')).toHaveCount(3)

    // 10. 会话那边不受影响：调试页签是旁路，卡片、会话状态都不动。
    const calls = await page.evaluate(() => window.__E2E__!.getAcpToolCalls())
    expect(calls.find((call) => call.mcpServer === 'fs')?.title).toBe('read_file')
    await expect.poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus())).toBe('idle')
  })
})
