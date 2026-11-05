/*---------------------------------------------------------------------------------------------
 *  Ctrl+Alt+I 在输入框与时间线滚动容器间切换；聚焦时间线只移焦点，不滚动、不改选中卡片。
 *  focusInput / focusTimeline 是无默认键位的固定命令。
 *  ACP 会话会拉起 main 进程 agent，每个用例冷启动。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'
import type { Page } from '@playwright/test'
import type { WorkbenchPO } from '@universe-editor/e2e-harness'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const TIMELINE = '[data-testid="acp-timeline"]'
const TOGGLE_FOCUS = 'workbench.action.agent.toggleFocus'
const FOCUS_INPUT = 'workbench.action.agent.focusInput'
const FOCUS_TIMELINE = 'workbench.action.agent.focusTimeline'
const POLL = { timeout: 15000 }

function focusIsOnTimelineContainer(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return false
    if (active.closest('[data-testid="acp-prompt"]')) return false
    if (!active.closest('[data-testid="acp-chat"]')) return false
    // 非空会话的滚动容器是 acp-timeline 的父节点；空会话无 timeline 节点，退化为 tabIndex=-1。
    const timeline = document.querySelector('[data-testid="acp-timeline"]')
    return timeline ? active === timeline.parentElement : active.tabIndex === -1
  })
}

function timelineScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="acp-timeline"]')?.parentElement
    return scroller?.scrollTop ?? 0
  })
}

/** 等滚动停稳再采样：平滑滚动动画中途反转会让位置断言 flake。 */
async function waitForScrollSettled(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const a = await timelineScrollTop(page)
        await page.waitForTimeout(150)
        const b = await timelineScrollTop(page)
        return Math.abs(a - b) < 1 ? a : -1
      },
      { timeout: 5000 },
    )
    .toBeGreaterThanOrEqual(0)
}

function selectedTimelineKey(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-timeline-key]'))) {
      if (getComputedStyle(el).outlineStyle === 'solid') {
        return el.getAttribute('data-timeline-key')
      }
    }
    return null
  })
}

async function startEchoSession(page: Page, workbench: WorkbenchPO): Promise<void> {
  await workbench.waitForRestored()
  // 启动焦点恢复晚于 waitForRestored，不等它会被中途抢焦点。
  await workbench.waitForBootstrapFocusSettled()
  await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
    'echo',
    ECHO_AGENT_PATH,
  ] as const)
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect.poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), POLL).toBe(1)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), POLL)
    .toBe('acp.session')
  await expect.poll(() => workbench.getFocusedChatSurface()).toBe('prompt')
}

async function sendPrompts(page: Page, prompts: readonly string[]): Promise<void> {
  for (const prompt of prompts) {
    await page.evaluate((text) => window.__E2E__!.sendAcpPrompt(text), prompt)
  }
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages().length), POLL)
    .toBe(prompts.length * 2)
}

async function focusPromptInput(page: Page): Promise<void> {
  await page.evaluate((id) => window.__E2E__!.runCommand(id), FOCUS_INPUT)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('acpPromptInputFocused')))
    .toBe(true)
}

