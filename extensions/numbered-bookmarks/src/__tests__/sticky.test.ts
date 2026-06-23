import { describe, expect, it } from 'vitest'
import { applyLineEdit, diffLines } from '../sticky.js'
import { BookmarkStore } from '../bookmarks.js'

const A = '/D:/proj/a.ts'
const B = '/D:/proj/b.ts'

describe('diffLines', () => {
  it('returns undefined for identical text', () => {
    expect(diffLines('a\nb', 'a\nb')).toBeUndefined()
  })

  it('detects a single line inserted in the middle', () => {
    const edit = diffLines('a\nb\nc', 'a\nX\nb\nc')
    expect(edit).toEqual({ start: 1, delta: 1, oldEnd: 0 })
  })

  it('detects a line removed', () => {
    const edit = diffLines('a\nb\nc', 'a\nc')
    expect(edit).toEqual({ start: 1, delta: -1, oldEnd: 1 })
  })

  it('detects multiple lines inserted at the top', () => {
    const edit = diffLines('a\nb', 'X\nY\na\nb')
    expect(edit?.delta).toBe(2)
    expect(edit?.start).toBe(0)
  })
})

describe('applyLineEdit', () => {
  it('shifts a bookmark below an insertion down', () => {
    const store = new BookmarkStore()
    store.toggle(1, A, 5)
    const changed = applyLineEdit(store, A, { start: 2, delta: 1, oldEnd: 1 })
    expect(changed).toBe(true)
    expect(store.get(1)?.line).toBe(6)
  })

  it('leaves a bookmark above an insertion untouched', () => {
    const store = new BookmarkStore()
    store.toggle(1, A, 0)
    const changed = applyLineEdit(store, A, { start: 3, delta: 1, oldEnd: 2 })
    expect(changed).toBe(false)
    expect(store.get(1)?.line).toBe(0)
  })

  it('shifts a bookmark below a deletion up', () => {
    const store = new BookmarkStore()
    store.toggle(2, A, 10)
    applyLineEdit(store, A, { start: 1, delta: -2, oldEnd: 2 })
    expect(store.get(2)?.line).toBe(8)
  })

  it('collapses a bookmark sitting on a removed line to the edit start', () => {
    const store = new BookmarkStore()
    store.toggle(0, A, 5)
    applyLineEdit(store, A, { start: 3, delta: -3, oldEnd: 6 })
    expect(store.get(0)?.line).toBe(3)
  })

  it('ignores bookmarks in other files', () => {
    const store = new BookmarkStore()
    store.toggle(0, B, 10)
    const changed = applyLineEdit(store, A, { start: 0, delta: 5, oldEnd: 0 })
    expect(changed).toBe(false)
    expect(store.get(0)?.line).toBe(10)
  })

  it('does nothing when delta is zero', () => {
    const store = new BookmarkStore()
    store.toggle(0, A, 4)
    expect(applyLineEdit(store, A, { start: 1, delta: 0, oldEnd: 1 })).toBe(false)
    expect(store.get(0)?.line).toBe(4)
  })
})
