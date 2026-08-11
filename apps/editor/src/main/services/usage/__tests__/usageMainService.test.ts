/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { toSnapshot } from '../usageMainService.js'

describe('toSnapshot', () => {
  it('maps provider fields to camelCase snapshot', () => {
    const snapshot = toSnapshot({
      date: '20260811',
      requests: 3,
      raw_tokens: 1200,
      period_bucket: 'week:2026W33',
      period_limit_cny: 30000000,
      period_used_cny: 12345,
      period_remaining_cny: 29987655,
      models: [{ model: 'claude-opus', requests: 3, raw_tokens: 1200, cost_cny: 12345 }],
    })
    expect(snapshot).toEqual({
      date: '20260811',
      requests: 3,
      rawTokens: 1200,
      periodBucket: 'week:2026W33',
      periodLimitCny: 30000000,
      periodUsedCny: 12345,
      periodRemainingCny: 29987655,
      models: [{ model: 'claude-opus', requests: 3, rawTokens: 1200, costCny: 12345 }],
    })
  })

  it('coerces missing/null numeric fields to 0 instead of NaN', () => {
    const snapshot = toSnapshot({
      date: '20260811',
      period_bucket: 'week:2026W33',
      // 未产生消费时接口可能省略数值字段或返回 null
      requests: undefined as unknown as number,
      raw_tokens: null as unknown as number,
      period_limit_cny: 30000000,
      period_used_cny: undefined as unknown as number,
      period_remaining_cny: null as unknown as number,
      models: [
        {
          model: 'claude-opus',
          requests: undefined as unknown as number,
          raw_tokens: '0' as unknown as number,
          cost_cny: null as unknown as number,
        },
      ],
    })
    expect(snapshot.periodUsedCny).toBe(0)
    expect(snapshot.periodRemainingCny).toBe(0)
    expect(snapshot.requests).toBe(0)
    expect(snapshot.rawTokens).toBe(0)
    expect(snapshot.models[0]).toEqual({
      model: 'claude-opus',
      requests: 0,
      rawTokens: 0,
      costCny: 0,
    })
  })

  it('coerces NaN to 0', () => {
    const snapshot = toSnapshot({
      date: '20260811',
      requests: Number.NaN,
      raw_tokens: Number.NaN,
      period_bucket: 'week:2026W33',
      period_limit_cny: Number.NaN,
      period_used_cny: Number.NaN,
      period_remaining_cny: Number.NaN,
      models: [],
    })
    expect(snapshot.periodUsedCny).toBe(0)
    expect(snapshot.periodLimitCny).toBe(0)
  })
})
