/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for timelineCollapse — per-kind collapse defaults and override resolution.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AcpToolCall, TimelineItem } from '../../../services/acp/session/acpSession.js'
import { defaultCollapsed, nextCollapseMode, resolveCollapsed } from '../timelineCollapse.js'

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

const ordinaryEdit = toolCallItem(
  makeCall({
    kind: 'edit',
    title: 'Edit foo.ts',
    diffs: [{ path: '/repo/src/foo.ts', oldText: 'a', newText: 'b' }],
  }),
)

describe('defaultCollapsed', () => {
  it('folds a sub-agent result document even though it is an edit card', () => {
    expect(defaultCollapsed(agentResult, 'default')).toBe(true)
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
