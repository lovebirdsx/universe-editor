/*---------------------------------------------------------------------------------------------
 *  FocusRestoreFallbackProvider — supplies the workbench-wide semantic fallback
 *  for overlay focus restore (packages/workbench-ui's focusRestore).
 *
 *  When the captured opener has left the document (an editor remounted while a
 *  dialog was up, a Monaco native-edit-context host replaced), a focus restore
 *  must not leave the caret on <body>. The fallback focuses the active editor
 *  through the canonical entry (`focusEditorInput`, the same one commands use),
 *  with that editor's own group so split views land on the right side.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, type ReactNode } from 'react'
import { IContextKeyService, IEditorGroupsService } from '@universe-editor/platform'
import { FocusRestoreFallbackContext } from '@universe-editor/workbench-ui'
import { focusEditorInput } from '../../services/editor/editorFocus.js'
import { getActiveWorkbenchDocument } from '../../services/windows/workbenchDocuments.js'
import { useService } from '../useService.js'

export function FocusRestoreFallbackProvider({ children }: { children: ReactNode }) {
  const editorGroupsService = useService(IEditorGroupsService)
  const contextKeyService = useService(IContextKeyService)

  const restore = useCallback(
    (doc: Document): boolean => {
      // The active editor lives in the active window; falling back from an
      // overlay in another window would yank activation across windows.
      if (doc !== getActiveWorkbenchDocument()) return false
      const group = editorGroupsService.activeGroup
      const editor = group.activeEditor
      if (!editor) return false
      return focusEditorInput(editor, contextKeyService, group.id)
    },
    [contextKeyService, editorGroupsService],
  )

  return <FocusRestoreFallbackContext value={restore}>{children}</FocusRestoreFallbackContext>
}
