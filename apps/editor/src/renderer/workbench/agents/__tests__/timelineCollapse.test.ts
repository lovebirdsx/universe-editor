/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for timelineCollapse — per-kind collapse defaults, override resolution, and the
 *  at-most-one-open rule for sub-agent cards.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { CollapseMode } from '../../../services/acp/session/acpChatViewStateCache.js'
import type {
  AcpChildItem,
  AcpToolCall,
  TimelineItem,
} from '../../../services/acp/session/acpSession.js'
import {
  defaultCollapsed,
  foldedAncestorKeys,
  isSubagentCard,
  isSubagentSlot,
  nextCollapseMode,
  resolveCollapsed,
  subtreeCardKeys,
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

const collapseState = (
  mode: CollapseMode,
  overrides: ReadonlyArray<readonly [string, boolean]> = [],
  openSubagent: string | null = null,
) => ({ mode, overrides: new Map(overrides), openSubagent })

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

const taskCard = makeCall({
  id: 'task',
  kind: 'other',
  children: [childMessage('sm1'), nestedTask('sub', [childMessage('sm2')])],
})

const subAgentTimeline: readonly TimelineItem[] = [
  {
    kind: 'message',
    id: 'u',
    message: { id: 'u', role: 'user', text: 'hi', blocks: [], streaming: false },
  },
  toolCallItem(taskCard),
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
    const state = collapseState('default', [['t:t1', false]])
    expect(resolveCollapsed('t:t1', agentResult, state)).toBe(false)
  })

  it('falls back to the default when no override exists for the key', () => {
    const state = collapseState('default')
    expect(resolveCollapsed('t:t1', agentResult, state)).toBe(true)
  })
})

describe('isSubagentCard / isSubagentSlot', () => {
  it('counts a card the fork stamped as a sub-agent parent', () => {
    expect(isSubagentCard(toolCallItem(makeCall({ subagent: true })))).toBe(true)
  })

  it('counts a card that carries a sub-agent timeline without the stamp (replay)', () => {
    expect(isSubagentCard(toolCallItem(taskCard))).toBe(true)
  })

  it('ignores ordinary cards, including one with an empty child list', () => {
    expect(isSubagentCard(ordinaryEdit)).toBe(false)
    expect(isSubagentCard(toolCallItem(makeCall({ children: [] })))).toBe(false)
    expect(isSubagentCard(childMessage('sm1'))).toBe(false)
  })

  it('treats a nested card as content, never as a card of its own', () => {
    const nested = nestedTask('sub', [childMessage('sm2')])
    expect(isSubagentCard(nested)).toBe(true)
    expect(isSubagentSlot('t:task/t:sub', nested)).toBe(false)
    expect(isSubagentSlot('t:task', toolCallItem(taskCard))).toBe(true)
  })
})

