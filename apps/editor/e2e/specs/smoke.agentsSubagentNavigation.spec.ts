/*---------------------------------------------------------------------------------------------
 *  Sub-agent card navigation smoke (@p1).
 *
 *  子 Agent 卡片（Task / Agent 工具调用）散落在时间线里后，需要三种快速定位入口：
 *   1. Alt+Shift+J / K 在顶层子 Agent 卡片间前后跳转（只聚焦卡头，不改折叠态），
 *      首尾环绕——末尾继续向后回到第一张，第一张继续向前回到最后一张；
 *   2. 右上角 `‹ 2/5 ›` 胶囊随滚动/键盘更新，箭头复用同一条跳转路径；
 *   3. Go to Symbol（@ / @:）把子 Agent 调用分区置顶，接受后聚焦对应卡片。
 *
 *  这是单测覆盖不到的真实链路：ACP_NAV_WHEN 的键盘门控、虚拟列表 reveal、
 *  胶囊对滚动容器的监听，以及 QuickPick 分区与 outline → slot key 的桥接。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'
import type { Page } from '@playwright/test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const SUBAGENT_CARDS = '[data-timeline-key^="t:tcSub"]'
const TWO_CARDS = ['emit-subagent-mixed:2x1', 'emit-subagent-mixed:2x1'] as const

/** Start a fresh echo session, send each prompt, and wait for one card per prompt. */
async function openSessionWithCards(
  page: Page,
  workbench: { waitForRestored: () => Promise<void> },
  prompts: readonly string[],
): Promise<readonly string[]> {
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

  // Prompts are dispatched; the wait below is on the rendered cards, not on the
  // dispatch promise (ACP streaming keeps the turn alive after sendPrompt).
  for (const prompt of prompts) {
    await page.evaluate((text) => window.__E2E__!.sendAcpPrompt(text), prompt)
  }

  const cards = page.locator(SUBAGENT_CARDS)
  await expect(cards).toHaveCount(prompts.length, { timeout: 10000 })
  return cards.evaluateAll((els) => els.map((el) => el.getAttribute('data-timeline-key') ?? ''))
}

/** The card currently drawing the keyboard focus ring, or null. */
function focusedSubagentKey(page: Page): Promise<string | null> {
  return page.evaluate((selector) => {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (getComputedStyle(el).outlineStyle === 'solid') {
        return el.getAttribute('data-timeline-key')
      }
    }
    return null
  }, SUBAGENT_CARDS)
}

/** Whether the card's own header row is expanded (null when the card is gone). */
function cardExpanded(page: Page, key: string): Promise<boolean | null> {
  return page.evaluate((slotKey) => {
    const card = document.querySelector(`[data-timeline-key="${CSS.escape(slotKey)}"]`)
    const toggle = card?.querySelector('button[data-testid="acp-collapsible-toggle"]')
    const expanded = toggle?.getAttribute('aria-expanded')
    return expanded === null || expanded === undefined ? null : expanded === 'true'
  }, key)
}

/** Jumping only focuses the card header; it must never unfold the body. */
async function expectCardsCollapsed(page: Page, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    await expect.poll(() => cardExpanded(page, key), { timeout: 5000 }).toBe(false)
  }
}

