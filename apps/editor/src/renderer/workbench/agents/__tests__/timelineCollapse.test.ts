/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for timelineCollapse — per-kind collapse defaults and override resolution.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type {
  AcpChildItem,
  AcpToolCall,
  TimelineItem,
} from '../../../services/acp/session/acpSession.js'
import {
  defaultCollapsed,
  foldedAncestorKeys,
  nextCollapseMode,
  resolveCollapsed,
  visibleFocusKey,
} from '../timelineCollapse.js'

function makeCall(overrides: Partial<AcpToolCall>): AcpToolCall {
  return {
    id: 't1',
    title: 'a tool call',
    kind: 'other',
    status: 'completed',
    text: '',
    blocks: [],
    diffs: [],
    ...overrides,
  }
}

function toolCallItem(call: AcpToolCall): TimelineItem {
  return { kind: 'toolCall', id: call.id, call } as TimelineItem
}

const agentResult = toolCallItem(
  makeCall({
    kind: 'edit',
    title: 'Saved Explore result: 20260829-sess-agent.md',
    diffs: [
      {
        path: '/repo/.claude/explore-results/20260829-sess-agent.md',
        oldText: '',
        newText: '# Explore subagent result\n',
      },
    ],
  }),
)

const createdSourceFile = toolCallItem(
  makeCall({
    kind: 'edit',
    title: 'Write newModule.ts',
    diffs: [{ path: '/repo/src/newModule.ts', oldText: '', newText: 'export const a = 1\n' }],
  }),
)

const trimmedEdit = toolCallItem(
  makeCall({
    kind: 'edit',
    title: 'Write newModule.ts',
    memoryTrimmed: true,
    diffs: [{ path: '/repo/src/newModule.ts', oldText: '', newText: '' }],
  }),
)

const ordinaryEdit = toolCallItem(
  makeCall({
    kind: 'edit',
    title: 'Edit foo.ts',
    diffs: [{ path: '/repo/src/foo.ts', oldText: 'a', newText: 'b' }],
  }),
)

// A sub-agent chain two levels deep, the shape the ancestor-walking helpers are
// tested against: a user message, then a Task card whose sub-agent timeline holds
// a message and a nested Task card. Every Task card is kind 'other', so it is
// folded under the default mode.
const childMessage = (id: string): AcpChildItem => ({
  kind: 'message',
  id,
  message: { id, role: 'agent', text: id, blocks: [], streaming: false },
})

const nestedTask = (id: string, children: readonly AcpChildItem[]): AcpChildItem => ({
  kind: 'toolCall',
  id,
  call: makeCall({ id, kind: 'other', children }),
})

const subAgentTimeline: readonly TimelineItem[] = [
  {
    kind: 'message',
    id: 'u',
    message: { id: 'u', role: 'user', text: 'hi', blocks: [], streaming: false },
  },
  toolCallItem(
    makeCall({
      id: 'task',
      kind: 'other',
      children: [childMessage('sm1'), nestedTask('sub', [childMessage('sm2')])],
    }),
  ),
]

const nestedKey = 't:task/t:sub/m:sm2'

describe('defaultCollapsed', () => {
  it('folds a sub-agent result document even though it is an edit card', () => {
    expect(defaultCollapsed(agentResult, 'default')).toBe(true)
  })

  it('folds a whole-file write of any file type', () => {
    expect(defaultCollapsed(createdSourceFile, 'default')).toBe(true)
  })

  it('keeps a memory-trimmed edit card expanded (blanked oldText is not a create)', () => {
    expect(defaultCollapsed(trimmedEdit, 'default')).toBe(false)
  })

  it('keeps an ordinary edit card expanded', () => {
    expect(defaultCollapsed(ordinaryEdit, 'default')).toBe(false)
  })

  it('keeps switch_mode expanded and folds read/search', () => {
    expect(defaultCollapsed(toolCallItem(makeCall({ kind: 'switch_mode' })), 'default')).toBe(false)
    expect(defaultCollapsed(toolCallItem(makeCall({ kind: 'read' })), 'default')).toBe(true)
    expect(defaultCollapsed(toolCallItem(makeCall({ kind: 'search' })), 'default')).toBe(true)
  })

  it('lets the explicit modes win over every per-kind default', () => {
    expect(defaultCollapsed(agentResult, 'expanded')).toBe(false)
    expect(defaultCollapsed(ordinaryEdit, 'collapsed')).toBe(true)
  })
})

