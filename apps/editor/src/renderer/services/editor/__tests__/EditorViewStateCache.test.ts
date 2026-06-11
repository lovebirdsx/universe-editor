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
