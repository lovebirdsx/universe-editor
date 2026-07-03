/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared primitives for revealing a position inside a file editor. Opening a
 *  FileEditorInput does not synchronously mount its Monaco instance, so every
 *  caller that wants to place the cursor has to poll FileEditorRegistry until the
 *  editor appears, then set the selection and scroll it into view. This module is
 *  the single home for that timing dance (previously copy-pasted across the
 *  extension-API command, the Monaco open handler, and the markdown link opener).
 *--------------------------------------------------------------------------------------------*/

import {
  IEditorGroup,
  IEditorGroupsService,
  IUriIdentityService,
  ITextEditorSelection,
  URI,
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
 * Monaco may not have mounted the editor for {@link input} yet; poll the registry
 * a few times (an animation frame, then short timeouts) before giving up.
 */
export async function waitForFileEditor(
  input: FileEditorInput,
): Promise<monaco.editor.IStandaloneCodeEditor | undefined> {
  let editor = FileEditorRegistry.get(input)
  if (editor) return editor
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  editor = FileEditorRegistry.get(input)
  if (editor) return editor
  for (const delay of [50, 100, 200]) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay))
    editor = FileEditorRegistry.get(input)
    if (editor) return editor
  }
  return undefined
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
): Promise<void> {
  const editor = await waitForFileEditor(input)
  if (editor) applyEditorSelection(editor, selection)
}
