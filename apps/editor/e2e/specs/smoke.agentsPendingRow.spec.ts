/*---------------------------------------------------------------------------------------------
 *  Optimistic pending session row (@p1).
 *
 *  回归守护：新建 session 的列表行必须在点击后立即出现（connecting 状态），
 *  握手完成后无缝换成 durable history 行——不能等 spawn + initialize +
 *  session/new 全部结束（codex 在 Windows git 仓库下超过 10s）。echo agent
 *  经 ECHO_AGENT_SESSION_NEW_DELAY_MS 把 session/new 拖到 3s，制造可断言的
 *  connecting 窗口。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const AGENTS_VIEW = 'workbench.view.agents.main'

test.describe('@p1 agents — optimistic pending session row', () => {
  test('pending row appears instantly, then swaps to the durable row', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    await page.evaluate(
      ([id, p]) =>
        window.__E2E__!.installAcpEchoAgent(id, p, { ECHO_AGENT_SESSION_NEW_DELAY_MS: '3000' }),
      ['echo', ECHO_AGENT_PATH] as const,
    )

    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.agent.openView'))
    await expect(page.locator(`[data-view-pane="${AGENTS_VIEW}"]`)).toBeVisible({ timeout: 5000 })

    // Fire-and-forget: createSession returns synchronously; the 3s session/new
    // runs in the background.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })

    // The optimistic row is up long before the handshake completes.
    const pendingRow = page.locator('li[data-testid^="session-row-"][data-pending="true"]')
    await expect(pendingRow).toHaveCount(1, { timeout: 3000 })
    await expect(pendingRow.locator('[data-status="connecting"]')).toBeVisible()

    // After the delayed session/new lands, the pending row is replaced by the
    // durable history row (keyed by the agent-issued id) — never two rows.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), { timeout: 15000 })
      .toBe('idle')
    await expect(pendingRow).toHaveCount(0)
    const durableRow = page.locator('li[data-testid^="session-row-echo-"]')
    await expect(durableRow).toHaveCount(1)
    await expect(durableRow).toHaveAttribute('data-pending', 'false')
  })
})
