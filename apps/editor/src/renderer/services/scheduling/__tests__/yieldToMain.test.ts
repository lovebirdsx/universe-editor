/*---------------------------------------------------------------------------------------------
 *  Tests for yieldToMain: prefer scheduler.yield when the host provides it,
 *  otherwise hand control back at a real macrotask boundary (a microtask would
 *  not let input/paint run).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { yieldToMain } from '../yieldToMain.js'

type SchedulerHost = { scheduler?: { yield?: () => Promise<void> } }

afterEach(() => {
  delete (globalThis as SchedulerHost).scheduler
})

describe('yieldToMain', () => {
  it('falls back to a macrotask when scheduler.yield is absent', async () => {
    const events: string[] = []
    setTimeout(() => events.push('timer'), 0)
    await yieldToMain()
    events.push('yielded')
    // 定时器（宏任务）先于本函数的续体执行：让出确实跨了宏任务边界。
    expect(events).toEqual(['timer', 'yielded'])
  })

  it('delegates to scheduler.yield when available', async () => {
    let calls = 0
    ;(globalThis as SchedulerHost).scheduler = {
      yield: () => {
        calls++
        return Promise.resolve()
      },
    }
    await yieldToMain()
    expect(calls).toBe(1)
  })
})
