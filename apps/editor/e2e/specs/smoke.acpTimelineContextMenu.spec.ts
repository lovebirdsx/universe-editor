/*---------------------------------------------------------------------------------------------
 *  ACP timeline context menu — card-level rows (@p1).
 *
 *  复现/守卫：时间线上右键一张卡片时，菜单要能感知"点中了哪张卡"——
 *   1. 子 agent 卡（Task）在折叠状态下只提供「Expand Card and Children」，
 *      而「Focus Parent Card」「Open File」这类不适用于它的行不出现；
 *   2. 点「Expand/Collapse Card and Children」会**一次写入整棵子树**的折叠 override：
 *      重新展开父卡后，子卡仍保持被折起——这正是单测覆盖不到的分裂点
 *      （菜单 when 走 per-group scoped ctx、批量 override 落到共享 store、
 *       折叠态经 persistence 回读，三者在真实产物里必须一致）；
 *   3. 顶部粘性条这个**第二个菜单宿主**右键时仍能看到 Copy Message ——
 *      该行带 `precondition: ACP_NAV_WHEN`，而右键粘性条时 DOM 焦点本不在聊天里，
 *      宿主不把焦点拉回 timeline 它就会静默消失（既有 bug 的回归守卫）。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

test.describe('@p1 acp timeline context menu', () => {
  test('a sub-agent card offers its own rows and folds its whole subtree', async ({
    page,
    workbench,
  }) => {
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

    // A Task card carrying a child message and two child tool calls.
    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('emit-subagent-mixed:2x1'))
    const card = page.locator('[data-timeline-key^="t:tcSub"]').first()
    await expect(card).toBeVisible({ timeout: 10000 })
    // The card's own header row — an expanded card's centre sits on a *child*
    // card, and a right-click there must target the child, not the parent.
    const header = card.locator('> [data-testid="acp-collapsible-toggle"]')

    // 1. Rows that only make sense on a sub-agent parent card.
    await header.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Copy Sub-Agent Transcript' })).toBeVisible({
      timeout: 3000,
    })
    await expect(page.getByRole('menuitem', { name: 'Expand Card and Children' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Collapse Card and Children' })).toHaveCount(0)
    // Unfolding / descending is what the card offers; folding back out is not —
    // it is a top-level card, and not a whole-file write either.
    await expect(page.getByRole('menuitem', { name: 'Unfold Card or Step Into It' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Fold Card or Step Out' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Open File' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    // 2. Expand it, and check the child cards' baseline: a sub-agent message is
    //    expanded by default under the `default` collapse mode.
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    const childMessage = card.locator('[data-testid="acp-subagent-message"]').first()
    await expect(childMessage).toBeVisible()
    const childHeader = childMessage.locator('> [data-testid="acp-collapsible-toggle"]')
    await expect(childHeader).toHaveAttribute('aria-expanded', 'true')

    // 2b. The mirror image on a nested card: it can fold and step back out to its
    //     parent, but it is not itself a sub-agent parent.
    await childHeader.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Fold Card or Step Out' })).toBeVisible({
      timeout: 3000,
    })
    await expect(page.getByRole('menuitem', { name: 'Unfold Card or Step Into It' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Copy Sub-Agent Transcript' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    // 3. Now the row the card was expanded for: one write folds parent + children.
    await header.click({ button: 'right' })
    const collapseAll = page.getByRole('menuitem', { name: 'Collapse Card and Children' })
    await expect(collapseAll).toBeVisible({ timeout: 3000 })
    await collapseAll.click()
    await expect(header).toHaveAttribute('aria-expanded', 'false')

    // 4. Re-open just the parent card: the children must stay folded, which is
    //    only true if the subtree write landed in the shared override store
    //    (their own defaults say "expanded").
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    await expect(childHeader).toHaveAttribute('aria-expanded', 'false')
  })

  test('right-clicking the sticky user bar still offers Copy Message', async ({
    page,
    workbench,
  }) => {
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

    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('hello from the test'))
    const bar = page.getByTestId('acp-user-bar')
    await expect(bar).toBeVisible({ timeout: 10000 })

    await bar.click({ button: 'right' })
    // `Copy Message` is gated on ACP_NAV_WHEN — the bar must pull DOM focus back
    // into the timeline, or this row silently disappears.
    await expect(page.getByRole('menuitem', { name: 'Copy Message' })).toBeVisible({
      timeout: 3000,
    })
    // And the bar describes itself as the card it is, so the card rows come too
    // (a user message is expanded by default).
    await expect(page.getByRole('menuitem', { name: 'Collapse Card' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Rewind to Here' })).toHaveCount(0)
  })
})
