import type { MobileSessionEvent } from '@universe-editor/mobile-protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  agentMessage,
  sessionDeltaFrame,
  sessionRef,
  sessionSnapshotFrame,
  sessionSummary,
  toolCall,
  userMessage,
} from '../../test/protocolFixtures.js'
import { SessionStore } from '../sessionStore.js'

function loadedStore(): SessionStore {
  const store = new SessionStore()
  store.applySnapshot(sessionSnapshotFrame(1, { timeline: [userMessage('m1', 'hello')] }))
  return store
}

describe('SessionStore snapshot', () => {
  it('copies every snapshot field', () => {
    const store = new SessionStore()
    const summary = sessionSummary('s1', { bucket: 'completed' })
    store.applySnapshot(
      sessionSnapshotFrame(7, {
        summary,
        timeline: [userMessage('m1', 'hi')],
        plan: [{ content: 'step', status: 'in_progress' }],
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'Sonnet',
            allowedOnMobile: true,
          },
        ],
        usage: { used: 10, size: 100 },
        availableCommands: [{ name: 'compact', description: 'Compact the conversation' }],
        pendingPermission: {
          requestId: 'req-1',
          toolCallId: 't1',
          title: 'Run',
          options: [{ optionId: 'allow', name: 'Allow', allowedOnMobile: true }],
        },
        isReplayingHistory: true,
        truncated: true,
      }),
    )

    const state = store.getState()
    expect(state.ref).toEqual(summary.ref)
    expect(state.summary).toEqual(summary)
    expect(state.timeline).toEqual([userMessage('m1', 'hi')])
    expect(state.plan).toEqual([{ content: 'step', status: 'in_progress' }])
    expect(state.configOptions).toHaveLength(1)
    expect(state.usage).toEqual({ used: 10, size: 100 })
    expect(state.availableCommands).toEqual([
      { name: 'compact', description: 'Compact the conversation' },
    ])
    expect(state.pendingPermission?.title).toBe('Run')
    expect(state.isReplayingHistory).toBe(true)
    expect(state.truncated).toBe(true)
    expect(state.seq).toBe(7)
    expect(state.removed).toBe(false)
  })
})

