/*---------------------------------------------------------------------------------------------
 *  Tests for wireDiffEditorViewState's shared-cursor handoff.
 *
 *  The fake diff editor mirrors the real Monaco behaviours the bug depends on:
 *  setPosition / restoreViewState fire the cursor and scroll listeners
 *  synchronously. Re-opening an existing diff tab restores its saved view state
 *  inside onDidUpdateDiff, which flushes the diff's own (stale) cursor into the
 *  shared-cursor cache — clobbering the fresher position the file editor wrote —
 *  before applySharedCursor reads it. The suite pins the fix: the shared cursor
 *  is snapshotted at wiring time, like the view state already was.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { EditorViewStateCache } from '../../../services/editor/EditorViewStateCache.js'
import { wireDiffEditorViewState } from '../diffEditorViewState.js'
import type { monaco } from '../monaco/MonacoLoader.js'

type Listener = () => void

interface FakePosition {
  lineNumber: number
  column: number
}

interface FakeViewState {
  pos: FakePosition
  scrollTop: number
}

function makeFakeSideEditor() {
  const cursorListeners = new Set<Listener>()
  const scrollListeners = new Set<Listener>()
  let position: FakePosition = { lineNumber: 1, column: 1 }
  const revealed: number[] = []
  return {
    revealed,
    onDidChangeCursorPosition(listener: Listener) {
      cursorListeners.add(listener)
      return { dispose: () => cursorListeners.delete(listener) }
    },
    onDidScrollChange(listener: Listener) {
      scrollListeners.add(listener)
      return { dispose: () => scrollListeners.delete(listener) }
    },
    getPosition: (): FakePosition => ({ ...position }),
    setPosition(pos: FakePosition) {
      position = { ...pos }
      for (const l of [...cursorListeners]) l()
    },
    revealLineInCenter(line: number) {
      revealed.push(line)
    },
    fireScroll() {
      for (const l of [...scrollListeners]) l()
    },
  }
}

function makeFakeDiffEditor() {
  const original = makeFakeSideEditor()
  const modified = makeFakeSideEditor()
  const updateDiffListeners = new Set<Listener>()
  let scrollTop = 0
  return {
    original,
    modified,
    revealFirstDiffCalls: 0,
    getOriginalEditor: () => original,
    getModifiedEditor: () => modified,
    saveViewState(): FakeViewState {
      return { pos: modified.getPosition(), scrollTop }
    },
    restoreViewState(state: FakeViewState) {
      scrollTop = state.scrollTop
      modified.setPosition(state.pos)
      modified.fireScroll()
    },
    onDidUpdateDiff(listener: Listener) {
      updateDiffListeners.add(listener)
      return { dispose: () => updateDiffListeners.delete(listener) }
    },
    revealFirstDiff() {
      this.revealFirstDiffCalls++
    },
    fireUpdateDiff() {
      for (const l of [...updateDiffListeners]) l()
    },
  }
}

type FakeDiffEditor = ReturnType<typeof makeFakeDiffEditor>

function wire(ed: FakeDiffEditor, groupId: number, resourceKey: string, sharedCursorUri: string) {
  return wireDiffEditorViewState(ed as unknown as monaco.editor.IStandaloneDiffEditor, {
    groupId,
    resourceKey,
    sharedCursorUri,
  })
}

const groupId = 1
const fileUri = 'file:///ws/a.txt'
const resourceKey = 'diff:file:///ws/a.txt'

afterEach(() => {
  EditorViewStateCache._resetForTests()
})

describe('wireDiffEditorViewState shared cursor', () => {
  it('re-open applies the file editor cursor although restoring the view state flushes first', () => {
    // The diff tab was last closed with its cursor at the bottom …
    EditorViewStateCache.save(groupId, resourceKey, {
      pos: { lineNumber: 100, column: 1 },
      scrollTop: 800,
    })
    // … and the file editor has since moved the shared cursor to the top.
    EditorViewStateCache.saveCursor(groupId, fileUri, { lineNumber: 1, column: 1 })

    const ed = makeFakeDiffEditor()
    wire(ed, groupId, resourceKey, fileUri)
    ed.fireUpdateDiff()

    expect(ed.modified.getPosition()).toEqual({ lineNumber: 1, column: 1 })
    expect(ed.modified.revealed).toEqual([1])
  })

  it('keeps the restored view-state cursor when the shared cursor is not newer', () => {
    EditorViewStateCache.save(groupId, resourceKey, {
      pos: { lineNumber: 100, column: 1 },
      scrollTop: 800,
    })
    EditorViewStateCache.saveCursor(groupId, fileUri, { lineNumber: 100, column: 1 })

    const ed = makeFakeDiffEditor()
    wire(ed, groupId, resourceKey, fileUri)
    ed.fireUpdateDiff()

    expect(ed.modified.getPosition()).toEqual({ lineNumber: 100, column: 1 })
    expect(ed.modified.revealed).toEqual([])
    expect(ed.revealFirstDiffCalls).toBe(0)
  })

  it('fresh open lands on the file editor cursor and skips the first-diff reveal', () => {
    EditorViewStateCache.saveCursor(groupId, fileUri, { lineNumber: 42, column: 7 })

    const ed = makeFakeDiffEditor()
    wire(ed, groupId, resourceKey, fileUri)
    ed.fireUpdateDiff()

    expect(ed.modified.getPosition()).toEqual({ lineNumber: 42, column: 7 })
    expect(ed.revealFirstDiffCalls).toBe(0)
  })

  it('layout scroll noise before the first diff does not clobber the shared cursor', () => {
    EditorViewStateCache.saveCursor(groupId, fileUri, { lineNumber: 5, column: 2 })

    const ed = makeFakeDiffEditor()
    wire(ed, groupId, resourceKey, fileUri)
    // automaticLayout settles while the diff is still computing: the flush
    // listeners run with the cursor still at the top of the fresh model.
    ed.modified.fireScroll()
    ed.fireUpdateDiff()

    expect(ed.modified.getPosition()).toEqual({ lineNumber: 5, column: 2 })
  })

  it('dispose flushes the diff cursor into the shared slot for the way back', () => {
    EditorViewStateCache.saveCursor(groupId, fileUri, { lineNumber: 3, column: 1 })

    const ed = makeFakeDiffEditor()
    const wiring = wire(ed, groupId, resourceKey, fileUri)
    ed.fireUpdateDiff()
    ed.modified.setPosition({ lineNumber: 77, column: 4 })
    wiring.dispose()

    expect(EditorViewStateCache.loadCursor(groupId, fileUri)).toEqual({
      lineNumber: 77,
      column: 4,
    })
  })
})