test.describe('@p1 sub-agent card navigation', () => {
  test('Alt+Shift+J/K and the floating pill move between top-level cards', async ({
    page,
    workbench,
  }) => {
    const keys = await openSessionWithCards(page, workbench, TWO_CARDS)
    const count = page.getByTestId('acp-subagent-count')
    await expect(page.getByTestId('acp-subagent-nav')).toBeVisible()
    await expect(count).toHaveText(/\/2$/)

    // Focus the timeline host without clicking a card (a click would toggle its
    // fold state, and the jump must be the only thing moving focus).
    await page.evaluate(() => {
      const timeline = document.querySelector('[data-testid="acp-timeline"]')
      ;(timeline?.parentElement as HTMLElement | null)?.focus()
    })
    await page.keyboard.press('Alt+Home')

    // The pill already names the first card visible at the top, so one step
    // forward lands on the second card.
    await page.keyboard.press('Alt+Shift+J')
    await expect.poll(() => focusedSubagentKey(page), { timeout: 5000 }).toBe(keys[1])
    await expect(count).toHaveText('2/2')
    await expect(page.getByTestId('acp-subagent-next')).toBeEnabled()
    await expect(page.getByTestId('acp-subagent-prev')).toBeEnabled()

    // Past the last card wraps to the first; before the first wraps to the last.
    await page.keyboard.press('Alt+Shift+J')
    await expect.poll(() => focusedSubagentKey(page), { timeout: 5000 }).toBe(keys[0])
    await expect(count).toHaveText('1/2')

    await page.keyboard.press('Alt+Shift+K')
    await expect.poll(() => focusedSubagentKey(page), { timeout: 5000 }).toBe(keys[1])
    await expect(count).toHaveText('2/2')

    // The pill's arrows share the widget command, not a parallel scroll path,
    // and wrap the same way.
    await page.getByTestId('acp-subagent-next').click()
    await expect.poll(() => focusedSubagentKey(page), { timeout: 5000 }).toBe(keys[0])
    await expect(count).toHaveText('1/2')

    await page.getByTestId('acp-subagent-prev').click()
    await expect.poll(() => focusedSubagentKey(page), { timeout: 5000 }).toBe(keys[1])
    await expect(count).toHaveText('2/2')
    await expectCardsCollapsed(page, keys)
  })

  test('a single card is focused from either direction', async ({ page, workbench }) => {
    const keys = await openSessionWithCards(page, workbench, ['emit-subagent:1x1'])
    const count = page.getByTestId('acp-subagent-count')
    await expect(page.getByTestId('acp-subagent-nav')).toBeVisible()
    await expect(count).toHaveText('1/1')
    await expect(page.getByTestId('acp-subagent-prev')).toBeEnabled()
    await expect(page.getByTestId('acp-subagent-next')).toBeEnabled()

    await page.evaluate(() => {
      const timeline = document.querySelector('[data-testid="acp-timeline"]')
      ;(timeline?.parentElement as HTMLElement | null)?.focus()
    })

    await page.keyboard.press('Alt+Shift+J')
    await expect.poll(() => focusedSubagentKey(page), { timeout: 5000 }).toBe(keys[0])

    await page.keyboard.press('Alt+Shift+K')
    await expect.poll(() => focusedSubagentKey(page), { timeout: 5000 }).toBe(keys[0])

    // Arrows take the same wrap-around path.
    await page.getByTestId('acp-subagent-next').click()
    await expect.poll(() => focusedSubagentKey(page), { timeout: 5000 }).toBe(keys[0])
    await page.getByTestId('acp-subagent-prev').click()
    await expect.poll(() => focusedSubagentKey(page), { timeout: 5000 }).toBe(keys[0])
    await expectCardsCollapsed(page, keys)
  })

  test('Go to Symbol pins the sub-agent section and reveals the accepted card', async ({
    page,
    workbench,
  }) => {
    const keys = await openSessionWithCards(page, workbench, TWO_CARDS)

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.gotoSymbol')
    })
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.input).toHaveValue('@')

    // The section header comes first, then the sub-agent rows (before every
    // ordinary turn/tool symbol).
    await expect(page.getByTestId('quick-input-separator').first()).toHaveText('Sub Agents')
    await expect(workbench.quickInput.dialog.getByRole('option').first()).toHaveText(/Task/)

    await page.keyboard.press('Enter')
    await workbench.quickInput.waitForHidden()
    await expect.poll(() => focusedSubagentKey(page), { timeout: 5000 }).toBe(keys[0])
    await expectCardsCollapsed(page, keys)
  })

  test('the @: category view pins the same sub-agent section', async ({ page, workbench }) => {
    await openSessionWithCards(page, workbench, TWO_CARDS)

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.quickOpen')
    })
    await workbench.quickInput.waitForVisible()
    await workbench.quickInput.input.fill('@:')
    await expect(workbench.quickInput.input).toHaveValue('@:')

    await expect(page.getByTestId('quick-input-separator').first()).toHaveText('Sub Agents')
    await expect(workbench.quickInput.dialog.getByRole('option').first()).toHaveText(/Task/)

    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()
  })
})
