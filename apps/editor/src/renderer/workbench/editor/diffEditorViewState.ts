/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  wireDiffEditorViewState — shared cursor/scroll persistence for Monaco diff
 *  editors, backed by EditorViewStateCache. Used by both the generic DiffEditor
 *  (git diff, Explorer compare) and the SwarmDiffEditor so that switching a diff
 *  tab away and back restores the exact scroll position — one mechanism, not two.
 *
 *  Save/restore is keyed by `${groupId}:${resourceKey}`. Pass `sharedCursorUri`
 *  to additionally mirror the modified-side cursor under a plain file URI, so a
 *  switch between a diff and the plain file editor for the same file carries the
 *  cursor over. Swarm diffs omit it: their sides are depot snapshots that drift
 *  from the local working copy, so a shared cursor would land on the wrong line.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from '@universe-editor/platform'
import type { monaco } from './monaco/MonacoLoader.js'
import { EditorViewStateCache } from '../../services/editor/EditorViewStateCache.js'

export interface DiffViewStateOptions {
  /** The editor group id; when undefined, persistence is disabled (no-op). */
  readonly groupId: number | undefined
  /** Stable identity for this diff (usually `input.resource.toString()`). */
  readonly resourceKey: string
  /** Optional file URI to share the modified-side cursor across editor types. */
  readonly sharedCursorUri?: string
}

/**
 * Wire save/restore of the diff editor's view state. Returns a disposable that
 * flushes the current state and detaches all listeners; dispose it *before* the
 * Monaco instance so the final flush can still read a live editor.
 */
export function wireDiffEditorViewState(
  ed: monaco.editor.IStandaloneDiffEditor,
  options: DiffViewStateOptions,
): IDisposable {
  const { groupId, resourceKey, sharedCursorUri } = options

  const flushViewState = (): void => {
    if (groupId === undefined) return
    const state = ed.saveViewState()
    if (state) EditorViewStateCache.save(groupId, resourceKey, state)
    // Share the modified-side cursor under the real file URI so a switch to the
    // plain file editor for the same file lands on it. The original side is old
    // content, so it never drives the shared cursor.
    if (sharedCursorUri !== undefined) {
      const pos = ed.getModifiedEditor().getPosition()
      if (pos) {
        EditorViewStateCache.saveCursor(groupId, sharedCursorUri, {
          lineNumber: pos.lineNumber,
          column: pos.column,
        })
      }
    }
  }

  // Apply a cursor written by another editor (the plain file editor) for the
  // same file to the modified side. Returns whether it moved the cursor.
  const applySharedCursor = (): boolean => {
    if (groupId === undefined || sharedCursorUri === undefined) return false
    const sharedCursor = EditorViewStateCache.loadCursor(groupId, sharedCursorUri)
    if (!sharedCursor) return false
    const modified = ed.getModifiedEditor()
    const cur = modified.getPosition()
    if (cur && cur.lineNumber === sharedCursor.lineNumber && cur.column === sharedCursor.column) {
      return false
    }
    modified.setPosition(sharedCursor)
    modified.revealLineInCenter(sharedCursor.lineNumber)
    return true
  }

  // Snapshot the persisted view state up front. The cursor/scroll listeners
  // registered below fire synchronously while Monaco initialises the fresh
  // models, overwriting the cache with a top-of-file state before the diff is
  // even computed — so re-loading from the cache inside onDidUpdateDiff would
  // read that bogus state and skip the first-change reveal. Capture the
  // original saved state and re-apply that exact value instead.
  const savedViewState =
    groupId !== undefined
      ? (EditorViewStateCache.load(groupId, resourceKey) as
          | monaco.editor.IDiffEditorViewState
          | undefined)
      : undefined

  if (savedViewState) ed.restoreViewState(savedViewState)

  // Diff layout is computed asynchronously; re-apply the saved scroll position
  // once the first diff lands, or reveal the first change for a freshly-opened
  // diff without a saved state. revealFirstDiff() waits for the diff
  // computation (and the ensuing layout) internally — goToDiff does not — so
  // the view reliably lands on the first change.
  let updateDiffSub: IDisposable | undefined = ed.onDidUpdateDiff(() => {
    updateDiffSub?.dispose()
    updateDiffSub = undefined
    if (savedViewState) ed.restoreViewState(savedViewState)
    // A more recent cursor from the plain file editor wins over the diff's own
    // (stale) viewState and over the default first-change reveal.
    const applied = applySharedCursor()
    if (!savedViewState && !applied) ed.revealFirstDiff()
  })

  const original = ed.getOriginalEditor()
  const modified = ed.getModifiedEditor()
  const subs = [
    original.onDidChangeCursorPosition(flushViewState),
    modified.onDidChangeCursorPosition(flushViewState),
    original.onDidScrollChange(flushViewState),
    modified.onDidScrollChange(flushViewState),
  ]

  return {
    dispose(): void {
      flushViewState()
      updateDiffSub?.dispose()
      updateDiffSub = undefined
      for (const s of subs) s.dispose()
    },
  }
}
