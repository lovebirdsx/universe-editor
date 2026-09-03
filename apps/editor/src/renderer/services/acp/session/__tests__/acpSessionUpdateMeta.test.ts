/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the `_meta` readers in acpSessionUpdateMeta — focused on the
 *  sub-agent stats parser (readSubagentStats) and the per-model cost breakdown.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import {
  extractModelBreakdown,
  readFileChanges,
  readSubagentStats,
  readSyntheticDenial,
} from '../acpSessionUpdateMeta.js'

describe('extractModelBreakdown', () => {
  function breakdown(row: Record<string, unknown>) {
    return extractModelBreakdown({ _meta: { '_universe/modelBreakdown': [row] } })
  }

  it('returns [] when the meta bag is absent or malformed', () => {
    expect(extractModelBreakdown({})).toEqual([])
    expect(extractModelBreakdown({ _meta: {} })).toEqual([])
    expect(extractModelBreakdown({ _meta: { '_universe/modelBreakdown': 'nope' } })).toEqual([])
  })

  it('parses a turn-final row with its authoritative cost', () => {
    expect(
      breakdown({
        model: 'claude-opus-5',
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheCreateTokens: 100,
        costUSD: 0.42,
      }),
    ).toEqual([
      {
        model: 'claude-opus-5',
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheCreateTokens: 100,
        costUSD: 0.42,
      },
    ])
  })

  // Mid-turn rows omit costUSD: only the terminal `result` reports one. Absent
  // has to stay absent (= unknown, priced locally) rather than collapse to 0,
  // or the popover would claim every running turn was free.
  it('leaves costUSD undefined when the fork reported none', () => {
    const [row] = breakdown({ model: 'acme-chat-pro', inputTokens: 1000 })
    expect(row).toEqual({
      model: 'acme-chat-pro',
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    })
    expect(row).not.toHaveProperty('costUSD')
  })

  it('keeps a reported zero cost distinct from an absent one', () => {
    expect(breakdown({ model: 'claude-opus-5', costUSD: 0 })[0]?.costUSD).toBe(0)
  })

  it('drops a non-finite or non-numeric cost', () => {
    expect(breakdown({ model: 'claude-opus-5', costUSD: 'free' })[0]).not.toHaveProperty('costUSD')
    expect(breakdown({ model: 'claude-opus-5', costUSD: Number.NaN })[0]).not.toHaveProperty(
      'costUSD',
    )
  })

  it('skips rows with no model id', () => {
    expect(
      extractModelBreakdown({
        _meta: { '_universe/modelBreakdown': [{ inputTokens: 10 }, null, { model: 'ok' }] },
      }),
    ).toHaveLength(1)
  })
})

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

describe('readSyntheticDenial', () => {
  function update(meta: Record<string, unknown>): SessionUpdate {
    return {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      _meta: meta,
    } as unknown as SessionUpdate
  }

  it('reads the flag when the fork stamped it', () => {
    expect(readSyntheticDenial(update({ claudeCode: { syntheticDenial: true } }))).toBe(true)
  })

  it('returns false when the flag is absent', () => {
    expect(readSyntheticDenial(update({ claudeCode: {} }))).toBe(false)
    expect(readSyntheticDenial(update({ claudeCode: { syntheticDenial: false } }))).toBe(false)
    expect(readSyntheticDenial(update({ claudeCode: { syntheticDenial: 'yes' } }))).toBe(false)
  })

  it('returns false when _meta or claudeCode is missing', () => {
    expect(
      readSyntheticDenial({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
      } as unknown as SessionUpdate),
    ).toBe(false)
    expect(readSyntheticDenial(update({}))).toBe(false)
    expect(readSyntheticDenial(update({ claudeCode: null }))).toBe(false)
  })
})

const HUNK = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }

function claudeUpdate(toolResponse: Record<string, unknown>, toolName = 'Edit'): SessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-1',
    _meta: { claudeCode: { toolName, toolResponse } },
  } as unknown as SessionUpdate
}

function codexUpdate(content: unknown[]): SessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-1',
    content,
  } as unknown as SessionUpdate
}

function claudeOptimisticUpdate(toolName: string, content: unknown[]): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-1',
    _meta: { claudeCode: { toolName } },
    content,
  } as unknown as SessionUpdate
}

