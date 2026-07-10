/*---------------------------------------------------------------------------------------------
 *  View reorder + expand rendering smoke test (@p1).
 *
 *  复现并守护一个纯粹的 view 拖动重排 bug（与具体 view 类型无关）：
 *   1. 在一个含 2 个 view 的容器里，把下面的 view 拖到上面（纯重排，集合不变）。
 *   2. 之后展开原本在下、现在在上的 view。
 *
 *  Bug：Allotment 的「纯重排」协调路径不同步内部的 per-pane 尺寸约束（min/max）
 *  与 previous-keys，导致随后展开时把尺寸约束应用到错误的 pane —— 被展开的 view
 *  反而被压成 header 高度、另一个折叠的 view 却占满容器（见问题里的第三张图）。
 *
 *  这里通过 window.__E2E__ 探针直接驱动 IViewDescriptorService 的重排 + 折叠，
 *  再用真实 DOM 几何断言「被展开的 pane 明显高于折叠的 pane」。
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/electronApp.js'

const CONTAINER = 'workbench.view.agents'
const AGENTS_VIEW = 'workbench.view.agents.main'
const MCP_VIEW = 'workbench.view.agents.mcp'

function paneHeight(page: import('@playwright/test').Page, viewId: string): Promise<number> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-view-pane="${id}"]`)
    return el ? Math.round(el.getBoundingClientRect().height) : -1
  }, viewId)
}

test.describe('@p1 view reorder', () => {
  test('expanding a reordered view gives it the space, not the collapsed sibling @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    // Reveal the Agents container (SecondarySideBar) so both view panes mount.
    await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.agent.openView'))
    await expect(page.locator(`[data-view-pane="${AGENTS_VIEW}"]`)).toBeVisible({ timeout: 5000 })
    await expect(page.locator(`[data-view-pane="${MCP_VIEW}"]`)).toBeVisible()

    // Default order: AGENTS (order 1) above MCP SERVERS (order 2).
    const initialOrder = await page.evaluate(
      (id) => window.__E2E__!.getViewIdsByContainer(id),
      CONTAINER,
    )
    expect(initialOrder).toEqual([AGENTS_VIEW, MCP_VIEW])

    // Start from both collapsed (matches the reported repro: both panes collapsed).
    await page.evaluate((id) => window.__E2E__!.setViewCollapsed(id, true), AGENTS_VIEW)
    await page.evaluate((id) => window.__E2E__!.setViewCollapsed(id, true), MCP_VIEW)

    // Swap the two views by reordering: drop AGENTS after MCP → [MCP, AGENTS].
    await page.evaluate(
      ({ container, view, target }) => window.__E2E__!.moveViewInContainer(container, view, target),
      { container: CONTAINER, view: AGENTS_VIEW, target: MCP_VIEW },
    )
    await expect
      .poll(() => page.evaluate((id) => window.__E2E__!.getViewIdsByContainer(id), CONTAINER))
      .toEqual([MCP_VIEW, AGENTS_VIEW])

    // Now expand AGENTS (the reordered, bottom view). It must receive the freed
    // space; the still-collapsed MCP pane must stay at its ~28px header height.
    await page.evaluate((id) => window.__E2E__!.setViewCollapsed(id, false), AGENTS_VIEW)

    await expect
      .poll(() => paneHeight(page, AGENTS_VIEW), {
        timeout: 5000,
        message: 'expanded AGENTS pane should be tall, not pinned to its header',
      })
      .toBeGreaterThan(100)

    const mcpHeight = await paneHeight(page, MCP_VIEW)
    const agentsHeight = await paneHeight(page, AGENTS_VIEW)
    expect(mcpHeight).toBeLessThan(40) // collapsed sibling stays a header strip
    expect(agentsHeight).toBeGreaterThan(mcpHeight)
  })
})
