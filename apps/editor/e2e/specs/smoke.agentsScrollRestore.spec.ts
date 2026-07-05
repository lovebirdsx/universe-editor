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
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

// CSS 选择器：滚动容器是 ol[data-testid="acp-timeline"] 的父级 div（chatBody）。
const TIMELINE = '[data-testid="acp-timeline"]'

test.describe('@p1 agents — scroll position survives editor tab switch', () => {
  test('restores the chat scroll position after switching away and back @regression', async ({
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

    // 等所有 echo 回复落地：会话创建/派发已异步化，sendAcpPrompt 的 await 只保证
    // prompt 发出，不等 agent 的流式回复渲染。必须等到 8 条 user + 8 条 agent 都
    // 进入 timeline——否则滚动时 timeline 仍只有 8 条 user（< 阈值 10），走非虚拟
    // 路径且不记锚点；随后 echo 涌入使内容高度暴涨，之前那个裸 scrollTop 就退化
    // 成顶部，恢复必然失败。
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages().length), { timeout: 10000 })
      .toBe(16)

    // 等内容真正可滚动。
    await expect
      .poll(() =>
        page.evaluate((sel) => {
          const el = document.querySelector(sel)?.parentElement
          return el ? el.scrollHeight - el.clientHeight : 0
        }, TIMELINE),
      )
      .toBeGreaterThan(100)

    // 再等高度稳定（流式 chunk + Monaco 着色 + 行高懒测量会让 scrollHeight 持续
    // 变化几帧）。两次采样相等才认为已收敛，避免在内容仍增长时记下会失效的位置。
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

    // 读取当前视口顶部锚定的 timeline slot 的索引 —— 复用产品 captureAnchor 的语义
    // （第一条 bottom 仍在视口内的行），并把 m:m<idx> 解析成数字。这是 restore 真正
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

    // 滚到中间（非底部）并通知组件，让 handleScroll 记下 stuck=false + 锚点。
    const targetFrac = await page.evaluate((sel) => {
      const el = document.querySelector(sel)!.parentElement as HTMLElement
      const max = el.scrollHeight - el.clientHeight
      el.scrollTop = Math.floor(max / 2)
      el.dispatchEvent(new Event('scroll'))
      return max > 0 ? el.scrollTop / max : -1
    }, TIMELINE)
    expect(targetFrac).toBeGreaterThan(0.15)
    // 此刻锚定的应是一条中部消息（索引 > 0，不是被切到顶）。注意此值仅作 sanity——
    // 它在 frac=0.5 处采样、上方行尚未懒测量完，本身会在 8~11 间抖动，故下面的恢复
    // 断言不与它做相对比较，改用绝对“中部带”。
    const targetIndex = await readTopIndex()
    expect(targetIndex).toBeGreaterThan(0)

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

    // 关键断言：恢复后顶部锚定的消息仍是中部消息，而不是被重置到顶（原 bug，
    // index→0/1）或跳到底（虚拟坐标系丢失，index→末尾）。timeline 共 16 条消息
    // （8 user + 8 agent，首条 user 被切走），中点约 m8；恢复落点稳定在 m9~m11。
    // 用绝对“中部带 [4, 12]”而非相对 targetIndex：targetIndex 在 frac=0.5 处采样、
    // 上方行尚未懒测量，本身在 8~11 抖动，做相对容差会把噪声引入断言。中部带两侧都
    // 留足余量，仍能抓住被守护的两类回归（重置到顶 / 跳到底）。
    //
    // 不用 frac 断言：restore 走 RAF + 600ms 窗口逐步逼近，收敛前有过冲/震荡（顶部行
    // 跳到末尾或第 0 行）；且收敛后 max 仍随下方 echo 回复懒测量持续增长，
    // frac=scrollTop/max 的分母不断变大使 frac 缓慢漂移——哪怕 scrollTop 锚定不动，
    // frac 也能从 0.4 漂到 0.11 或 0.7，两端都会误触发 0.15/0.85 边界（既往 flake 根因）。
    // 锚定消息索引收敛后稳定不漂，直接编码被守护的行为。poll 到“连续 ≥600ms 落在中部
    // 带内”等掉 RAF 过冲窗口——过冲帧落到首/末行会清零计数，只有收敛后才攒满。
    const MID_LO = 4
    const MID_HI = 12
    let streak = 0
    await expect
      .poll(
        async () => {
          const idx = await readTopIndex()
          streak = idx >= MID_LO && idx <= MID_HI ? streak + 1 : 0
          return streak
        },
        { timeout: 8000, intervals: [100] },
      )
      .toBeGreaterThanOrEqual(6)
    const finalIndex = await readTopIndex()
    expect(finalIndex).toBeGreaterThanOrEqual(MID_LO)
    expect(finalIndex).toBeLessThanOrEqual(MID_HI)
  })
})
