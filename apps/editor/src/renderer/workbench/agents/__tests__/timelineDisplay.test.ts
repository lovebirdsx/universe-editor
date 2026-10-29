/*---------------------------------------------------------------------------------------------
 *  Tests for the display-mode filter: which slots render under hideThinking /
 *  onlyMessage, nested thought removal, tail activity hints, and focus
 *  convergence when the selected slot disappears.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { CollapseMode } from '../../../services/acp/session/acpChatViewStateCache.js'
import type {
  AcpChildItem,
  AcpMessage,
  AcpToolCall,
  TimelineItem,
} from '../../../services/acp/session/acpSession.js'
import { itemSlotKey } from '../stickyScroll.js'
import type { CollapseState } from '../timelineCollapse.js'
import {
  convergeDisplayFocusKey,
  filterChildItemsForDisplay,
  getHiddenActivity,
  selectTimelineForDisplay,
  selectTimelineForOutline,
} from '../timelineDisplay.js'

function message(
  id: string,
  role: AcpMessage['role'],
  text: string,
  overrides: Partial<AcpMessage> = {},
): AcpMessage {
  return {
    id,
    role,
    text,
    blocks: text.length > 0 ? [{ type: 'text', text }] : [],
    streaming: false,
    ...overrides,
  }
}

function messageItem(msg: AcpMessage): TimelineItem {
  return { kind: 'message', id: msg.id, message: msg }
}

function user(id: string, text = id): TimelineItem {
  return messageItem(message(id, 'user', text))
}

function agent(id: string, text = id, overrides: Partial<AcpMessage> = {}): TimelineItem {
  return messageItem(message(id, 'agent', text, overrides))
}

function thought(id: string, text = id, overrides: Partial<AcpMessage> = {}): TimelineItem {
  return messageItem(message(id, 'thought', text, overrides))
}

function call(overrides: Partial<AcpToolCall> = {}): AcpToolCall {
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

function toolItem(callOverrides: Partial<AcpToolCall> = {}): TimelineItem {
  const c = call(callOverrides)
  return { kind: 'toolCall', id: c.id, call: c }
}

function compaction(id = 'c1'): TimelineItem {
  return { kind: 'compaction', id, compaction: { phase: 'success' } }
}

function resurrection(id = 'r1'): TimelineItem {
  return { kind: 'resurrection', id, resurrection: { phase: 'success' } }
}

function childMessage(msg: AcpMessage): AcpChildItem {
  return { kind: 'message', id: msg.id, message: msg }
}

const collapseState = (
  mode: CollapseMode,
  overrides: ReadonlyArray<readonly [string, boolean]> = [],
  openSubagent: string | null = null,
): CollapseState => ({ mode, overrides: new Map(overrides), openSubagent })

const ids = (items: readonly TimelineItem[]): string[] => items.map((item) => item.id)

describe('selectTimelineForDisplay', () => {
  it('returns the original array for the three folding modes', () => {
    const timeline = [user('a'), agent('b')]
    expect(selectTimelineForDisplay(timeline, 'default')).toBe(timeline)
    expect(selectTimelineForDisplay(timeline, 'collapsed')).toBe(timeline)
    expect(selectTimelineForDisplay(timeline, 'expanded')).toBe(timeline)
  })

  it('hideThinking removes top-level thoughts only', () => {
    const timeline = [user('a'), thought('t1'), agent('b'), toolItem({ id: 'x1' })]
    expect(ids(selectTimelineForDisplay(timeline, 'hideThinking'))).toEqual(['a', 'b', 'x1'])
  })

  it('onlyMessage keeps every user and agent message', () => {
    const timeline = [
      user('a'),
      agent('b'),
      agent('c'),
      agent('d'),
      user('e'),
      agent('f'),
      agent('g'),
      agent('h'),
    ]
    expect(ids(selectTimelineForDisplay(timeline, 'onlyMessage'))).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
    ])
  })

  it('onlyMessage hides ordinary tools and thoughts but keeps sub-agent cards', () => {
    const subagent = toolItem({
      id: 'task',
      kind: 'execute',
      subagent: true,
      children: [childMessage(message('sub-agent', 'agent', 'child'))],
    })
    const timeline = [
      user('a'),
      thought('th1'),
      toolItem({ id: 'read', kind: 'read' }),
      agent('b'),
      subagent,
      agent('c'),
    ]
    expect(ids(selectTimelineForDisplay(timeline, 'onlyMessage'))).toEqual(['a', 'b', 'task', 'c'])
  })

  it('onlyMessage keeps key status cards and errors, but not failed ordinary tools', () => {
    const timeline = [
      user('a'),
      toolItem({ id: 'failed', status: 'failed' }),
      compaction('comp'),
      resurrection('res'),
      toolItem({ id: 'plan', kind: 'switch_mode' }),
      messageItem(message('err', 'agent', '[error] boom')),
      agent('b'),
    ]
    expect(ids(selectTimelineForDisplay(timeline, 'onlyMessage'))).toEqual([
      'a',
      'comp',
      'res',
      'plan',
      'err',
      'b',
    ])
  })

  it('onlyMessage keeps cards that asked the user for a decision', () => {
    const timeline = [
      user('a'),
      toolItem({ id: 'ask', kind: 'other', requiresUserDecision: true }),
      agent('b'),
    ]
    expect(ids(selectTimelineForDisplay(timeline, 'onlyMessage'))).toEqual(['a', 'ask', 'b'])
  })

  it('onlyMessage keeps agent messages before the first user message', () => {
    const timeline = [agent('p1'), agent('p2'), user('a'), agent('b')]
    expect(ids(selectTimelineForDisplay(timeline, 'onlyMessage'))).toEqual(['p1', 'p2', 'a', 'b'])
  })

  it('onlyMessage keeps the user message when the turn has no agent reply', () => {
    const timeline = [user('a'), toolItem({ id: 'read', kind: 'read' }), user('e'), agent('f')]
    expect(ids(selectTimelineForDisplay(timeline, 'onlyMessage'))).toEqual(['a', 'e', 'f'])
  })

  it('onlyMessage drops an empty settled reply but keeps a streaming first frame', () => {
    const timeline = [user('a'), agent('real'), agent('empty', '')]
    expect(ids(selectTimelineForDisplay(timeline, 'onlyMessage'))).toEqual(['a', 'real'])
    const streaming = [user('a'), agent('empty', '', { streaming: true })]
    expect(ids(selectTimelineForDisplay(streaming, 'onlyMessage'))).toEqual(['a', 'empty'])
  })

  it('returns an empty timeline unchanged', () => {
    const timeline: readonly TimelineItem[] = []
    expect(selectTimelineForDisplay(timeline, 'onlyMessage')).toBe(timeline)
  })
})

describe('filterChildItemsForDisplay', () => {
  const children: readonly AcpChildItem[] = [
    childMessage(message('th', 'thought', 'thinking')),
    childMessage(message('a', 'agent', 'reply')),
    { kind: 'toolCall', id: 'sub', call: call({ id: 'sub' }) },
  ]

  it('removes thought children under hideThinking', () => {
    expect(filterChildItemsForDisplay(children, 'hideThinking').map((c) => c.id)).toEqual([
      'a',
      'sub',
    ])
  })

  it('returns the original array for other modes', () => {
    expect(filterChildItemsForDisplay(children, 'onlyMessage')).toBe(children)
    expect(filterChildItemsForDisplay(children, 'default')).toBe(children)
  })
})

describe('selectTimelineForOutline', () => {
  it('removes nested thoughts under hideThinking', () => {
    const task = toolItem({
      id: 'task',
      subagent: true,
      children: [
        childMessage(message('th', 'thought', 'thinking')),
        childMessage(message('a', 'agent', 'reply')),
      ],
    })
    const [outlineTask] = selectTimelineForOutline([task], 'hideThinking')
    expect(outlineTask?.kind).toBe('toolCall')
    if (outlineTask?.kind !== 'toolCall') throw new Error('expected tool call')
    expect(outlineTask.call.children?.map((c) => c.id)).toEqual(['a'])
  })

  it('does not filter inside sub-agent cards under onlyMessage', () => {
    const task = toolItem({
      id: 'task',
      subagent: true,
      children: [
        childMessage(message('th', 'thought', 'thinking')),
        childMessage(message('a', 'agent', 'reply')),
      ],
    })
    const outline = selectTimelineForOutline([user('u'), task], 'onlyMessage')
    expect(ids(outline)).toEqual(['u', 'task'])
    const outlineTask = outline[1]
    if (outlineTask?.kind !== 'toolCall') throw new Error('expected tool call')
    expect(outlineTask.call.children?.map((c) => c.id)).toEqual(['th', 'a'])
  })
})

describe('getHiddenActivity', () => {
  const tail = thought('th')
  const filter = (timeline: readonly TimelineItem[], mode: CollapseMode) =>
    selectTimelineForDisplay(timeline, mode)

  it('returns null when the turn is not active or the mode does not hide', () => {
    const timeline = [user('a'), tail]
    expect(getHiddenActivity(filter(timeline, 'hideThinking'), tail, 'hideThinking', false)).toBe(
      null,
    )
    expect(getHiddenActivity(filter(timeline, 'default'), tail, 'default', true)).toBe(null)
  })

  it('reports thinking when a streaming thought is hidden', () => {
    const streaming = thought('th', '...', { streaming: true })
    const timeline = [user('a'), streaming]
    expect(
      getHiddenActivity(filter(timeline, 'hideThinking'), streaming, 'hideThinking', true),
    ).toBe('thinking')
  })

  it('reports tool while the hidden tail tool is still running, thinking after it settles', () => {
    const running = toolItem({ id: 'read', kind: 'read', status: 'in_progress' })
    const runningTimeline = [user('a'), agent('b'), running]
    expect(
      getHiddenActivity(filter(runningTimeline, 'onlyMessage'), running, 'onlyMessage', true),
    ).toBe('tool')
    const settled = toolItem({ id: 'read', kind: 'read', status: 'completed' })
    const settledTimeline = [user('a'), agent('b'), settled]
    expect(
      getHiddenActivity(filter(settledTimeline, 'onlyMessage'), settled, 'onlyMessage', true),
    ).toBe('thinking')
  })

  it('returns null when the tail itself is visible', () => {
    const visible = agent('b', '...', { streaming: true })
    const timeline = [user('a'), visible]
    expect(getHiddenActivity(filter(timeline, 'onlyMessage'), visible, 'onlyMessage', true)).toBe(
      null,
    )
    const task = toolItem({ id: 'task', subagent: true, status: 'in_progress' })
    const withTask = [user('a'), task]
    expect(getHiddenActivity(filter(withTask, 'onlyMessage'), task, 'onlyMessage', true)).toBe(null)
  })
})

describe('convergeDisplayFocusKey', () => {
  it('moves a hidden top-level focus to the nearest visible item above it', () => {
    const hidden = thought('t')
    const full = [user('a'), hidden, toolItem({ id: 'x', kind: 'read' }), agent('d')]
    const filtered = selectTimelineForDisplay(full, 'onlyMessage')
    const keys = new Set(filtered.map(itemSlotKey))
    expect(
      convergeDisplayFocusKey(
        full,
        filtered,
        keys,
        itemSlotKey(hidden),
        collapseState('onlyMessage'),
      ),
    ).toBe('m:a')
  })

  it('searches forward when the hidden item is first', () => {
    const hidden = toolItem({ id: 'x', kind: 'read' })
    const full = [hidden, user('a'), agent('b')]
    const filtered = selectTimelineForDisplay(full, 'onlyMessage')
    const keys = new Set(filtered.map(itemSlotKey))
    expect(
      convergeDisplayFocusKey(
        full,
        filtered,
        keys,
        itemSlotKey(hidden),
        collapseState('onlyMessage'),
      ),
    ).toBe('m:a')
  })

  it('moves a hidden nested thought to its parent card', () => {
    const task = toolItem({
      id: 'task',
      subagent: true,
      children: [childMessage(message('th', 'thought', 'thinking'))],
    })
    const full = [user('a'), task]
    const filtered = selectTimelineForDisplay(full, 'hideThinking')
    const keys = new Set(filtered.map(itemSlotKey))
    expect(
      convergeDisplayFocusKey(full, filtered, keys, 't:task/m:th', collapseState('hideThinking')),
    ).toBe('t:task')
  })

  it('keeps the existing folded-ancestor convergence and clears stale keys', () => {
    const task = toolItem({ id: 'task', subagent: true })
    const full = [user('a'), task]
    const filtered = selectTimelineForDisplay(full, 'default')
    const keys = new Set(filtered.map(itemSlotKey))
    expect(
      convergeDisplayFocusKey(full, filtered, keys, 't:task/m:missing', collapseState('default')),
    ).toBe('t:task')
    expect(convergeDisplayFocusKey(full, filtered, keys, 'm:gone', collapseState('default'))).toBe(
      null,
    )
  })
})