describe('resolveCollapsed', () => {
  it('lets a per-item override win over the folded default', () => {
    const state = { mode: 'default', overrides: new Map([['t:t1', false]]) } as const
    expect(resolveCollapsed('t:t1', agentResult, state)).toBe(false)
  })

  it('falls back to the default when no override exists for the key', () => {
    const state = { mode: 'default', overrides: new Map<string, boolean>() } as const
    expect(resolveCollapsed('t:t1', agentResult, state)).toBe(true)
  })
})

describe('nextCollapseMode', () => {
  it('cycles default → collapsed → expanded → default', () => {
    expect(nextCollapseMode('default')).toBe('collapsed')
    expect(nextCollapseMode('collapsed')).toBe('expanded')
    expect(nextCollapseMode('expanded')).toBe('default')
  })
})

describe('foldedAncestorKeys', () => {
  it('lists every folded ancestor of a nested key, outermost first', () => {
    const state = { mode: 'default', overrides: new Map<string, boolean>() } as const
    expect(foldedAncestorKeys(subAgentTimeline, nestedKey, state)).toEqual([
      't:task',
      't:task/t:sub',
    ])
  })

  it('skips ancestors that are already expanded', () => {
    const state = {
      mode: 'default',
      overrides: new Map([
        ['t:task', false],
        ['t:task/t:sub', false],
      ]),
    } as const
    expect(foldedAncestorKeys(subAgentTimeline, nestedKey, state)).toEqual([])
  })

  it('reports the folded prefix that an explicit mode leaves standing', () => {
    const state = { mode: 'collapsed', overrides: new Map([['t:task', false]]) } as const
    expect(foldedAncestorKeys(subAgentTimeline, nestedKey, state)).toEqual(['t:task/t:sub'])
  })

  it('returns nothing for a top-level key — it has no ancestors to unfold', () => {
    const state = { mode: 'default', overrides: new Map<string, boolean>() } as const
    expect(foldedAncestorKeys(subAgentTimeline, 't:task', state)).toEqual([])
  })

  // The target's own fold is not the caller's business: a folded card still
  // renders its header row, which is exactly where the reveal lands.
  it('leaves a folded target itself alone', () => {
    const state = { mode: 'default', overrides: new Map([['t:task', false]]) } as const
    expect(foldedAncestorKeys(subAgentTimeline, 't:task/t:sub', state)).toEqual([])
  })

  it('returns nothing when the key resolves to no item', () => {
    const state = { mode: 'default', overrides: new Map<string, boolean>() } as const
    expect(foldedAncestorKeys(subAgentTimeline, 't:task/m:gone', state)).toEqual([])
    expect(foldedAncestorKeys(subAgentTimeline, 't:gone/m:sm1', state)).toEqual([])
  })
})

describe('visibleFocusKey', () => {
  it('converges a nested key onto its outermost folded ancestor', () => {
    const state = { mode: 'default', overrides: new Map<string, boolean>() } as const
    expect(visibleFocusKey(subAgentTimeline, nestedKey, state)).toBe('t:task')
  })

  it('converges onto the folded ancestor nearest the key, not the outermost', () => {
    const state = { mode: 'default', overrides: new Map([['t:task', false]]) } as const
    expect(visibleFocusKey(subAgentTimeline, nestedKey, state)).toBe('t:task/t:sub')
  })

  it('keeps an unblocked nested key as-is', () => {
    const state = {
      mode: 'default',
      overrides: new Map([
        ['t:task', false],
        ['t:task/t:sub', false],
      ]),
    } as const
    expect(visibleFocusKey(subAgentTimeline, nestedKey, state)).toBe(nestedKey)
  })

  it('keeps a stale key untouched — the caller decides what to do with it', () => {
    const state = { mode: 'default', overrides: new Map<string, boolean>() } as const
    expect(visibleFocusKey(subAgentTimeline, 't:gone/m:sm1', state)).toBe('t:gone/m:sm1')
  })
})
