/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the `_meta` readers in acpSessionUpdateMeta — focused on the
 *  sub-agent stats parser (readSubagentStats).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { readSubagentStats } from '../acpSessionUpdateMeta.js'

describe('readSubagentStats', () => {
  it('parses a full sub-agent tally', () => {
    const stats = readSubagentStats({
      _meta: {
        '_universe/subagentStats': {
          model: 'claude-sonnet-5',
          subagentType: 'general-purpose',
          inputTokens: 1200,
          outputTokens: 340,
          cacheReadTokens: 5000,
          cacheCreateTokens: 200,
        },
      },
    })
    expect(stats).toEqual({
      model: 'claude-sonnet-5',
      subagentType: 'general-purpose',
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 5000,
      cacheCreateTokens: 200,
    })
  })

  it('defaults missing token fields to 0 and omits absent strings', () => {
    const stats = readSubagentStats({
      _meta: { '_universe/subagentStats': { inputTokens: 10 } },
    })
    expect(stats).toEqual({
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    })
    expect(stats?.model).toBeUndefined()
    expect(stats?.subagentType).toBeUndefined()
  })

  it('returns undefined when the meta is absent or malformed', () => {
    expect(readSubagentStats({})).toBeUndefined()
    expect(readSubagentStats({ _meta: {} })).toBeUndefined()
    expect(readSubagentStats({ _meta: { '_universe/subagentStats': 42 } })).toBeUndefined()
    expect(readSubagentStats({ _meta: { '_universe/subagentStats': null } })).toBeUndefined()
  })
})
