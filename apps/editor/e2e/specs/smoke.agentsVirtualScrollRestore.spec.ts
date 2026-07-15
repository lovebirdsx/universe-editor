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

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const TIMELINE = '[data-testid="acp-timeline"]'

test.describe('@p1 agents — virtualized timeline scroll restore', () => {
  test('stays bottom-pinned and restores mid position after a tab switch when virtualized @regression', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    // 读取当前视口顶部锚定的 timeline slot 索引——复用产品 captureAnchor 的语义
    // （第一条 bottom 仍在视口内的行），把 m:m<idx> 解析成数字。这是 restore 真正
    // 保证的不变量（哪条消息钉在视口顶部），不受 max 随懒测量增长导致的 frac 漂移影响。
    const readTopIndex = async (): Promise<number> =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel)?.parentElement as HTMLElement | null
        if (!el) return -1
        const top = el.getBoundingClientRect().top
        const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-slot-key]'))
        for (const row of rows) {
          if (row.getBoundingClientRect().bottom - top > 0) {
            const m = /(\d+)\s*$/.exec(row.getAttribute('data-slot-key') ?? '')
            return m ? Number(m[1]) : -1
          }
        }
        return -1
      }, TIMELINE)

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
    // 用锚定消息索引而非 frac=scrollTop/max 作落点代理：像素中点
    // scrollTop=(scrollHeight-clientHeight)/2 在虚拟模式下是双峰的——上方行按
    // estimateRow 估算、真实高度更大时，同一像素中点会落到 m11(frac≈0.43) 或
    // m22(frac≈0.92) 两个截然不同的消息（取决于滚动瞬间的懒测量状态，即案例 15 的
    // estimate 坐标系伪影）。restore 每次都忠实地把切走前那条消息钉回视口顶部（11→11、
    // 22→22 实测稳定），但当中点恰好落到 m22 时，忠实恢复给出 frac≈0.92，旧的
    // finalFrac<0.85 绝对断言就会误判失败（received 0.97 即此形态）。改用相对不变量
    // “恢复后顶部消息 == 切走前那条消息”，与中点落到 11 还是 22 无关，同时仍守护两类
    // 回归：重置到顶(index→0/1) 与虚拟坐标系丢失跳到底(index→末尾)。对齐兄弟 spec
    // smoke.agentsScrollRestore 的锚定索引方案。
    const midTarget = await page.evaluate((sel) => {
      const el = document.querySelector(sel)!.parentElement as HTMLElement
      const t = Math.floor((el.scrollHeight - el.clientHeight) / 2)
      el.scrollTop = t
      el.dispatchEvent(new Event('scroll'))
      return el.scrollTop
    }, TIMELINE)
    expect(midTarget).toBeGreaterThan(0)

    // 等顶部锚定索引稳定下来再记（懒测量收敛前会抖一两条）：连续 4 帧同值即认定收敛。
    const settleIndex = async (): Promise<number> => {
      let last = -999
      let streak = 0
      for (let i = 0; i < 40; i++) {
        const idx = await readTopIndex()
        streak = idx === last ? streak + 1 : 0
        last = idx
        if (streak >= 4) return idx
        await page.waitForTimeout(80)
      }
      return last
    }
    const anchorBefore = await settleIndex()
    // 中部消息（索引 > 0，不是被切到顶；也不是末尾贴底）。timeline 共 24 条
    // （12 user + 12 agent），末条约 m23/m24。
    expect(anchorBefore).toBeGreaterThan(0)
    expect(anchorBefore).toBeLessThan(23)

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
          const idx = await readTopIndex()
          streak = idx >= LO && idx <= HI ? streak + 1 : 0
          return streak
        },
        { timeout: 8000, intervals: [100] },
      )
      .toBeGreaterThanOrEqual(6)
    const finalIndex = await readTopIndex()
    expect(finalIndex).toBeGreaterThanOrEqual(LO)
    expect(finalIndex).toBeLessThanOrEqual(HI)
  })
})
