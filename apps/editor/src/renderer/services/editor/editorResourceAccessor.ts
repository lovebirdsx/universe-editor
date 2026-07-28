/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  getOriginalResource — VSCode `EditorResourceAccessor.getOriginalUri(editor,
 *  { supportSideBySide: PRIMARY })` counterpart: the single place that maps an
 *  active EditorInput to the on-disk file it "is about". Views that follow the
 *  active editor (Timeline, …) use it so opening a diff/merge of a file keeps
 *  the follow target on that file instead of dropping to undefined.
 *--------------------------------------------------------------------------------------------*/

import { URI, type IEditorInput } from '@universe-editor/platform'
import { DiffEditorInput } from './DiffEditorInput.js'
import { FileEditorInput } from './FileEditorInput.js'
import { MergeEditorInput } from './MergeEditorInput.js'
import { WebviewDiffInput } from './WebviewDiffInput.js'

/**
 * The file an editor input is about, or undefined when it has no single backing
 * file (virtual editors). A diff resolves to its modified (right-hand) side —
 * for a same-file diff that falls back to the original side's file URI — and a
 * merge editor to the conflicted file, so the Timeline keeps showing the file's
 * history while its diff/merge is active.
 */
export function getOriginalResource(editor: IEditorInput | undefined | null): URI | undefined {
  if (editor instanceof FileEditorInput) return editor.resource
  if (editor instanceof DiffEditorInput) return editor.modifiedUri
  if (editor instanceof WebviewDiffInput) return editor.rightUri
  if (editor instanceof MergeEditorInput) return editor.fileUri
  return undefined
}