describe('sub-agent exclusivity', () => {
  const item = toolCallItem(taskCard)

  it('keeps an undesignated sub-agent card folded whatever the mode says', () => {
    expect(resolveCollapsed('t:task', item, collapseState('default'))).toBe(true)
    expect(resolveCollapsed('t:task', item, collapseState('expanded'))).toBe(true)
    expect(resolveCollapsed('t:task', item, collapseState('collapsed'))).toBe(true)
  })

  it('opens the designated card — and only from the designation', () => {
    expect(resolveCollapsed('t:task', item, collapseState('default', [], 't:task'))).toBe(false)
    expect(resolveCollapsed('t:task', item, collapseState('expanded', [], 't:task'))).toBe(false)
  })

  it('lets a designation beat an explicit override', () => {
    // Nothing writes overrides for sub-agent slots any more; a stale one must not
    // be able to fold the card the user has open.
    expect(
      resolveCollapsed('t:task', item, collapseState('expanded', [['t:task', true]], 't:task')),
    ).toBe(false)
  })

  it('opens the same card under a different designation', () => {
    expect(resolveCollapsed('t:task', item, collapseState('default', [], 't:other'))).toBe(true)
  })

  it('leaves nested cards on the ordinary override / mode path', () => {
    const nested = nestedTask('sub', [childMessage('sm2')])
    const key = 't:task/t:sub'
    expect(resolveCollapsed(key, nested, collapseState('default', [], 't:task'))).toBe(true)
    expect(resolveCollapsed(key, nested, collapseState('default', [[key, false]], 't:task'))).toBe(
      false,
    )
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
    expect(foldedAncestorKeys(subAgentTimeline, nestedKey, collapseState('default'))).toEqual([
      't:task',
      't:task/t:sub',
    ])
  })

  it('skips ancestors that are already expanded', () => {
    // The Task card is opened by designating it, its nested card by an override —
    // the two mechanisms that can unfold anything on this path.
    const state = collapseState('default', [['t:task/t:sub', false]], 't:task')
    expect(foldedAncestorKeys(subAgentTimeline, nestedKey, state)).toEqual([])
  })

  it('reports the folded prefix that an explicit mode leaves standing', () => {
    const state = collapseState('collapsed', [], 't:task')
    expect(foldedAncestorKeys(subAgentTimeline, nestedKey, state)).toEqual(['t:task/t:sub'])
  })

  it('returns nothing for a top-level key — it has no ancestors to unfold', () => {
    expect(foldedAncestorKeys(subAgentTimeline, 't:task', collapseState('default'))).toEqual([])
  })

  // The target's own fold is not the caller's business: a folded card still
  // renders its header row, which is exactly where the reveal lands.
  it('leaves a folded target itself alone', () => {
    const state = collapseState('default', [], 't:task')
    expect(foldedAncestorKeys(subAgentTimeline, 't:task/t:sub', state)).toEqual([])
  })

  it('returns nothing when the key resolves to no item', () => {
    const state = collapseState('default')
    expect(foldedAncestorKeys(subAgentTimeline, 't:task/m:gone', state)).toEqual([])
    expect(foldedAncestorKeys(subAgentTimeline, 't:gone/m:sm1', state)).toEqual([])
  })
})

describe('visibleFocusKey', () => {
  it('converges a nested key onto its outermost folded ancestor', () => {
    expect(visibleFocusKey(subAgentTimeline, nestedKey, collapseState('default'))).toBe('t:task')
  })

  it('converges onto the folded ancestor nearest the key, not the outermost', () => {
    const state = collapseState('default', [], 't:task')
    expect(visibleFocusKey(subAgentTimeline, nestedKey, state)).toBe('t:task/t:sub')
  })

  it('keeps an unblocked nested key as-is', () => {
    const state = collapseState('default', [['t:task/t:sub', false]], 't:task')
    expect(visibleFocusKey(subAgentTimeline, nestedKey, state)).toBe(nestedKey)
  })

  it('keeps a stale key untouched — the caller decides what to do with it', () => {
    expect(visibleFocusKey(subAgentTimeline, 't:gone/m:sm1', collapseState('default'))).toBe(
      't:gone/m:sm1',
    )
  })
})

describe('subtreeCardKeys', () => {
  it('lists a card and its descendants in pre-order, with composite keys', () => {
    expect(subtreeCardKeys(subAgentTimeline, 't:task')).toEqual([
      't:task',
      't:task/m:sm1',
      't:task/t:sub',
      't:task/t:sub/m:sm2',
    ])
  })

  it('starts from a nested card when that is the target', () => {
    expect(subtreeCardKeys(subAgentTimeline, 't:task/t:sub')).toEqual([
      't:task/t:sub',
      't:task/t:sub/m:sm2',
    ])
  })

  it('returns just the card itself when it has no children', () => {
    expect(subtreeCardKeys(subAgentTimeline, 'm:u')).toEqual(['m:u'])
    expect(subtreeCardKeys(subAgentTimeline, 't:task/m:sm1')).toEqual(['t:task/m:sm1'])
  })

  it('returns nothing for keys that resolve to no item', () => {
    // PLAN_SLOT_KEY never resolves — the pinned plan bar is not a timeline item.
    expect(subtreeCardKeys(subAgentTimeline, 'p:plan')).toEqual([])
    expect(subtreeCardKeys(subAgentTimeline, 't:gone')).toEqual([])
    expect(subtreeCardKeys(subAgentTimeline, 't:task/m:gone')).toEqual([])
  })
})
