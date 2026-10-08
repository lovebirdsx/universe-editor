import { describe, expect, it, vi } from 'vitest'
import type { Page } from '@playwright/test'
import { waitForProbeServiceable } from '../pages/WorkbenchPO.js'

function fakePage(evaluate: () => Promise<unknown>): Page {
  return { evaluate } as unknown as Page
}

describe('waitForProbeServiceable', () => {
  it('窗口应答即通过，不看 windows 返回了什么', async () => {
    const evaluate = vi.fn().mockResolvedValue(undefined)
    await waitForProbeServiceable(fakePage(evaluate))
    expect(evaluate).toHaveBeenCalledTimes(1)
  })

  it('真实 IPC 拒绝原样上抛，不被吞成「未就绪」', async () => {
    const page = fakePage(() => Promise.reject(new Error('IPC channel closed by main')))
    await expect(waitForProbeServiceable(page)).rejects.toThrow('IPC channel closed by main')
  })

  it('窗口已关闭的报错同样上抛', async () => {
    const page = fakePage(() =>
      Promise.reject(new Error('Target page, context or browser has been closed')),
    )
    await expect(waitForProbeServiceable(page)).rejects.toThrow(/has been closed/)
  })

  it('探测永不 resolve 时在 poll 超时处有界失败', async () => {
    vi.useFakeTimers()
    try {
      const page = fakePage(() => new Promise<never>(() => undefined))
      const settled = expect(waitForProbeServiceable(page)).rejects.toThrow(/Timeout 20000ms/)
      await vi.advanceTimersByTimeAsync(20_000)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })
})
