import type { Page } from '@playwright/test'

// 滚动容器是 ol[data-testid="acp-timeline"] 的父级 div（chatBody）。
const TIMELINE = '[data-testid="acp-timeline"]'

/**
 * ACP chat 虚拟化 timeline 的滚动定位。
 *
 * 虚拟模式下上方未挂载行回退到 estimateRow 估算，估计坐标系与真实坐标系偏离，
 * 因此「像素中点 (scrollHeight-clientHeight)/2」落到的消息是不确定的——实测可落
 * m11/m22，CI 慢机上甚至落到末条（距底 <STICK_THRESHOLD_PX 时被 handleScroll 记成
 * stuck=true，「中部恢复」场景退化成「贴底恢复」的假阳性）。定位必须按锚定索引
 * 反馈迭代：设 frac → 等锚 settle → 按 锚≈k·frac 割线折算下一步，直到顶部锚落进
 * 目标带。
 */
export class AcpTimelinePO {
  constructor(private readonly page: Page) {}

  // 当前视口顶部锚定的 slot 索引——复用产品 captureAnchor 的语义（第一条 bottom
  // 仍在视口内的行），把 m:m<idx> 解析成数字。这是 restore 真正保证的不变量，
  // 不受 max 随懒测量增长导致的 frac 漂移影响。
  async readTopIndex(): Promise<number> {
    return this.page.evaluate((sel) => {
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
  }

  // 等顶部锚定索引稳定（懒测量收敛前会抖一两条）：连续 4 帧同值即认定收敛。
  async settleTopIndex(): Promise<number> {
    let last = -999
    let streak = 0
    for (let i = 0; i < 40; i++) {
      const idx = await this.readTopIndex()
      streak = idx === last ? streak + 1 : 0
      last = idx
      if (streak >= 4) return idx
      await this.page.waitForTimeout(80)
    }
    return last
  }

  // 迭代滚动直到顶部锚落进 [lo, hi] 并返回该索引；收敛不了时返回最后一次读数，
  // 由调用方断言失败。frac→锚索引 单调，割线步 2~3 次内收敛。
  async scrollToAnchorBand(band: { lo: number; hi: number }): Promise<number> {
    const target = Math.floor((band.lo + band.hi) / 2)
    let frac = 0.5
    let idx = -1
    for (let attempt = 0; attempt < 8; attempt++) {
      await this.page.evaluate(
        ([sel, f]) => {
          const el = document.querySelector(sel)!.parentElement as HTMLElement
          el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) * f)
          el.dispatchEvent(new Event('scroll'))
        },
        [TIMELINE, frac] as const,
      )
      idx = await this.settleTopIndex()
      if (idx >= band.lo && idx <= band.hi) return idx
      if (idx < 0) break
      frac = Math.min(0.95, Math.max(0.02, (frac * target) / idx))
    }
    return idx
  }
}