describe('SessionStore message events', () => {
  it('appends a streaming suffix', () => {
    const store = loadedStore()
    const result = store.applyDelta(
      sessionDeltaFrame(2, [
        {
          type: 'message_upsert',
          id: 'm1',
          role: 'user',
          textAppend: ' world',
          streaming: true,
        },
      ]),
    )

    expect(result).toEqual({ status: 'applied' })
    expect(store.getState().timeline[0]).toMatchObject({ text: 'hello world', streaming: true })
  })

  it('replaces the whole text when textReplace is present', () => {
    const store = loadedStore()
    store.applyDelta(
      sessionDeltaFrame(2, [
        {
          type: 'message_upsert',
          id: 'm1',
          role: 'user',
          textReplace: 'rewound',
          streaming: false,
        },
      ]),
    )
    expect(store.getState().timeline[0]).toMatchObject({ text: 'rewound', streaming: false })
  })

  it('creates the message when an upsert arrives before timeline_item_added', () => {
    const store = loadedStore()
    store.applyDelta(
      sessionDeltaFrame(2, [
        {
          type: 'message_upsert',
          id: 'm2',
          role: 'agent',
          textAppend: 'fresh',
          streaming: true,
        },
      ]),
    )
    expect(store.getState().timeline[1]).toEqual(agentMessage('m2', 'fresh', true))
  })

  it('adds full items via timeline_item_added and removes them by id', () => {
    const store = loadedStore()
    store.applyDelta(
      sessionDeltaFrame(2, [
        { type: 'timeline_item_added', item: agentMessage('a1', 'answer') },
        { type: 'timeline_item_added', item: toolCall('t1') },
      ]),
    )
    expect(store.getState().timeline.map((item) => item.id)).toEqual(['m1', 'a1', 't1'])

    store.applyDelta(sessionDeltaFrame(3, [{ type: 'timeline_item_removed', id: 'a1' }]))
    expect(store.getState().timeline.map((item) => item.id)).toEqual(['m1', 't1'])
  })

  it('replaces a tool call in place on tool_call_upsert', () => {
    const store = loadedStore()
    store.applyDelta(
      sessionDeltaFrame(2, [
        { type: 'timeline_item_added', item: toolCall('t1', { status: 'pending' }) },
      ]),
    )
    store.applyDelta(
      sessionDeltaFrame(3, [
        { type: 'tool_call_upsert', item: toolCall('t1', { status: 'completed', title: 'Done' }) },
      ]),
    )
    const item = store.getState().timeline[1]
    expect(item).toMatchObject({ id: 't1', status: 'completed', title: 'Done' })
  })

  it('keeps attachments across text-only upserts and clears them explicitly', () => {
    const attachment = {
      id: 'att-1',
      kind: 'image' as const,
      name: 'shot.png',
      mimeType: 'image/png',
      size: 3,
    }
    const store = new SessionStore()
    store.applySnapshot(
      sessionSnapshotFrame(1, {
        timeline: [{ ...userMessage('m1', ''), attachments: [attachment] }],
      }),
    )

    store.applyDelta(
      sessionDeltaFrame(2, [
        { type: 'message_upsert', id: 'm1', role: 'user', textAppend: 'caption', streaming: false },
      ]),
    )
    expect(store.getState().timeline[0]).toMatchObject({
      text: 'caption',
      attachments: [attachment],
    })

    store.applyDelta(
      sessionDeltaFrame(3, [
        {
          type: 'message_upsert',
          id: 'm1',
          role: 'user',
          streaming: false,
          attachments: [],
        },
      ]),
    )
    expect(store.getState().timeline[0]).not.toHaveProperty('attachments')
  })

  it('creates a message directly from an upsert carrying attachments', () => {
    const store = loadedStore()
    const attachment = {
      id: 'att-2',
      kind: 'file' as const,
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 5,
    }
    store.applyDelta(
      sessionDeltaFrame(2, [
        {
          type: 'message_upsert',
          id: 'm2',
          role: 'user',
          streaming: false,
          attachments: [attachment],
        },
      ]),
    )
    expect(store.getState().timeline[1]).toMatchObject({
      id: 'm2',
      attachments: [attachment],
    })
  })
})

describe('SessionStore message anchors', () => {
  it('applies messageId and canFork from an upsert', () => {
    const store = loadedStore()
    store.applyDelta(
      sessionDeltaFrame(2, [
        {
          type: 'message_upsert',
          id: 'm1',
          role: 'user',
          textAppend: ' world',
          streaming: false,
          messageId: 'msg-1',
          canFork: true,
        },
      ]),
    )
    expect(store.getState().timeline[0]).toMatchObject({
      messageId: 'msg-1',
      canFork: true,
      text: 'hello world',
    })
  })

  it('keeps the anchor when a later append omits it', () => {
    const store = new SessionStore()
    store.applySnapshot(
      sessionSnapshotFrame(1, {
        timeline: [{ ...userMessage('m1', 'hello'), messageId: 'msg-1', canFork: true }],
      }),
    )
    store.applyDelta(
      sessionDeltaFrame(2, [
        { type: 'message_upsert', id: 'm1', role: 'user', textAppend: '!', streaming: false },
      ]),
    )
    expect(store.getState().timeline[0]).toMatchObject({
      text: 'hello!',
      messageId: 'msg-1',
      canFork: true,
    })
  })

  it('lets an explicit canFork:false override the previous value', () => {
    const store = new SessionStore()
    store.applySnapshot(
      sessionSnapshotFrame(1, {
        timeline: [{ ...userMessage('m1', 'hello'), messageId: 'msg-1', canFork: true }],
      }),
    )
    store.applyDelta(
      sessionDeltaFrame(2, [
        {
          type: 'message_upsert',
          id: 'm1',
          role: 'user',
          textAppend: '',
          streaming: false,
          canFork: false,
        },
      ]),
    )
    expect(store.getState().timeline[0]).toMatchObject({ canFork: false })
  })
})

