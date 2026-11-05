import { afterEach, describe, expect, it } from 'vitest'
import { EditorViewStateCache } from '../EditorViewStateCache.js'

describe('EditorViewStateCache shared cursor', () => {
  afterEach(() => EditorViewStateCache._resetForTests())

  it('round-trips a cursor position by group + uri', () => {
    EditorViewStateCache.saveCursor(1, 'file:///a.ts', { lineNumber: 10, column: 3 })
    expect(EditorViewStateCache.loadCursor(1, 'file:///a.ts')).toEqual({
      lineNumber: 10,
      column: 3,
    })
  })

  it('returns undefined for an unknown entry', () => {
    expect(EditorViewStateCache.loadCursor(1, 'file:///missing.ts')).toBeUndefined()
  })

  it('isolates cursors across groups', () => {
    EditorViewStateCache.saveCursor(1, 'file:///a.ts', { lineNumber: 5, column: 1 })
    EditorViewStateCache.saveCursor(2, 'file:///a.ts', { lineNumber: 9, column: 2 })
    expect(EditorViewStateCache.loadCursor(1, 'file:///a.ts')).toEqual({ lineNumber: 5, column: 1 })
    expect(EditorViewStateCache.loadCursor(2, 'file:///a.ts')).toEqual({ lineNumber: 9, column: 2 })
  })

  it('does not collide with the viewState entry for the same group + uri', () => {
    EditorViewStateCache.save(1, 'file:///a.ts', { kind: 'viewState' })
    EditorViewStateCache.saveCursor(1, 'file:///a.ts', { lineNumber: 7, column: 4 })
    expect(EditorViewStateCache.load(1, 'file:///a.ts')).toEqual({ kind: 'viewState' })
    expect(EditorViewStateCache.loadCursor(1, 'file:///a.ts')).toEqual({ lineNumber: 7, column: 4 })
  })

  it('clearGroup removes the shared cursor too', () => {
    EditorViewStateCache.saveCursor(1, 'file:///a.ts', { lineNumber: 1, column: 1 })
    EditorViewStateCache.clearGroup(1)
    expect(EditorViewStateCache.loadCursor(1, 'file:///a.ts')).toBeUndefined()
  })
})

describe('EditorViewStateCache copyGroupEntries', () => {
  afterEach(() => EditorViewStateCache._resetForTests())

  it('copies view state, shared cursor and reveal line into the target group', () => {
    EditorViewStateCache.save(1, 'file:///a.ts', { kind: 'viewState' })
    EditorViewStateCache.saveCursor(1, 'file:///a.ts', { lineNumber: 10, column: 3 })
    EditorViewStateCache.saveRevealLine(1, 'file:///a.ts', 42)

    EditorViewStateCache.copyGroupEntries(1, 2, 'file:///a.ts')

    expect(EditorViewStateCache.load(2, 'file:///a.ts')).toEqual({ kind: 'viewState' })
    expect(EditorViewStateCache.loadCursor(2, 'file:///a.ts')).toEqual({
      lineNumber: 10,
      column: 3,
    })
    expect(EditorViewStateCache.takeRevealLine(2, 'file:///a.ts')).toBe(42)
  })

  it('keeps the source entries intact', () => {
    EditorViewStateCache.save(1, 'file:///a.ts', { kind: 'viewState' })
    EditorViewStateCache.saveCursor(1, 'file:///a.ts', { lineNumber: 4, column: 2 })

    EditorViewStateCache.copyGroupEntries(1, 2, 'file:///a.ts')

    expect(EditorViewStateCache.load(1, 'file:///a.ts')).toEqual({ kind: 'viewState' })
    expect(EditorViewStateCache.loadCursor(1, 'file:///a.ts')).toEqual({
      lineNumber: 4,
      column: 2,
    })
  })

  it('is a no-op for the same group', () => {
    EditorViewStateCache.save(1, 'file:///a.ts', { kind: 'viewState' })
    EditorViewStateCache.copyGroupEntries(1, 1, 'file:///a.ts')
    expect(EditorViewStateCache.load(1, 'file:///a.ts')).toEqual({ kind: 'viewState' })
  })

  it('leaves target state untouched when the source has no entries', () => {
    EditorViewStateCache.save(2, 'file:///a.ts', { kind: 'target' })
    EditorViewStateCache.copyGroupEntries(1, 2, 'file:///a.ts')
    expect(EditorViewStateCache.load(2, 'file:///a.ts')).toEqual({ kind: 'target' })
  })

  it('does not touch other resources or groups', () => {
    EditorViewStateCache.save(1, 'file:///a.ts', { kind: 'a' })
    EditorViewStateCache.save(1, 'file:///b.ts', { kind: 'b' })
    EditorViewStateCache.save(3, 'file:///a.ts', { kind: 'other-group' })

    EditorViewStateCache.copyGroupEntries(1, 2, 'file:///a.ts')

    expect(EditorViewStateCache.load(2, 'file:///b.ts')).toBeUndefined()
    expect(EditorViewStateCache.load(3, 'file:///a.ts')).toEqual({ kind: 'other-group' })
    expect(EditorViewStateCache.load(1, 'file:///b.ts')).toEqual({ kind: 'b' })
  })
})
