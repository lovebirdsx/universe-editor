/*---------------------------------------------------------------------------------------------
 *  ACP chat scroll-restore regression (@p1).
 *
 *  复现 bug：打开 Session Editor（全屏），滚动到中间位置，切到另一个 editor 标签，
 *  再切回来——原本的滚动位置丢失（被重置到 0 / 底部）。
 *
 *  根因：ChatScroll 在 unmount 时通过 effect cleanup 调 persist() 回写视图状态，但
 *  React 在跑 cleanup 之前已把 DOM 子树从文档里摘除；真实浏览器里已 detach 的元素
 *  scrollTop 读出来是 0，于是把 handleScroll 之前存好的正确值覆盖成 0。happy-dom 不会
 *  在 detach 时复位 scrollTop，所以单测看不出来——必须在真实 Electron 里跑。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

// CSS 选择器：滚动容器是 ol[data-testid="acp-timeline"] 的父级 div（chatBody）。
const TIMELINE = '[data-testid="acp-timeline"]'

test.describe('@p1 agents — scroll position survives editor tab switch', () => {
  test('restores the chat scroll position after switching away and back', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    // 注入 echo agent 并设为默认。
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    // 默认 chat location 为 'editor'，newSession 直接把会话当作全屏 editor 打开。
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('acp.session')

    // 发几条带大量换行的长 prompt，把时间线堆高，让聊天区可滚动。
    const long = Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
    for (let i = 0; i < 4; i++) {
      await page.evaluate((t) => window.__E2E__!.sendAcpPrompt(t), `${i}\n${long}`)
    }

    // 等内容真正可滚动。
    await expect
      .poll(() =>
        page.evaluate((sel) => {
          const el = document.querySelector(sel)?.parentElement
          return el ? el.scrollHeight - el.clientHeight : 0
        }, TIMELINE),
      )
      .toBeGreaterThan(100)

    // 滚到中间（非底部）并通知组件，让 handleScroll 记下 stuck=false + scrollTop。
    const target = await page.evaluate((sel) => {
      const el = document.querySelector(sel)!.parentElement as HTMLElement
      const max = el.scrollHeight - el.clientHeight
      const t = Math.floor(max / 2)
      el.scrollTop = t
      el.dispatchEvent(new Event('scroll'))
      return el.scrollTop
    }, TIMELINE)
    expect(target).toBeGreaterThan(0)

    // 切到另一个 editor（同组内新建 untitled）——会卸载 ChatScroll。
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .not.toBe('acp.session')

    // 切回会话标签——重新挂载 ChatScroll，应当恢复滚动位置。
    await workbench.runCommand('workbench.action.previousEditor')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('acp.session')

    // 关键断言：恢复后的 scrollTop 应接近切走前的位置，而不是被重置到 0 / 底部。
    // restore 走 ResizeObserver + 600ms 窗口逐步逼近，故 poll 等待其收敛。
    await expect
      .poll(
        () =>
          page.evaluate((sel) => {
            const el = document.querySelector(sel)?.parentElement as HTMLElement | null
            return el?.scrollTop ?? -1
          }, TIMELINE),
        { timeout: 3000 },
      )
      .toBeGreaterThan(target - 30)

    const finalTop = await page.evaluate((sel) => {
      const el = document.querySelector(sel)?.parentElement as HTMLElement | null
      return el?.scrollTop ?? -1
    }, TIMELINE)
    expect(finalTop).toBeLessThan(target + 30)
  })
})
