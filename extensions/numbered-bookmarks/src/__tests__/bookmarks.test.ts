import { describe, expect, it } from 'vitest'
import { BookmarkStore } from '../bookmarks.js'

const A = '/D:/proj/a.ts'
const B = '/D:/proj/b.ts'

describe('BookmarkStore', () => {
  it('sets a bookmark on toggle and reports its location', () => {
    const store = new BookmarkStore()
    expect(store.toggle(3, A, 10)).toEqual({ path: A, line: 10 })
    expect(store.get(3)).toEqual({ path: A, line: 10 })
  })

  it('clears a bookmark when toggled on the same location', () => {
    const store = new BookmarkStore()
    store.toggle(3, A, 10)
    expect(store.toggle(3, A, 10)).toBeNull()
    expect(store.get(3)).toBeNull()
  })

  it('moves a bookmark when toggled on a different line', () => {
    const store = new BookmarkStore()
    store.toggle(3, A, 10)
    expect(store.toggle(3, A, 20)).toEqual({ path: A, line: 20 })
    expect(store.get(3)).toEqual({ path: A, line: 20 })
  })

  it('moves a globally-unique slot across files', () => {
    const store = new BookmarkStore()
    store.toggle(3, A, 10)
    store.toggle(3, B, 5)
    expect(store.get(3)).toEqual({ path: B, line: 5 })
    expect(store.forPath(A)).toHaveLength(0)
  })

  it('lists bookmarks for one file sorted by line', () => {
    const store = new BookmarkStore()
    store.toggle(1, A, 30)
    store.toggle(2, A, 5)
    store.toggle(0, B, 99)
    store.toggle(4, A, 12)
    expect(store.forPath(A)).toEqual([
      [2, 5],
      [4, 12],
      [1, 30],
    ])
  })

  it('lists all bookmarks in slot order', () => {
    const store = new BookmarkStore()
    store.toggle(5, B, 9)
    store.toggle(0, A, 1)
    expect(store.all()).toEqual([
      [0, { path: A, line: 1 }],
      [5, { path: B, line: 9 }],
    ])
  })

  it('clears all bookmarks', () => {
    const store = new BookmarkStore()
    store.toggle(0, A, 1)
    store.toggle(5, B, 9)
    store.clearAll()
    expect(store.isEmpty()).toBe(true)
    expect(store.all()).toHaveLength(0)
  })

  it('round-trips through serialize/load', () => {
    const store = new BookmarkStore()
    store.toggle(0, A, 1)
    store.toggle(7, B, 42)
    const snapshot = store.serialize()
    const restored = new BookmarkStore()
    restored.load(snapshot)
    expect(restored.all()).toEqual(store.all())
  })

  it('tolerates malformed persisted data', () => {
    const store = new BookmarkStore()
    store.load({ not: 'an array' })
    expect(store.isEmpty()).toBe(true)
    store.load([null, { path: A }, { line: 3 }, { path: B, line: 2 }])
    expect(store.get(3)).toEqual({ path: B, line: 2 })
    expect(store.get(1)).toBeNull()
  })
})
