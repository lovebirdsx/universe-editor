/*---------------------------------------------------------------------------------------------
 *  ACP chat 虚拟化滚动恢复回归 (@p1).
 *
 *  复现 bug：当 Timeline 条目多到触发虚拟化（timeline.length >
 *  workbench.chat.virtualizationThreshold）时——
 *    1. 滚到最后一条，切到别的 editor 再切回，落点从底部跳到了中间；
 *    2. 非底部位置切回时，因虚拟列表重新挂载丢失了行高测量缓存，估算坐标系
 *       与切走前不一致，旧的像素 scrollTop 指向了完全不同的内容。
 *
 *  本质修复：unmount 前把 virtualizer 的 measurementsCache 与一个“顶部可见
 *  slot + 偏移”锚点写进 AcpChatViewStateCache，remount 时用
 *  initialMeasurementsCache 重建同一坐标系，并按锚点解析回正确 scrollTop。
 *
 *  这里把虚拟化阈值压到很低，几十条消息即可走虚拟路径，无需造上千条 fixture。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'
import { AcpTimelinePO } from '@universe-editor/e2e-harness'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const TIMELINE = '[data-testid="acp-timeline"]'

test.describe('@p1 agents — virtualized timeline scroll restore', () => {
  test('stays bottom-pinned and restores mid position after a tab switch when virtualized @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const timeline = new AcpTimelinePO(page)

    // 把虚拟化阈值压到 5，几条消息就走虚拟路径。
    await page.evaluate(() =>
      window.__E2E__!.updateConfigValue('workbench.chat.virtualizationThreshold', 5),
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

    // 发足够多的长 prompt，越过阈值并堆出可滚动高度。
    const long = Array.from({ length: 20 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
    for (let i = 0; i < 12; i++) {
      await page.evaluate((t) => window.__E2E__!.sendAcpPrompt(t), `${i}\n${long}`)
    }

    // 等到虚拟容器真正渲染（绝对定位的 timelineRow + transform）且可滚动。
    await expect
      .poll(() =>
        page.evaluate((sel) => {
          const el = document.querySelector(sel)?.parentElement
          return el ? el.scrollHeight - el.clientHeight : 0
        }, TIMELINE),
      )
      .toBeGreaterThan(100)

    // 等所有 echo 回复落地（12 user + 12 agent = 24）。否则贴底/滚动时内容仍在涌入，
    // 高度暴涨，scrollToBottomStable 的 10 帧 RAF 上限会在内容稳定前耗尽、停在离底
    // 几百 px 处（慢 CI 下 distance 卡在 ~342），断言 1 误判“没贴底”。对齐主 spec
    // smoke.agentsScrollRestore 的 echo-settle 门控。
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages().length), { timeout: 10000 })
      .toBe(24)

    // 再等高度收敛（流式 chunk + Monaco 着色 + 行高懒测量会让 scrollHeight 持续变化
    // 几帧）。两次采样相等才认为已稳定，避免在内容仍增长时贴底/记位置。
    await expect
      .poll(
        async () => {
          const a = await page.evaluate((sel) => {
            const el = document.querySelector(sel)?.parentElement as HTMLElement | null
            return el ? el.scrollHeight : -1
          }, TIMELINE)
          await page.waitForTimeout(150)
          const b = await page.evaluate((sel) => {
            const el = document.querySelector(sel)?.parentElement as HTMLElement | null
            return el ? el.scrollHeight : -2
          }, TIMELINE)
          return a === b ? a : -1
        },
        { timeout: 5000 },
      )
      .toBeGreaterThan(100)

    // —— 场景 1：滚到底（stuck）→ 切走 → 切回，应仍在底部 ——
    // 单次同步 scrollTop=scrollHeight 在虚拟模式下会落短（尾部行还是估算高度，挂载
    // 测量后变高、scrollHeight 继续涨），故 poll 反复贴底直到 distance<30 真正到底，
    // 再继续——否则 bottomBefore 这个前置 sanity 会偶发判定“没到底”。
    await expect
      .poll(
        () =>
          page.evaluate((sel) => {
            const el = document.querySelector(sel)!.parentElement as HTMLElement
            el.scrollTop = el.scrollHeight
            el.dispatchEvent(new Event('scroll'))
            return el.scrollHeight - el.clientHeight - el.scrollTop
          }, TIMELINE),
        { timeout: 8000, intervals: [100] },
      )
      .toBeLessThan(30)

    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .not.toBe('acp.session')
    await workbench.runCommand('workbench.action.previousEditor')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('acp.session')

    // 关键断言 1：切回后仍贴底，不跳中间。bottom-pin 走 scrollToBottomStable 的多帧
    // RAF（最多 10 帧，每帧 scrollTop=scrollHeight 直到高度稳定）。慢 CI（多 worker 抢
    // CPU）下这串 RAF 要更久才收敛，原 3s 窗口会在收敛前超时（distance 卡在几千 px）。
    // 放宽到 8s 容纳 CPU 饥饿即可——贴底是单调收敛（distance 只会越来越小），一旦某帧
    // distance<30 就达成，无需连续稳定计数。
    await expect
      .poll(
        () =>
          page.evaluate((sel) => {
            const el = document.querySelector(sel)?.parentElement as HTMLElement | null
            if (!el) return -1
            const max = el.scrollHeight - el.clientHeight
            return max - el.scrollTop
          }, TIMELINE),
        { timeout: 8000, intervals: [100] },
      )
      .toBeLessThan(30)

    // —— 场景 2：滚到中间（非 stuck）→ 切走 → 切回，应锚回同一条消息 ——
    // 定位不能用像素中点一锤定音：虚拟模式下估计高度与真实高度偏离，像素中点
    // (scrollHeight-clientHeight)/2 落到的消息不确定——实测可落 m11/m22（双峰，案例
    // 34），CI 慢机上甚至落到末条 m24；此时距底 <32px(STICK_THRESHOLD_PX) 会被
    // handleScroll 记成 stuck=true，场景 2 退化成场景 1 的假阳性，anchorBefore<23
    // 前置守卫被击穿（本 spec 的 CI flake）。scrollToAnchorBand 按锚定索引割线逼近，
    // 直到顶部锚落进中部带。timeline 共 24 条（12 user + 12 agent），[6,18] 离顶/底
    // 都足够远：够低保证 stuck=false，够高保证没重置到顶。
    const anchorBefore = await timeline.scrollToAnchorBand({ lo: 6, hi: 18 })
    expect(anchorBefore).toBeGreaterThanOrEqual(6)
    expect(anchorBefore).toBeLessThanOrEqual(18)

    // 两个 tab（untitled + acp.session）已存在，直接在两者间切换即可——再次
    // newUntitledFile 不会新建第二个 untitled，反而打乱 previous/next 的目标。
    await workbench.runCommand('workbench.action.previousEditor')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .not.toBe('acp.session')
    await workbench.runCommand('workbench.action.nextEditor')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()))
      .toBe('acp.session')

    // 关键断言 2：切回后顶部锚定的消息仍是切走前那条（±2 容差吸收懒测量收敛期顶部行
    // 的一两条漂移），既没被重置到顶（原始 restore bug，index→0/1）也没跳到底（虚拟
    // 坐标系丢失，index→末尾）。poll 到“连续 ≥600ms 落在 [anchorBefore-2, anchorBefore+2]
    // 带内”等掉 RAF 过冲窗口——过冲帧落到首/末行会清零计数，只有收敛后才攒满。
    const LO = anchorBefore - 2
    const HI = anchorBefore + 2
    let streak = 0
    await expect
      .poll(
        async () => {
          const idx = await timeline.readTopIndex()
          streak = idx >= LO && idx <= HI ? streak + 1 : 0
          return streak
        },
        { timeout: 8000, intervals: [100] },
      )
      .toBeGreaterThanOrEqual(6)
    const finalIndex = await timeline.readTopIndex()
    expect(finalIndex).toBeGreaterThanOrEqual(LO)
    expect(finalIndex).toBeLessThanOrEqual(HI)
  })
})