test.describe('agent focus — Ctrl+Alt+I toggles input and timeline', () => {
  test('keeps the toggle binding, cycles prompt↔timeline, and returns from outside/cards to the prompt @p1', async ({
    page,
    workbench,
  }) => {
    await startEchoSession(page, workbench)

    // 固定聚焦命令不占默认键位，只有切换命令独占 Ctrl+Alt+I。
    expect(
      await page.evaluate(() => window.__E2E__!.getKeybindingCommandsForKey('ctrl+alt+i')),
    ).toContain(TOGGLE_FOCUS)
    expect(await page.evaluate(() => window.__E2E__!.resolveKeybinding('ctrl+alt+i'))).toEqual({
      kind: 'execute',
      command: TOGGLE_FOCUS,
    })
    const fixedBindings = await page.evaluate(
      ([focusInput, focusTimeline]) =>
        window
          .__E2E__!.getAllKeybindings()
          .filter((kb) => kb.command === focusInput || kb.command === focusTimeline),
      [FOCUS_INPUT, FOCUS_TIMELINE] as const,
    )
    expect(fixedBindings).toHaveLength(0)

    await page.keyboard.press('Control+Alt+I')
    await expect.poll(() => workbench.getFocusedChatSurface()).toBe('timeline')
    await expect.poll(() => focusIsOnTimelineContainer(page)).toBe(true)
    await expect.poll(() => workbench.getContextKey<boolean>('acpPromptInputFocused')).toBe(false)
    await expect.poll(() => workbench.getContextKey<boolean>('acpChatFocused')).toBe(true)

    await page.keyboard.press('Control+Alt+I')
    await expect.poll(() => workbench.getFocusedChatSurface()).toBe('prompt')
    await expect.poll(() => workbench.getContextKey<boolean>('acpPromptInputFocused')).toBe(true)

    await page.keyboard.press('Control+Alt+I')
    await expect.poll(() => workbench.getFocusedChatSurface()).toBe('timeline')
    await expect.poll(() => focusIsOnTimelineContainer(page)).toBe(true)

    await sendPrompts(page, ['focus-toggle'])
    const card = page.locator('[data-testid="acp-message-agent"]').first()
    await expect(card).toBeVisible()

    await card.click()
    await expect.poll(() => workbench.getFocusedChatSurface()).toBe('timeline')
    await expect.poll(() => selectedTimelineKey(page)).not.toBeNull()
    await page.keyboard.press('Control+Alt+I')
    await expect.poll(() => workbench.getFocusedChatSurface()).toBe('prompt')
    await expect.poll(() => workbench.getContextKey<boolean>('acpPromptInputFocused')).toBe(true)

    await page.focus('[data-testid="activitybar-item-workbench.view.explorer"]')
    await expect.poll(() => workbench.getFocusedChatSurface()).toBe('none')
    await page.keyboard.press('Control+Alt+I')
    await expect.poll(() => workbench.getFocusedChatSurface()).toBe('prompt')
    await expect.poll(() => workbench.getContextKey<boolean>('acpPromptInputFocused')).toBe(true)
  })

  test('focusing the timeline leaves scrollTop and the selected card alone; native scroll and Alt nav still work @p1', async ({
    page,
    workbench,
  }) => {
    await startEchoSession(page, workbench)

    const long = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
    await sendPrompts(
      page,
      Array.from({ length: 8 }, (_, i) => `${i}\n${long}`),
    )

    // 等懒测量行高稳定后再采样滚动位置。
    await expect
      .poll(
        async () => {
          const a = await page.evaluate((sel) => {
            const el = document.querySelector(sel)?.parentElement as HTMLElement | null
            return el ? el.scrollHeight - el.clientHeight : 0
          }, TIMELINE)
          await page.waitForTimeout(150)
          const b = await page.evaluate((sel) => {
            const el = document.querySelector(sel)?.parentElement as HTMLElement | null
            return el ? el.scrollHeight - el.clientHeight : 0
          }, TIMELINE)
          return a === b && a > 200 ? a : 0
        },
        { timeout: 10000 },
      )
      .toBeGreaterThan(200)

    await page.keyboard.press('Control+Alt+I')
    await expect.poll(() => focusIsOnTimelineContainer(page)).toBe(true)
    // 首条用户消息在吸顶栏且不画选中描边，Alt+A 后需再前进一步才能落到普通卡片。
    await page.keyboard.press('Alt+A')
    await page.keyboard.press('Alt+J')
    await expect.poll(() => selectedTimelineKey(page)).not.toBeNull()
    const selectedBefore = await selectedTimelineKey(page)
    await page.keyboard.press('Alt+J')
    await expect.poll(() => selectedTimelineKey(page), { timeout: 5000 }).not.toBe(selectedBefore)

    await page.evaluate((sel) => {
      const el = document.querySelector(sel)?.parentElement as HTMLElement | null
      if (el) el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2)
    }, TIMELINE)
    await waitForScrollSettled(page)
    const scrollBefore = await timelineScrollTop(page)
    expect(scrollBefore).toBeGreaterThan(0)
    const selectedAtRest = await selectedTimelineKey(page)

    // 固定聚焦命令只移焦点：不滚动、不改选中卡片。
    await focusPromptInput(page)
    await page.evaluate((id) => window.__E2E__!.runCommand(id), FOCUS_TIMELINE)
    await expect.poll(() => focusIsOnTimelineContainer(page)).toBe(true)
    expect(await timelineScrollTop(page)).toBe(scrollBefore)
    expect(await selectedTimelineKey(page)).toBe(selectedAtRest)

    await focusPromptInput(page)
    await page.keyboard.press('Control+Alt+I')
    await expect.poll(() => focusIsOnTimelineContainer(page)).toBe(true)
    expect(await timelineScrollTop(page)).toBe(scrollBefore)
    expect(await selectedTimelineKey(page)).toBe(selectedAtRest)

    await page.keyboard.press('PageDown')
    await expect.poll(() => timelineScrollTop(page)).toBeGreaterThan(scrollBefore)
    await waitForScrollSettled(page)
    const afterPageDown = await timelineScrollTop(page)
    await page.keyboard.press('PageUp')
    await expect.poll(() => timelineScrollTop(page)).toBeLessThan(afterPageDown)
    await waitForScrollSettled(page)

    await page.evaluate((sel) => {
      const el = document.querySelector(sel)?.parentElement as HTMLElement | null
      if (el) el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2)
    }, TIMELINE)
    await waitForScrollSettled(page)
    const beforeArrowDown = await timelineScrollTop(page)
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => timelineScrollTop(page)).toBeGreaterThan(beforeArrowDown)
    await waitForScrollSettled(page)
    const afterArrowDown = await timelineScrollTop(page)
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => timelineScrollTop(page)).toBeLessThan(afterArrowDown)
    await waitForScrollSettled(page)

    const selectedBeforeAlt = await selectedTimelineKey(page)
    await page.keyboard.press('Alt+J')
    await expect
      .poll(() => selectedTimelineKey(page), { timeout: 5000 })
      .not.toBe(selectedBeforeAlt)
    const selectedAfterAltJ = await selectedTimelineKey(page)
    await page.keyboard.press('Alt+K')
    await expect.poll(() => selectedTimelineKey(page), { timeout: 5000 }).toBe(selectedBeforeAlt)
    expect(selectedAfterAltJ).not.toBe(selectedBeforeAlt)
  })
})
