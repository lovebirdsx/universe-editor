/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/memory/rendererIncarnation.ts
 *  格式是与 main 消毒器的契约：不符合 `/^[a-z0-9-]{1,40}$/i` 的 id 会被读成「没有 incarnation」，
 *  等于悄悄关掉迟到样本的守卫。
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { createRendererIncarnation, RENDERER_INCARNATION } from '../rendererIncarnation.js'

/** 与 main 消毒入站样本时用的模式完全一致。 */
const ACCEPTED = /^[a-z0-9-]{1,40}$/i

describe('createRendererIncarnation', () => {
  it('produces an id main will accept', () => {
    expect(createRendererIncarnation()).toMatch(ACCEPTED)
  })

  it('separates two contexts started in the same millisecond', () => {
    // reload 在同一毫秒内启起新上下文是常见到会出事的情形；id 撞了，守卫会把活 renderer
    // 自己的样本丢掉。
    const ids = new Set<string>()
    for (let i = 0; i < 64; i++) ids.add(createRendererIncarnation(1_700_000_000_000))
    expect(ids.size).toBeGreaterThan(50)
  })

  it('stays inside the length bound even for a far-future clock', () => {
    // 36 进制会一直变长；40 是 main 强制的最长长度。
    expect(createRendererIncarnation(9_999_999_999_999)).toMatch(ACCEPTED)
  })

  it('survives a random source that returns its bounds', () => {
    // `Math.random` 是 [0, 1)：0 合法，而被桩成 1 时不能越过字母表，否则 id 里会拼进
    // `undefined`。
    expect(createRendererIncarnation(1, () => 0)).toMatch(ACCEPTED)
    expect(createRendererIncarnation(1, () => 1)).toMatch(ACCEPTED)
  })

  it('carries the start time so a log reader can date the context', () => {
    // 36 进制跨位数不保序，所以这个前缀是给人读的时间戳，不是排序键。
    expect(createRendererIncarnation(1_700_000_000_000, () => 0)).toContain(
      (1_700_000_000_000).toString(36),
    )
  })

  it('ships a module-scope id that is already valid', () => {
    expect(RENDERER_INCARNATION).toMatch(ACCEPTED)
  })
})
