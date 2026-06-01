/*---------------------------------------------------------------------------------------------
 *  ACP chat sticky-scroll smoke (@p1).
 *
 *  长卡片纵向超过视口时，其头部应吸附在滚动区顶部（VSCode 风格 sticky scroll）：
 *   - 滚动进入卡片中部 → 吸顶头出现；
 *   - 点击吸顶头的 chevron → 行内同一张卡折叠（统一折叠 store，复合 key 驱动）；
 *   - 点击吸顶头的标题 → 平滑回跳到卡片顶部。
 *
 *  sticky 依赖真实布局 + rAF 测量，happy-dom 单测覆盖不到，必须在真实 Electron 里跑。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const TIMELINE = '[data-testid="acp-timeline"]'
const STICKY = '[data-testid="acp-sticky-header"]'

test.describe('@p1 agents — sticky scroll pins long card headers', () => {
  test('shows a sticky header, folds via its chevron, and jumps on its title', async ({
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
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('acp.session')

    // One very tall card: echo a prompt with ~120 long lines.
    const long = Array.from({ length: 120 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
    await page.evaluate((t) => window.__E2E__!.sendAcpPrompt(t), long)

    await expect
      .poll(() =>
        page.evaluate((sel) => {
          const el = document.querySelector(sel)?.parentElement
          return el ? el.scrollHeight - el.clientHeight : 0
        }, TIMELINE),
      )
      .toBeGreaterThan(200)

    // Scroll into the middle of the content — lands inside a tall card.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel)!.parentElement as HTMLElement
      el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2)
      el.dispatchEvent(new Event('scroll'))
    }, TIMELINE)

    // A sticky header appears (rAF-measured).
    await expect.poll(() => page.locator(STICKY).count(), { timeout: 3000 }).toBeGreaterThan(0)

    // The pinned card's key — used to check the in-place card folds.
    const key = await page.locator(STICKY).first().getAttribute('data-sticky-key-active')
    expect(key).toBeTruthy()

    // Click the title region → jump back to the card's top (scrollTop drops).
    const before = await page.evaluate((sel) => {
      const el = document.querySelector(sel)!.parentElement as HTMLElement
      return el.scrollTop
    }, TIMELINE)
    await page.locator(STICKY).first().getByTestId('acp-sticky-jump').click()
    await expect
      .poll(
        () =>
          page.evaluate((sel) => {
            const el = document.querySelector(sel)!.parentElement as HTMLElement
            return el.scrollTop
          }, TIMELINE),
        { timeout: 3000 },
      )
      .toBeLessThan(before)

    // Re-enter the card and fold it from the sticky chevron → the in-place card's
    // header reports collapsed (aria-expanded=false).
    await page.evaluate((sel) => {
      const el = document.querySelector(sel)!.parentElement as HTMLElement
      el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2)
      el.dispatchEvent(new Event('scroll'))
    }, TIMELINE)
    await expect.poll(() => page.locator(STICKY).count(), { timeout: 3000 }).toBeGreaterThan(0)
    const pinnedKey = await page.locator(STICKY).first().getAttribute('data-sticky-key-active')
    await page.locator(STICKY).first().getByTestId('acp-sticky-toggle').click()

    await expect
      .poll(
        () =>
          page.evaluate(
            ([k]) => {
              const card = document.querySelector(`[data-sticky-key="${CSS.escape(k!)}"]`)
              const btn = card?.querySelector('button[data-testid="acp-collapsible-toggle"]')
              return btn?.getAttribute('aria-expanded')
            },
            [pinnedKey] as const,
          ),
        { timeout: 3000 },
      )
      .toBe('false')
  })
})
