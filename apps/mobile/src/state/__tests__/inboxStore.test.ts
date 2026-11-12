import { describe, expect, it } from 'vitest'
import { InboxStore } from '../inboxStore.js'
import { sessionRef, sessionSummary } from '../../test/protocolFixtures.js'

describe('InboxStore', () => {
  it('applies a snapshot and exposes its sessions', () => {
    const store = new InboxStore()
    const result = store.applySnapshot({
      type: 'inbox_snapshot',
      seq: 5,
      sessions: [sessionSummary('a'), sessionSummary('b', { bucket: 'completed' })],
    })

    expect(result).toEqual({ status: 'applied' })
    expect(store.getState().hasSnapshot).toBe(true)
    expect(store.getState().seq).toBe(5)
    expect(store.getState().sessions.map((session) => session.ref.localId)).toEqual(['a', 'b'])
  })

  it('upserts and removes sessions with an inbox delta', () => {
    const store = new InboxStore()
    store.applySnapshot({
      type: 'inbox_snapshot',
      seq: 1,
      sessions: [sessionSummary('a'), sessionSummary('b')],
    })

    const result = store.applyDelta({
      type: 'inbox_delta',
      seq: 2,
      upserts: [sessionSummary('a', { title: 'Renamed', updatedAt: 2_000 }), sessionSummary('c')],
      removes: [sessionRef('b')],
    })

    expect(result).toEqual({ status: 'applied' })
    const sessions = store.getState().sessions
    expect(sessions.map((session) => session.ref.localId).sort()).toEqual(['a', 'c'])
    expect(sessions.find((session) => session.ref.localId === 'a')?.title).toBe('Renamed')
    expect(store.getState().seq).toBe(2)
  })

  it('removes by durable id when the local identity differs', () => {
    const store = new InboxStore()
    store.applySnapshot({
      type: 'inbox_snapshot',
      seq: 1,
      sessions: [sessionSummary('a', { ref: sessionRef('a', 1, 'durable-a') })],
    })

    store.applyDelta({
      type: 'inbox_delta',
      seq: 2,
      upserts: [],
      removes: [{ windowId: 99, localId: 'stale', durableId: 'durable-a' }],
    })

    expect(store.getState().sessions).toEqual([])
  })

  it('removes a row by durable id for the history page', () => {
    const store = new InboxStore()
    store.applySnapshot({
      type: 'inbox_snapshot',
      seq: 1,
      sessions: [
        sessionSummary('a', { ref: sessionRef('a', 1, 'durable-a') }),
        sessionSummary('b', { ref: sessionRef('b', 1, 'durable-b') }),
      ],
    })

    store.removeByDurableId('durable-a')
    expect(store.getState().sessions.map((session) => session.ref.localId)).toEqual(['b'])

    const state = store.getState()
    store.removeByDurableId('missing')
    expect(store.getState()).toBe(state)
  })

  it('asks for a resubscribe when a delta arrives before the snapshot', () => {
    const store = new InboxStore()
    const result = store.applyDelta({
      type: 'inbox_delta',
      seq: 1,
      upserts: [sessionSummary('a')],
      removes: [],
    })
    expect(result).toEqual({ status: 'resubscribe', reason: 'missing_snapshot' })
    expect(store.getState().sessions).toEqual([])
  })

  it('asks for a resubscribe on a sequence gap', () => {
    const store = new InboxStore()
    store.applySnapshot({ type: 'inbox_snapshot', seq: 1, sessions: [] })
    expect(store.applyDelta({ type: 'inbox_delta', seq: 3, upserts: [], removes: [] })).toEqual({
      status: 'resubscribe',
      reason: 'seq_gap',
    })
    expect(store.getState().seq).toBe(1)
  })

  it('asks for a resubscribe on a sequence regression', () => {
    const store = new InboxStore()
    store.applySnapshot({ type: 'inbox_snapshot', seq: 4, sessions: [] })
    expect(store.applyDelta({ type: 'inbox_delta', seq: 3, upserts: [], removes: [] })).toEqual({
      status: 'resubscribe',
      reason: 'seq_regression',
    })
  })

  it('reset clears the snapshot and the sequence', () => {
    const store = new InboxStore()
    store.applySnapshot({ type: 'inbox_snapshot', seq: 2, sessions: [sessionSummary('a')] })
    store.reset()
    expect(store.getState()).toEqual({ sessions: [], seq: undefined, hasSnapshot: false })
  })
})