describe('SessionStore other events', () => {
  it('applies plan, config, summary, permission and elicitation events', () => {
    const store = loadedStore()
    const summary = sessionSummary('s1', { title: 'Renamed', bucket: 'completed' })
    const events: MobileSessionEvent[] = [
      { type: 'plan_snapshot', plan: [{ content: 'do it', status: 'completed' }] },
      {
        type: 'config_options_snapshot',
        options: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'Opus',
            allowedOnMobile: true,
          },
        ],
      },
      { type: 'summary_changed', summary },
      {
        type: 'available_commands_snapshot',
        commands: [{ name: 'diff', description: 'Review', inputHint: 'path' }],
      },
      {
        type: 'permission_upsert',
        permission: {
          requestId: 'req-1',
          toolCallId: 't1',
          title: 'Run',
          options: [{ optionId: 'allow', name: 'Allow', allowedOnMobile: true }],
        },
      },
      {
        type: 'elicitation_upsert',
        elicitation: {
          requestId: 'elicit-1',
          mode: 'text',
          message: 'Which one?',
          title: 'Choose',
        },
      },
    ]

    expect(store.applyDelta(sessionDeltaFrame(2, events))).toEqual({ status: 'applied' })
    const state = store.getState()
    expect(state.plan).toEqual([{ content: 'do it', status: 'completed' }])
    expect(state.configOptions[0]?.currentValue).toBe('Opus')
    expect(state.summary?.title).toBe('Renamed')
    expect(state.ref).toEqual(summary.ref)
    expect(state.availableCommands).toEqual([
      { name: 'diff', description: 'Review', inputHint: 'path' },
    ])
    expect(state.pendingPermission?.title).toBe('Run')
    expect(state.pendingElicitation?.message).toBe('Which one?')

    store.applyDelta(
      sessionDeltaFrame(3, [
        { type: 'permission_cleared', requestId: 'req-1', reason: 'selected', source: 'pc' },
        { type: 'elicitation_cleared' },
      ]),
    )
    expect(store.getState().pendingPermission).toBeUndefined()
    expect(store.getState().pendingElicitation).toBeUndefined()
  })

  it('warns and ignores an unknown event without dropping the rest', () => {
    const store = loadedStore()
    const logger = { warn: vi.fn() }
    const unknown = { type: 'future_event', value: 1 } as unknown as MobileSessionEvent
    const result = store.applyDelta(
      sessionDeltaFrame(2, [
        unknown,
        { type: 'timeline_item_added', item: agentMessage('a1', 'ok') },
      ]),
      logger,
    )

    expect(result).toEqual({ status: 'applied' })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(store.getState().timeline.map((item) => item.id)).toEqual(['m1', 'a1'])
  })
})

describe('SessionStore sequencing and removal', () => {
  it('asks for a resubscribe on a gap and on a regression', () => {
    const store = loadedStore()
    expect(store.applyDelta(sessionDeltaFrame(3, []))).toEqual({
      status: 'resubscribe',
      reason: 'seq_gap',
    })
    expect(store.applyDelta(sessionDeltaFrame(0, []))).toEqual({
      status: 'resubscribe',
      reason: 'seq_regression',
    })
    expect(store.getState().seq).toBe(1)
  })

  it('asks for a resubscribe before any snapshot', () => {
    const store = new SessionStore()
    expect(store.applyDelta(sessionDeltaFrame(1, []))).toEqual({
      status: 'resubscribe',
      reason: 'missing_snapshot',
    })
  })

  it('ignores deltas for a different session ref', () => {
    const store = loadedStore()
    const result = store.applyDelta(sessionDeltaFrame(2, [], sessionRef('other', 2)))
    expect(result).toEqual({ status: 'ignored' })
  })

  it('marks the session removed and ignores later deltas', () => {
    const store = loadedStore()
    expect(store.applyRemoved(sessionRef('s1'))).toBe(true)
    expect(store.getState().removed).toBe(true)
    expect(store.applyDelta(sessionDeltaFrame(2, []))).toEqual({ status: 'ignored' })
  })

  it('does not mark a different session as removed', () => {
    const store = loadedStore()
    expect(store.applyRemoved(sessionRef('other'))).toBe(false)
    expect(store.getState().removed).toBe(false)
  })
})
