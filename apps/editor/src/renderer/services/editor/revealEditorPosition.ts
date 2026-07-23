/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared primitives for revealing a position inside a file editor. Opening a
 *  FileEditorInput does not synchronously mount its Monaco instance, so every
 *  caller that wants to place the cursor waits for FileEditorRegistry to report
 *  the mounted editor, then sets the selection and scrolls it into view. This
 *  module is the single home for that timing dance (previously copy-pasted
 *  across the extension-API command, the Monaco open handler, and the markdown
 *  link opener). Like VSCode's textFileEditor.setInput → applyTextEditorOptions,
 *  the reveal is a continuation of editor readiness — event-driven, never a
 *  fixed-delay poll, so it survives large files whose model takes seconds to
 *  build (a 340K-line index.d.ts used to outlive the old rAF+50ms window and
 *  silently lose the jump).
 *--------------------------------------------------------------------------------------------*/

import {
  DisposableStore,
  IEditorGroup,
  IEditorGroupsService,
  IUriIdentityService,
  ITextEditorSelection,
  URI,
  toDisposable,
} from '@universe-editor/platform'
import { type monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { FileEditorInput } from './FileEditorInput.js'
import { FileEditorRegistry } from './FileEditorRegistry.js'

/** Find a FileEditorInput for {@link uri} already open in any group. */
export function findExistingFileEditor(
  groups: IEditorGroupsService,
  uriIdentity: IUriIdentityService,
  uri: URI,
): { group: IEditorGroup; editor: FileEditorInput } | undefined {
  for (const group of groups.groups) {
    for (const editor of group.editors) {
      if (editor instanceof FileEditorInput && uriIdentity.isEqual(editor.resource, uri)) {
        return { group, editor }
      }
    }
  }
  return undefined
}

/**
 * Safety net only: the registry event or the input's disposal normally settles
 * the wait; the timeout bounds a mount that never happens (e.g. an editor opened
 * into a group that is never made visible).
 */
const EDITOR_MOUNT_TIMEOUT_MS = 30_000

/**
 * Resolve the Monaco editor for {@link input} once it mounts. Event-driven on
 * FileEditorRegistry.onDidChange — model creation for a huge file may take
 * seconds, so a fixed-delay poll is not an option. Settles `undefined` when the
 * input is disposed (tab closed before mounting), the safety timeout expires, or
 * {@link disposables} is disposed.
 *
 * Pass the owner's {@link disposables} whenever there is one: an editor opened
 * into a group that never becomes visible otherwise keeps the wait (and its
 * listener subscriptions) alive for the full safety window, which the disposable
 * leak gate flags at teardown.
 */
export async function waitForFileEditor(
  input: FileEditorInput,
  disposables?: DisposableStore,
): Promise<monaco.editor.IStandaloneCodeEditor | undefined> {
  const existing = FileEditorRegistry.get(input)
  if (existing) return existing
  if (input.isDisposed) return undefined
  return new Promise((resolve) => {
    const store = new DisposableStore()
    let settled = false
    const settle = (editor: monaco.editor.IStandaloneCodeEditor | undefined): void => {
      if (settled) return
      settled = true
      disposables?.deleteAndLeak(store)
      store.dispose()
      resolve(editor)
    }
    // Parent the wait under the owner: if the owner is disposed first, the
    // sentinel settles the promise and releases the subscriptions.
    disposables?.add(store)
    store.add(toDisposable(() => settle(undefined)))
    const timer = setTimeout(() => settle(undefined), EDITOR_MOUNT_TIMEOUT_MS)
    store.add(toDisposable(() => clearTimeout(timer)))
    store.add(
      FileEditorRegistry.onDidChange((changed) => {
        if (changed !== input) return
        const editor = FileEditorRegistry.get(input)
        if (editor) settle(editor)
      }),
    )
    store.add(input.onWillDispose(() => settle(undefined)))
  })
}

/**
 * Widen a 1-based {@link ITextEditorSelection} into a full Monaco range. A
 * single-position selection (a `#L5,1`-style fragment) carries no end fields;
 * `setSelection` rejects that shape, so fill the end from the start.
 */
export function toRevealRange(selection: ITextEditorSelection): monaco.IRange {
  return {
    startLineNumber: selection.startLineNumber,
    startColumn: selection.startColumn,
    endLineNumber: selection.endLineNumber ?? selection.startLineNumber,
    endColumn: selection.endColumn ?? selection.startColumn,
  }
}

/** Place the cursor at {@link selection}, scroll it into view, and focus. */
export function applyEditorSelection(
  editor: monaco.editor.IStandaloneCodeEditor,
  selection: ITextEditorSelection,
): void {
  const range = toRevealRange(selection)
  editor.setSelection(range)
  editor.revealRangeInCenterIfOutsideViewport(range)
  editor.focus()
}

/** Wait for {@link input}'s editor to mount, then reveal {@link selection}. */
export async function revealSelectionInInput(
  input: FileEditorInput,
  selection: ITextEditorSelection,
  disposables?: DisposableStore,
): Promise<void> {
  const editor = await waitForFileEditor(input, disposables)
  if (editor) applyEditorSelection(editor, selection)
}
