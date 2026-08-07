/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the `_meta` readers in acpSessionUpdateMeta — focused on the
 *  sub-agent stats parser (readSubagentStats).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { readFileChanges, readSubagentStats } from '../acpSessionUpdateMeta.js'

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

  it('reports baseline null for a create (originalFile null)', () => {
    const changes = readFileChanges(
      claudeUpdate({ filePath: '/work/new.ts', structuredPatch: [], originalFile: null }),
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