describe('readFileChanges — claude structuredPatch path', () => {
  it('passes originalFile through as the baseline for an Edit', () => {
    const changes = readFileChanges(
      claudeUpdate({
        filePath: '/work/a.ts',
        structuredPatch: [HUNK],
        originalFile: 'the full pre-edit content',
      }),
    )
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      path: '/work/a.ts',
      isCreate: false,
      baseline: 'the full pre-edit content',
    })
    expect(changes[0]?.hunks).toHaveLength(1)
  })

  it('treats Edit with originalFile null as a modify with no reported baseline', () => {
    // claude-code ≥2.1.226 reports originalFile:null on the 2nd+ Edit of a file
    // (the Edit result carries no `type`) — not a create signal.
    const changes = readFileChanges(
      claudeUpdate({ filePath: '/work/a.ts', structuredPatch: [HUNK], originalFile: null }),
    )
    expect(changes).toHaveLength(1)
    expect(changes[0]?.isCreate).toBe(false)
    expect('baseline' in changes[0]!).toBe(false)
  })

  it('reports baseline null for a Write create (originalFile null)', () => {
    const changes = readFileChanges(
      claudeUpdate({ filePath: '/work/new.ts', structuredPatch: [], originalFile: null }, 'Write'),
    )
    expect(changes).toHaveLength(1)
    expect(changes[0]?.isCreate).toBe(true)
    expect(changes[0]?.baseline).toBeNull()
  })

  it('reports baseline null for a create signalled by type alone', () => {
    const changes = readFileChanges(
      claudeUpdate({ filePath: '/work/new.ts', structuredPatch: [], type: 'create' }, 'Write'),
    )
    expect(changes).toHaveLength(1)
    expect(changes[0]?.isCreate).toBe(true)
    expect(changes[0]?.baseline).toBeNull()
  })

  it('omits baseline when the agent did not report originalFile', () => {
    const changes = readFileChanges(
      claudeUpdate({ filePath: '/work/a.ts', structuredPatch: [HUNK] }),
    )
    expect(changes).toHaveLength(1)
    expect(changes[0]?.baseline).toBeUndefined()
    expect('baseline' in changes[0]!).toBe(false)
  })

  it('ignores non-Edit/Write tools', () => {
    const changes = readFileChanges(
      claudeUpdate({ filePath: '/work/a.ts', structuredPatch: [HUNK] }, 'Bash'),
    )
    expect(changes).toHaveLength(0)
  })
})

describe('readFileChanges — claude optimistic tool_call diff content', () => {
  it('ignores the pre-execution Edit preview (oldText is an old_string fragment)', () => {
    const changes = readFileChanges(
      claudeOptimisticUpdate('Edit', [
        { type: 'diff', path: '/work/a.ts', oldText: 'just the old_string fragment', newText: 'x' },
      ]),
    )
    expect(changes).toEqual([])
  })

  it('ignores the pre-execution Write preview (oldText null)', () => {
    const changes = readFileChanges(
      claudeOptimisticUpdate('Write', [
        { type: 'diff', path: '/work/new.ts', oldText: null, newText: 'body' },
      ]),
    )
    expect(changes).toEqual([])
  })
})

describe('readFileChanges — codex diff-content path', () => {
  it('passes oldText through as the baseline', () => {
    const changes = readFileChanges(
      codexUpdate([{ type: 'diff', path: '/work/b.ts', oldText: 'before', newText: 'after' }]),
    )
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ path: '/work/b.ts', isCreate: false, baseline: 'before' })
  })

  it('reports baseline null for a create (oldText null)', () => {
    const changes = readFileChanges(
      codexUpdate([{ type: 'diff', path: '/work/new.ts', oldText: null, newText: 'body' }]),
    )
    expect(changes).toHaveLength(1)
    expect(changes[0]?.isCreate).toBe(true)
    expect(changes[0]?.baseline).toBeNull()
  })

  it('drops a no-op diff (oldText === newText)', () => {
    const changes = readFileChanges(
      codexUpdate([{ type: 'diff', path: '/work/b.ts', oldText: 'same', newText: 'same' }]),
    )
    expect(changes).toHaveLength(0)
  })
})
