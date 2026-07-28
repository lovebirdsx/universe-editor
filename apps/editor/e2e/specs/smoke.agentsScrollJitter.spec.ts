/*---------------------------------------------------------------------------------------------
 *  ACP chat 虚拟化滚动抖动 (@p1).
 *
 *  复现用户报告：长会话（超过虚拟化阈值），滚到某个特定位置后，页面就上下高频抖动、
 *  永不停止——直到手动挪一下滚动条才停。
 *
 *  根因（本 spec 复现并守护）：某类叶子组件首帧按**完整高度**挂载，随后异步才 clamp 到
 *  固定 max-height。虚拟列表每次把某行滚回 overscan 窗口都会重挂载它，于是该行「刚挂载
 *  (高)→异步(矮)」反复发生。当某次 size-change 校正把 scrollTop 挪动、令一个**整体位于
 *  视口上方**的这类行重新挂载时：它先按完整高度渲染（+Δ 校正，因 item.end<=offset 命中
 *  谓词）→ 随即 clamp 变矮（-Δ 校正）→ 重挂载又变高……scrollTop 在两个值间无限横跳。
 *  `overflow-anchor:none` 撤掉了浏览器的原生反向补偿，没有东西能阻断它；用户挪一下滚动条
 *  会派发 scroll 事件、把 TanStack 的 scrollAdjustments 归零，才打破一次环。
 *
 *  已知的两个此类叶子（各有一个用例守护）：
 *   1. execute 工具卡的 TerminalOutput（overflows 初值曾恒 false）——修复：初值改为对
 *      文本的**同步估算**，首帧即渲染在 clamp 后高度。见 ToolCallOutput.tsx。
 *   2. 长用户消息 UserMessageItem（>160px 夹高 + Expand）——修复：同上估算 seed（CJK
 *      宽度感知，中文按两列宽算 wrap），外加 contentKey 测量缓存令 remount 复用上次实测。
 *      见 UserMessageItem.tsx / contentOverflow.ts。用户实际场景：打开长中文会话，outline
 *      跳转到底部附近再向上滚——上方全是未测量的长中文 user 消息行，列表上下闪动约 1 秒
 *      并持续向上漂移。
 *
 *  复现要点（踩过的坑）：
 *   - 纯文本 echo 无法触发——每次挂载测得同一高度、delta=0，没有反馈源。必须是
 *     「挂载时高、异步变矮、每次重挂载复现」的行。
 *   - 卡片默认折叠（execute 在 default 模式 collapsed），body 不渲染就没有 TerminalOutput；
 *     必须 setAcpCollapseMode('expanded') 把卡片展开。message 卡默认展开，无需切模式。
 *   - 必须用**真实鼠标滚轮**（page.mouse.wheel）滚动，不能只 `el.scrollTop=x`+合成 scroll：
 *     后者每次都把 scrollAdjustments 归零，反而亲手打断待测极限环。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const TIMELINE = '[data-testid="acp-timeline"]'

// The renderer's timelineVirtualScroll predicate pushes each TanStack size-change
// correction here (E2E only); the spec reads it as ground truth for the loop.
declare global {
  interface Window {
    __TIMELINE_SIZE_CORRECTIONS_TOTAL__?: Array<{ delta: number; offset: number }>
  }
}

// 从底部开始，用真实鼠标滚轮一小段一小段往上滚；每滚一段后**不再给任何输入**，静默
// 采样 scrollTop 与 size-change 校正数，返回最糟的一段。健康时每段滚动只有一次性
// settle（后半程窗口内 scrollTop 不再变、校正为 0）；极限环则在后半程仍持续校正、
// scrollTop 反复横跳。
async function sampleWorstSettleWhileWheelingUp(
  page: Page,
): Promise<{ lateCorrections: number; lateSpan: number; samples: number[] }> {
  const box = await page.evaluate((sel) => {
    const el = (document.querySelector(sel) as HTMLElement).parentElement as HTMLElement
    const r = el.getBoundingClientRect()
    el.scrollTop = el.scrollHeight
    window.__TIMELINE_SIZE_CORRECTIONS_TOTAL__ = []
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, TIMELINE)

  let acc = { lateCorrections: 0, lateSpan: 0, samples: [] as number[] }
  for (let step = 0; step < 40; step++) {
    await page.mouse.move(box.x, box.y)
    // 大小步交替，让滚动落点覆盖更多挂载边界（极限环只在特定 scrollTop 附近出现）。
    await page.mouse.wheel(0, step % 2 === 0 ? -120 : -48)
    const post = await page.evaluate(async (sel) => {
      const el = (document.querySelector(sel) as HTMLElement).parentElement as HTMLElement
      const raf = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))
      const FRAMES = 14
      const HALF = 7
      const corrAt: number[] = []
      const samples: number[] = []
      for (let f = 0; f < FRAMES; f++) {
        await raf()
        samples.push(el.scrollTop)
        corrAt.push((window.__TIMELINE_SIZE_CORRECTIONS_TOTAL__ ?? []).length)
      }
      // 后半程（瞬态已过）新增的校正数 + scrollTop 跨度。
      const lateCorrections = (corrAt[FRAMES - 1] ?? 0) - (corrAt[HALF - 1] ?? 0)
      const late = samples.slice(HALF)
      const lateSpan = Math.max(...late) - Math.min(...late)
      return { lateCorrections, lateSpan, samples }
    }, TIMELINE)
    const score = (c: number, s: number): number => c * 1000 + s
    if (score(post.lateCorrections, post.lateSpan) > score(acc.lateCorrections, acc.lateSpan)) {
      acc = post
    }
  }
  return acc
}

test.describe('@p1 agents — virtualized timeline scroll jitter', () => {
  test('does not oscillate scrollTop when wheeling through a long timeline of terminal cards @regression', async ({
    page,
    workbench,
  }) => {
    test.setTimeout(90_000)
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

    // 每个 prompt 触发一个 execute 工具卡（emit-exec:<lines>），行数在大/中/小之间循环，
    // 制造高度差异明显、跨越 clamp 阈值的一批卡片——正是极限环的临界条件。
    const COUNT = 24
    for (let i = 0; i < COUNT; i++) {
      const lines = i % 3 === 0 ? 40 : i % 3 === 1 ? 5 : 20
      await page.evaluate((n) => window.__E2E__!.sendAcpPrompt(`emit-exec:${n}`), lines)
    }
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpToolCalls().length), { timeout: 20000 })
      .toBe(COUNT)

    // 展开所有卡片，让 TerminalOutput 真正挂载（默认 execute 卡是折叠的，body 不渲染）。
    await page.evaluate(() => window.__E2E__!.setAcpCollapseMode('expanded'))
    await page.waitForTimeout(2500)

    await expect
      .poll(() =>
        page.evaluate((sel) => {
          const el = document.querySelector(sel)?.parentElement
          return el ? el.scrollHeight - el.clientHeight : 0
        }, TIMELINE),
      )
      .toBeGreaterThan(800)

    // 从底部真滚轮向上采样；健康时每段滚动只有一次性 settle。
    const worst = await sampleWorstSettleWhileWheelingUp(page)

    // 极限环判据：任一滚动落点在**后半程静默窗口**（瞬态已过、无任何新输入）内仍持续触发
    // size-change 校正、或 scrollTop 仍在大幅横跳。健康时后半程 lateCorrections=0、lateSpan≈0。
    // 阈值给足余量：容忍收敛尾帧的个位数 px 抖动，抓住 bug 那种数百 px 的反复横跳。
    const jittery = worst.lateCorrections >= 3 || worst.lateSpan >= 30
    expect(
      jittery,
      `滚动后出现持续抖动：后半程校正=${worst.lateCorrections} scrollTop跨度=${worst.lateSpan}px 采样=${JSON.stringify(worst.samples)}`,
    ).toBe(false)
  })

  test('does not oscillate scrollTop when wheeling up through long CJK user prompts @regression', async ({
    page,
    workbench,
  }) => {
    test.setTimeout(90_000)
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

    // 用户实际会话形态：长中文多行 user 消息（超过 160px 夹高阈值 → 首帧全高、异步夹矮的
    // 翻转源）与短消息交替，制造跨越 clamp 阈值、行高差异明显的一批 message 卡。message
    // 卡默认展开，无需切折叠模式。
    const LONG_CJK = Array.from(
      { length: 12 },
      (_, k) =>
        `第${k}行：这是一条超过折叠阈值的长中文用户消息，专门用来复现虚拟化时间线的往复补偿抖动问题。`,
    ).join('\n')
    const COUNT = 16
    for (let i = 0; i < COUNT; i++) {
      await page.evaluate(
        (t) => window.__E2E__!.sendAcpPrompt(t),
        i % 2 === 0 ? LONG_CJK : `短消息 ${i}`,
      )
    }
    // echo agent 每轮回一条 agent 消息：user + agent 共 COUNT*2 条。
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages().length), { timeout: 20000 })
      .toBeGreaterThanOrEqual(COUNT * 2)
    await page.waitForTimeout(2500)

    await expect
      .poll(() =>
        page.evaluate((sel) => {
          const el = document.querySelector(sel)?.parentElement
          return el ? el.scrollHeight - el.clientHeight : 0
        }, TIMELINE),
      )
      .toBeGreaterThan(800)

    const worst = await sampleWorstSettleWhileWheelingUp(page)

    const jittery = worst.lateCorrections >= 3 || worst.lateSpan >= 30
    expect(
      jittery,
      `滚动后出现持续抖动：后半程校正=${worst.lateCorrections} scrollTop跨度=${worst.lateSpan}px 采样=${JSON.stringify(worst.samples)}`,
    ).toBe(false)
  })
})
