/*---------------------------------------------------------------------------------------------
 *  AGENTS session-list scroll-restore repro (@p1).
 *
 *  在 SecondarySideBar 的 AGENTS 视图里，session 列表滚到中间，切到别的容器（Outline）
 *  再切回来，滚动位置应保持。切换容器会 unmount AgentsView → SessionListPanel，滚动位置
 *  由 ScrollStateCache 通过 useScrollRestore 保存/恢复。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const AGENTS_VIEW = 'workbench.view.agents.main'

test.describe('@p1 agents — session list scroll restore', () => {
  test('session list keeps its scroll position across a secondary-sidebar container switch @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    // Reveal the AGENTS view (SecondarySideBar).
    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.agent.openView'))
    await expect(page.locator(`[data-view-pane="${AGENTS_VIEW}"]`)).toBeVisible({ timeout: 5000 })

    // Seed enough sessions that the list overflows and can scroll.
    const N = 20
    for (let i = 0; i < N; i++) {
      await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.agent.newSession'))
    }
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 15000 })
      .toBe(N)

    const list = page.getByTestId('acp-session-list')
    await expect(list).toBeVisible()
    const scroller = page.locator('[data-testid="acp-session-list"] ul')
    await expect(scroller).toBeVisible()

    // Ensure the list is scrollable.
    await expect
      .poll(
        async () =>
          scroller.evaluate(
            (el) => (el as HTMLElement).scrollHeight - (el as HTMLElement).clientHeight,
          ),
        { timeout: 8000 },
      )
      .toBeGreaterThan(50)

    // Scroll to a mid position.
    const target = await scroller.evaluate((el) => {
      const s = el as HTMLElement
      s.scrollTop = Math.floor((s.scrollHeight - s.clientHeight) / 2)
      return s.scrollTop
    })
    expect(target).toBeGreaterThan(0)

    // Switch the SecondarySideBar to Outline (unmounts AgentsView) and back.
    await page.evaluate(() => window.__E2E__!.runCommand('outline.focus'))
    await expect(page.locator(`[data-view-pane="${AGENTS_VIEW}"]`)).toBeHidden({ timeout: 5000 })
    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.agent.openView'))
    await expect(page.locator(`[data-view-pane="${AGENTS_VIEW}"]`)).toBeVisible({ timeout: 5000 })

    const restored = page.locator('[data-testid="acp-session-list"] ul')
    await expect
      .poll(async () => restored.evaluate((el) => (el as HTMLElement).scrollTop), {
        timeout: 8000,
        intervals: [100],
      })
      .toBeGreaterThan(target - 40)
  })
})
