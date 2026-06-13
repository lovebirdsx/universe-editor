/*---------------------------------------------------------------------------------------------
 *  ACP chat scroll-restore regression (@p1).
 *
 *  复现 bug：打开 Session Editor（全屏），滚动到中间位置，切到另一个 editor 标签，
 *  再切回来——连续两次之后，原本的滚动位置丢失（被重置到顶 / 底部）。
 *
 *  这里把虚拟化阈值压到 10 走虚拟路径：虚拟模式下 ChatScroll remount 后，上方未渲染
 *  行回退到 estimateRow 估算，纯坐标恢复会把位置往顶带。修复改为按锚点行的真实 DOM
 *  rect 对齐，单次往返即可验证落点仍在中部。多次往返的累积漂移由
 *  smoke.agentsVirtualScrollRestoreRepeat 覆盖。
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

    // 把虚拟化阈值压到 10，十几条消息即走虚拟路径——默认阈值 1000 时这点消息只会走
    // 非虚拟 <ol>，覆盖不到虚拟化下的滚动恢复。
    await page.evaluate(() =>
      window.__E2E__!.updateConfigValue('workbench.chat.virtualizationThreshold', 10),
    )

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

    // 发足够多带大量换行的长 prompt，越过虚拟化阈值（10）并把时间线堆高。
    const long = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
    for (let i = 0; i < 8; i++) {
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

    const readFrac = async (): Promise<number> =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel)?.parentElement as HTMLElement | null
        if (!el) return -1
        const max = el.scrollHeight - el.clientHeight
        return max > 0 ? el.scrollTop / max : -1
      }, TIMELINE)

    // 滚到中间（非底部）并通知组件，让 handleScroll 记下 stuck=false + 锚点。
    const targetFrac = await page.evaluate((sel) => {
      const el = document.querySelector(sel)!.parentElement as HTMLElement
      const max = el.scrollHeight - el.clientHeight
      el.scrollTop = Math.floor(max / 2)
      el.dispatchEvent(new Event('scroll'))
      return max > 0 ? el.scrollTop / max : -1
    }, TIMELINE)
    expect(targetFrac).toBeGreaterThan(0.15)

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

    // 再次切回会话标签——重新挂载 ChatScroll，应当恢复滚动位置。
    await workbench.runCommand('workbench.action.previousEditor')
    await workbench.runCommand('workbench.action.previousEditor')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('acp.session')

    // 关键断言：恢复后仍落在中部，而不是被重置到顶（原 bug）或跳到底。虚拟路径下
    // anchor 按真实 DOM 测量高度对齐，绝对像素会随测量漂移，故用归一化容差而非像素
    // 精度。restore 走 RAF + 600ms 窗口逐步逼近，故 poll 等待其收敛。
    await expect.poll(readFrac, { timeout: 3000 }).toBeGreaterThan(0.15)
    const finalFrac = await readFrac()
    expect(finalFrac).toBeGreaterThan(0.15)
    expect(finalFrac).toBeLessThan(0.85)
  })
})
