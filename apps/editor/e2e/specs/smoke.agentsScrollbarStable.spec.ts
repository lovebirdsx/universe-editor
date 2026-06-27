/*---------------------------------------------------------------------------------------------
 *  ACP chat 虚拟化滚动条稳定性 (@p1).
 *
 *  复现用户报告的现象②③：虚拟化时滚动条比例不准、且随滚动剧烈变化——内容越靠上滚动
 *  条越长，往下滚越短；看着快到底了，继续拖还有大量内容。
 *
 *  根因：@tanstack 估算式虚拟化的 getTotalSize() = Σ(已测量真实高) + Σ(未测量行的
 *  estimateRow 估算高)。从顶往底滚的过程中，越来越多行进入视口被真实测量、替换掉原本
 *  的估算值，scrollHeight（决定滚动条 thumb 大小 = clientHeight/scrollHeight）随之跳。
 *  estimateRow 估得越离谱，跳得越凶。本测试从顶滚到底逐段采样 scrollHeight，断言相邻
 *  采样间的相对变化有界——估算高度必须足够接近真实测量高度，滚动条才不会剧烈伸缩。
 *
 *  阈值压到 10，十几条消息即走虚拟路径。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const TIMELINE = '[data-testid="acp-timeline"]'

test.describe('@p1 agents — virtualized timeline scrollbar stability', () => {
  test('scrollHeight does not swing wildly while scrolling top to bottom', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    await page.evaluate(() =>
      window.__E2E__!.updateConfigValue('workbench.chat.virtualizationThreshold', 10),
    )

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

    // 发足够多、长度差异明显的 prompt：长度差异越大，estimateRow 估算与真实测量高度
    // 的偏差越能暴露——滚动条不稳的根因正是这个偏差。
    for (let i = 0; i < 16; i++) {
      const lines = 6 + (i % 6) * 14
      const body = Array.from({ length: lines }, (_, k) => `line ${k} ${'x'.repeat(40)}`).join('\n')
      await page.evaluate((t) => window.__E2E__!.sendAcpPrompt(t), `prompt ${i}\n${body}`)
    }

    await expect
      .poll(() =>
        page.evaluate((sel) => {
          const el = document.querySelector(sel)?.parentElement
          return el ? el.scrollHeight - el.clientHeight : 0
        }, TIMELINE),
      )
      .toBeGreaterThan(400)

    // 从顶滚到底，分段采样 scrollHeight。每段把 scrollTop 往下推一截，然后**等 scrollHeight
    // 测量收敛**再读数——@tanstack 通过 ResizeObserver 异步测量进入视口的行，固定等几帧在慢机/
    // 并发 CI 上不够（行还顶着 estimateRow 没测完），会采到「估算→实测」过渡中的瞬时值，污染被
    // 测对象本身。settle 等连续若干帧 scrollHeight 不再变化（测量已收敛）才采，测的才是用户看到
    // 的稳定滚动条；被测断言（稳定值间的伸缩）强度不变。
    const samples = await page.evaluate(async (sel) => {
      const el = document.querySelector(sel)!.parentElement as HTMLElement
      const raf = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))
      // 等 scrollHeight 连续 STABLE_FRAMES 帧不变，或耗尽 MAX_FRAMES 预算才返回。
      const settle = async (): Promise<number> => {
        const STABLE_FRAMES = 4
        const MAX_FRAMES = 120
        let last = el.scrollHeight
        let stable = 0
        for (let f = 0; f < MAX_FRAMES; f++) {
          await raf()
          const h = el.scrollHeight
          if (h === last) {
            if (++stable >= STABLE_FRAMES) return h
          } else {
            stable = 0
            last = h
          }
        }
        return el.scrollHeight
      }
      const out: number[] = []
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
      await settle()
      const STEPS = 16
      for (let i = 0; i <= STEPS; i++) {
        const max = el.scrollHeight - el.clientHeight
        el.scrollTop = Math.round((max * i) / STEPS)
        el.dispatchEvent(new Event('scroll'))
        out.push(await settle())
      }
      return out
    }, TIMELINE)

    // 相邻采样间 scrollHeight 的相对变化必须有界。一旦 estimateRow 与真实高度差太多，
    // 滚动中替换估算值会让 scrollHeight 跳变 → 滚动条 thumb 忽大忽小。容差 25%：足够
    // 容纳估算的合理误差，但能抓住「内容越靠上滚动条越长」这类剧烈伸缩。
    let maxJump = 0
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1]!
      const cur = samples[i]!
      const jump = Math.abs(cur - prev) / Math.max(prev, 1)
      maxJump = Math.max(maxJump, jump)
    }
    expect(maxJump, `scrollHeight 采样=${JSON.stringify(samples)}`).toBeLessThan(0.25)

    // 滚到底后的 scrollHeight 与滚到顶时不应相差过大——这正是用户说的「比例不准：看着
    // 快到底了其实还有很多」。首末采样的相对差控制在 30% 内。
    const first = samples[0]!
    const last = samples[samples.length - 1]!
    const totalDrift = Math.abs(last - first) / Math.max(first, 1)
    expect(totalDrift, `首=${first} 末=${last}`).toBeLessThan(0.3)
  })
})
