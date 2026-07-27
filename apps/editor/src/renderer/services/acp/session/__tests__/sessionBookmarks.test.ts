import { describe, expect, it } from 'vitest'
import { SessionBookmarkStore } from '../sessionBookmarks.js'

const S1 = 'session-1'
const S2 = 'session-2'
const K1 = 'm:aaa'
const K2 = 't:bbb'

describe('SessionBookmarkStore', () => {
  it('sets a bookmark on toggle and reports its location', () => {
    const store = new SessionBookmarkStore()
    expect(store.toggle(S1, 3, K1)).toBe(K1)
    expect(store.get(S1, 3)).toBe(K1)
  })

  it('clears a bookmark when toggled on the same location', () => {
    const store = new SessionBookmarkStore()
    store.toggle(S1, 3, K1)
    expect(store.toggle(S1, 3, K1)).toBeNull()
    expect(store.get(S1, 3)).toBeNull()
  })

  it('moves a bookmark when toggled on a different slot key', () => {
    const store = new SessionBookmarkStore()
    store.toggle(S1, 3, K1)
    expect(store.toggle(S1, 3, K2)).toBe(K2)
    expect(store.get(S1, 3)).toBe(K2)
  })

  it('keeps the same slot number independent across sessions', () => {
    const store = new SessionBookmarkStore()
    store.toggle(S1, 3, K1)
    store.toggle(S2, 3, K2)
    // Setting slot 3 in S2 must NOT disturb slot 3 in S1.
    expect(store.get(S1, 3)).toBe(K1)
    expect(store.get(S2, 3)).toBe(K2)
    expect(store.forSession(S1)).toEqual([[3, K1]])
    expect(store.forSession(S2)).toEqual([[3, K2]])
  })

  it('lists bookmarks for one session in slot order', () => {
    const store = new SessionBookmarkStore()
    store.toggle(S1, 4, 'm:d')
    store.toggle(S1, 1, 'm:a')
    store.toggle(S2, 0, 'm:z')
    store.toggle(S1, 2, 'm:b')
    expect(store.forSession(S1)).toEqual([
      [1, 'm:a'],
      [2, 'm:b'],
      [4, 'm:d'],
    ])
    expect(store.forSession(S2)).toEqual([[0, 'm:z']])
  })

  it('clears one slot without touching the rest', () => {
    const store = new SessionBookmarkStore()
    store.toggle(S1, 0, K1)
    store.toggle(S1, 3, K2)
    store.clearSlot(S1, 0)
    expect(store.get(S1, 0)).toBeNull()
    expect(store.get(S1, 3)).toBe(K2)
  })

  it('clears every slot for one session', () => {
    const store = new SessionBookmarkStore()
    store.toggle(S1, 0, K1)
    store.toggle(S1, 7, 'm:c')
    store.toggle(S2, 3, K2)
    expect(store.clearSession(S1)).toBe(true)
    expect(store.forSession(S1)).toHaveLength(0)
    expect(store.isEmptyForSession(S1)).toBe(true)
    // A different session is untouched.
    expect(store.get(S2, 3)).toBe(K2)
    // No-op clear reports no change.
    expect(store.clearSession('nope')).toBe(false)
  })

  it('prunes an emptied session so it is no longer serialized', () => {
    const store = new SessionBookmarkStore()
    store.toggle(S1, 0, K1)
    store.toggle(S1, 0, K1) // toggle off
    expect(store.isEmptyForSession(S1)).toBe(true)
    expect(store.serialize()).toHaveLength(0)
  })

  it('round-trips through serialize/load', () => {
    const store = new SessionBookmarkStore()
    store.toggle(S1, 0, K1)
    store.toggle(S1, 7, K2)
    store.toggle(S2, 3, 'm:z')
    const snapshot = store.serialize()
    const restored = new SessionBookmarkStore()
    restored.load(snapshot)
    expect(restored.forSession(S1)).toEqual(store.forSession(S1))
    expect(restored.forSession(S2)).toEqual(store.forSession(S2))
  })

  it('tolerates malformed persisted data', () => {
    const store = new SessionBookmarkStore()
    store.load({ not: 'an array' })
    expect(store.serialize()).toHaveLength(0)
    store.load([
      null,
      { sessionId: S1 }, // missing slots
      { slots: [K1] }, // missing sessionId
      { sessionId: S2, slots: [null, null, null, K2, 42] }, // 42 ignored
    ])
    expect(store.get(S2, 3)).toBe(K2)
    expect(store.forSession(S1)).toHaveLength(0)
  })

  it('normalizes session ids (local → durable) before persistence', () => {
    const store = new SessionBookmarkStore()
    store.toggle('local-A', 0, K1)
    store.toggle('durable-B', 3, K2)
    const durable: Record<string, string> = { 'local-A': 'durable-A' }
    const changed = store.normalize((id) => durable[id] ?? id)
    expect(changed).toBe(true)
    expect(store.get('durable-A', 0)).toBe(K1)
    expect(store.get('local-A', 0)).toBeNull()
    // Already-durable session is left untouched.
    expect(store.get('durable-B', 3)).toBe(K2)
    // A second pass is a no-op once every id resolves to itself.
    expect(store.normalize((id) => durable[id] ?? id)).toBe(false)
  })

  it('merges slots when two ids collapse onto the same durable id', () => {
    const store = new SessionBookmarkStore()
    store.toggle('local-A', 0, K1)
    store.toggle('durable-A', 3, K2)
    // The local id resolves to an id that already has bookmarks.
    store.normalize((id) => (id === 'local-A' ? 'durable-A' : id))
    expect(store.get('durable-A', 0)).toBe(K1)
    expect(store.get('durable-A', 3)).toBe(K2)
    expect(store.get('local-A', 0)).toBeNull()
  })
})
