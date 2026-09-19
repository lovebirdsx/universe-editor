/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for chatContextSlot — the write side of "which card is the timeline
 *  context menu on": the DOM key lookup both menu hosts share, and the card
 *  descriptor the menu `when` clauses read.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type {
  AcpChildItem,
  AcpMessage,
  AcpToolCall,
  TimelineItem,
} from '../../../services/acp/session/acpSession.js'
import { describeAcpChatSlot, slotKeyFromEvent } from '../chatContextSlot.js'

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
  return { kind: 'toolCall', id: call.id, call }
}

function messageItem(message: AcpMessage): TimelineItem {
  return { kind: 'message', id: message.id, message }
}

function userMessage(overrides: Partial<AcpMessage> = {}): AcpMessage {
  return { id: 'm1', role: 'user', text: 'hi', blocks: [], streaming: false, ...overrides }
}

describe('slotKeyFromEvent', () => {
  it('reads the key off the nearest tagged ancestor', () => {
    const root = document.createElement('div')
    root.innerHTML = `<div data-timeline-key="t:task" data-sticky-key="t:task">
      <span><em id="deep">clicked</em></span>
    </div>`
    const deep = root.querySelector('#deep')
    expect(slotKeyFromEvent(deep)).toBe('t:task')
  })

  // A sub-agent child is rendered inside the parent card's node, so it carries
  // only the composite sticky key — the closest match must be the child's.
  it('prefers the innermost card when cards nest', () => {
    const root = document.createElement('div')
    root.innerHTML = `<div data-timeline-key="t:task" data-sticky-key="t:task">
      <div data-sticky-key="t:task/m:sm1"><span id="deep">clicked</span></div>
    </div>`
    expect(slotKeyFromEvent(root.querySelector('#deep'))).toBe('t:task/m:sm1')
  })

  it('falls back to data-timeline-key when there is no sticky key', () => {
    const root = document.createElement('div')
    root.innerHTML = `<div data-timeline-key="m:u"><span id="deep">clicked</span></div>`
    expect(slotKeyFromEvent(root.querySelector('#deep'))).toBe('m:u')
  })

  it('returns undefined on an untagged element and on a non-element target', () => {
    const orphan = document.createElement('span')
    document.body.append(orphan)
    expect(slotKeyFromEvent(orphan)).toBeUndefined()
    expect(slotKeyFromEvent(null)).toBeUndefined()
    expect(slotKeyFromEvent(document)).toBeUndefined()
    orphan.remove()
  })
})

describe('describeAcpChatSlot', () => {
  it('returns undefined when the key resolves to no item', () => {
    expect(describeAcpChatSlot(undefined, 't:gone', false)).toBeUndefined()
  })

  it('describes a user message as the rewind / fork anchor', () => {
    const item = messageItem(userMessage({ messageId: 'msg-7' }))
    expect(describeAcpChatSlot(item, 'm:m1', false)).toEqual({
      slotKey: 'm:m1',
      messageId: 'msg-7',
      card: true,
      collapsed: false,
      userMessage: true,
      subAgent: false,
      nested: false,
      createdFile: undefined,
    })
  })

  it('carries the collapse state through for a card', () => {
    const item = messageItem(userMessage())
    expect(describeAcpChatSlot(item, 'm:m1', true)?.collapsed).toBe(true)
  })

  it('treats a user message without a messageId as no anchor', () => {
    // Messages replayed from history predate the field — rewind / fork cannot
    // address them, so the menu must not offer the two commands.
    expect(describeAcpChatSlot(messageItem(userMessage()), 'm:m1', false)?.userMessage).toBe(false)
  })

  it('excludes auto-retry stubs, which are not the user turn', () => {
    const item = messageItem(userMessage({ messageId: 'msg-7', autoRetry: true }))
    const slot = describeAcpChatSlot(item, 'm:m1', false)
    expect(slot?.userMessage).toBe(false)
    expect(slot?.messageId).toBeUndefined()
  })

  it('leaves an agent message without a messageId', () => {
    const item = messageItem({
      id: 'm1',
      role: 'agent',
      text: 'hi',
      blocks: [],
      streaming: false,
    })
    expect(describeAcpChatSlot(item, 'm:m1', false)?.userMessage).toBe(false)
  })

  it('reports a status bar as not a card and never collapsed', () => {
    const item = {
      kind: 'compaction',
      id: 'c1',
      compaction: { phase: 'end' },
    } as unknown as TimelineItem
    const slot = describeAcpChatSlot(item, 'c:c1', true)
    expect(slot?.card).toBe(false)
    expect(slot?.collapsed).toBe(false)
  })

  it('marks a tool call carrying a sub-agent timeline', () => {
    const child: AcpChildItem = {
      kind: 'message',
      id: 'sm1',
      message: { id: 'sm1', role: 'agent', text: 'sub', blocks: [], streaming: false },
    }
    const withChildren = toolCallItem(makeCall({ children: [child] }))
    expect(describeAcpChatSlot(withChildren, 't:t1', false)?.subAgent).toBe(true)
    expect(describeAcpChatSlot(toolCallItem(makeCall({})), 't:t1', false)?.subAgent).toBe(false)
    expect(
      describeAcpChatSlot(toolCallItem(makeCall({ children: [] })), 't:t1', false)?.subAgent,
    ).toBe(false)
  })

  it('flags a composite key as nested', () => {
    const item = toolCallItem(makeCall({}))
    expect(describeAcpChatSlot(item, 't:task/t:t1', false)?.nested).toBe(true)
    expect(describeAcpChatSlot(item, 't:t1', false)?.nested).toBe(false)
  })

  it('splits whole-file writes into preview vs open by extension', () => {
    const write = (path: string): TimelineItem =>
      toolCallItem(makeCall({ kind: 'edit', diffs: [{ path, oldText: '', newText: '# hi\n' }] }))
    expect(describeAcpChatSlot(write('/repo/notes.md'), 't:t1', false)?.createdFile).toBe('preview')
    expect(describeAcpChatSlot(write('/repo/index.html'), 't:t1', false)?.createdFile).toBe(
      'preview',
    )
    expect(describeAcpChatSlot(write('/repo/a.ts'), 't:t1', false)?.createdFile).toBe('open')
  })

  it('offers no file affordance for an edit that is not a whole-file write', () => {
    const edit = toolCallItem(
      makeCall({ kind: 'edit', diffs: [{ path: '/repo/a.ts', oldText: 'a', newText: 'b' }] }),
    )
    expect(describeAcpChatSlot(edit, 't:t1', false)?.createdFile).toBeUndefined()

    const multi = toolCallItem(
      makeCall({
        kind: 'edit',
        diffs: [
          { path: '/repo/a.ts', oldText: '', newText: 'a' },
          { path: '/repo/b.ts', oldText: '', newText: 'b' },
        ],
      }),
    )
    expect(describeAcpChatSlot(multi, 't:t1', false)?.createdFile).toBeUndefined()
  })
})
