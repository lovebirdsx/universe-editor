/*---------------------------------------------------------------------------------------------
 *  Outline 代际回收回归（@regression）——Tree 闭包链修复的真实 renderer 一侧。
 *
 *  背景：通用 Tree 的 `sizeAt` / `makeClickHandler` 曾交替换身份，使当前渲染帧沿闭包链
 *  回指历史帧（详见 docs/development/memory-pressure.md「闭包链持有」一节）。本 spec 问的
 *  不是回调身份稳不稳，而是旧代际到底能不能被回收：真窗口里驱动真实 outline 更新，经 CDP
 *  强制回收后读 WeakRef 存活数。
 *
 *  断言形状：
 *   - 探针只存 WeakRef、显式 start/stop、每轮有上限，不额外强引用业务对象。
 *   - 每次强制回收前 arm 一个只有 WeakRef 的控制对象并验证它已被回收；未被回收就报错，
 *     因为那一轮「未能证明可回收」，同批读数不可解释（不代表 GC 没跑，也不代表应用泄漏）。
 *   - 两段更新只比较 live 是否随代数增长、以及是否超过保守常数上界（覆盖缓存 / 挂载帧 /
 *     React 双树），不要求两段相等，也不断言精确值。
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

/** 每段驱动的更新次数；两段之差必须不超过 LIVE_SLACK。 */
const GENERATIONS_PER_SEGMENT = 15
/** 段间容差：缓存与 React 双树的时序差，不是泄漏。 */
const LIVE_SLACK = 4
/** live 代际的保守常数上界（缓存 + 挂载帧 + React 双树的余量）。 */
const LIVE_BOUND = 12
/** 单代预算：一次编辑 + 200ms 防抖 + 符号拉取。 */
const GENERATION_TIMEOUT_MS = 10_000

/** 一代文档：唯一键保证每代符号不同，另加两个固定键。 */
function jsonFor(name: string): string {
  return `${JSON.stringify({ [name]: { alpha: 1, beta: 2 }, scripts: { build: 'tsc' } }, null, 2)}\n`
}

test.describe('outline retention', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(join(dir, 'pkg.json'), jsonFor('gen_0000'))
      },
    },
  })

  test('releases past outline generations as the view re-renders @regression', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    test.slow()
    if (!launchWorkspace) throw new Error('workspaceSeeder 未生效')
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    // 渲染视图：被观测的保留量就挂在已挂载的 Tree 上。
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('outline.focus')
    })
    await page.evaluate(
      (fsPath) => window.__E2E__!.openFileUri(fsPath),
      launchWorkspace.file('pkg.json'),
    )
    await expect
      .poll(() => workbench.getContextKey<string>('activeEditorLanguageId'), {
        timeout: GENERATION_TIMEOUT_MS * 2,
      })
      .toBe('json')
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getOutlineSymbols()), {
        timeout: GENERATION_TIMEOUT_MS * 2,
      })
      .toContain('gen_0000')

    const session = await page.context().newCDPSession(page)
    try {
      await session.send('HeapProfiler.enable')

      /** 强制回收并证明这一轮确实收得掉不可达对象；证明不了就让本轮读数作废。 */
      const verifyGcControl = async (): Promise<void> => {
        for (let attempt = 0; attempt < 3; attempt++) {
          await page.evaluate(() => window.__E2E__!.armGcControl())
          await session.send('HeapProfiler.collectGarbage')
          // 同一个 task 内创建的 WeakRef 要到该 task 结束才可能被清空，回收结果必须在新
          // task 里观察。
          await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 100)))
          if ((await page.evaluate(() => window.__E2E__!.getGcControlState())) === 'collected') {
            return
          }
        }
        throw new Error(
          '强制回收后控制对象仍存活：这一轮未能证明不可达对象可被回收，' +
            '同批 outline 存活数不可解释（不代表 GC 没跑，也不代表应用泄漏）',
        )
      }

      // 先验一次，让不支持的机器在驱动几十代之前就失败。
      await verifyGcControl()

      const driveGenerations = async (from: number): Promise<void> => {
        for (let i = 0; i < GENERATIONS_PER_SEGMENT; i++) {
          const name = `gen_${String(from + i).padStart(4, '0')}`
          const accepted = await page.evaluate(
            (text) => window.__E2E__!.setActiveEditorText(text),
            jsonFor(name),
          )
          expect(accepted, `当前没有文件编辑器能接受 ${name} 的文本`).toBe(true)
          // 服务侧：符号确实换成了这一代。
          await expect
            .poll(() => page.evaluate(() => window.__E2E__!.getOutlineSymbols()), {
              timeout: GENERATION_TIMEOUT_MS,
            })
            .toContain(name)
          // DOM 侧：对应行确实落地。用行数而不是可见性——Allotment.Pane 用 CSS
          // visibility 隐藏后代，DOM 可见性会误判。
          await expect(page.getByRole('treeitem', { name })).toHaveCount(1, {
            timeout: GENERATION_TIMEOUT_MS,
          })
        }
      }

      const readStats = async () => {
        await verifyGcControl()
        return page.evaluate(() => window.__E2E__!.getOutlineRetentionStats())
      }

      await page.evaluate(() => window.__E2E__!.startOutlineRetentionProbe())
      await driveGenerations(1)
      const afterFirst = await readStats()
      await driveGenerations(1 + GENERATIONS_PER_SEGMENT)
      const afterSecond = await readStats()

      // 只打印数字，不含符号正文与路径。
      console.log(
        `[outline-retention] afterFirst=${JSON.stringify(afterFirst)} ` +
          `afterSecond=${JSON.stringify(afterSecond)}`,
      )

      expect(afterSecond.dropped).toBe(0)
      expect(afterSecond.generations).toBeGreaterThanOrEqual(2 * GENERATIONS_PER_SEGMENT)
      // 有界持有者而不是精确值：live 集合可以含挂载中的那一代、React 双树与符号缓存，
      // 但绝不能是「更新了多少次」的函数。
      const liveGrowth = afterSecond.aliveGenerations - afterFirst.aliveGenerations
      expect(afterFirst.aliveGenerations).toBeLessThanOrEqual(LIVE_BOUND)
      expect(afterSecond.aliveGenerations).toBeLessThanOrEqual(LIVE_BOUND)
      expect(liveGrowth).toBeLessThanOrEqual(LIVE_SLACK)
    } finally {
      await page.evaluate(() => window.__E2E__!.stopOutlineRetentionProbe()).catch(() => {})
      await session.detach().catch(() => {})
    }
  })
})
