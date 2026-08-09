/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useOpenDiffEditor — the ChangesTree activation → diff-editor bridge shared
 *  by the changed-files views. Preview activation (Space / single click) opens
 *  into the preview slot without stealing keyboard focus from the tree;
 *  open activation (Enter / double click) pins the tab. The owning view
 *  supplies the EditorInput factory so no provider-specific type leaks in here.
 *--------------------------------------------------------------------------------------------*/

import { useCallback } from 'react'
import { IEditorService, type EditorInput } from '@universe-editor/platform'
import { useService } from '../useService.js'

export function useOpenDiffEditor<TEntry>(
  createInput: (entry: TEntry) => EditorInput,
): (entry: TEntry, preview: boolean) => void {
  const editorService = useService(IEditorService)
  return useCallback(
    (entry: TEntry, preview: boolean) => {
      void editorService.openEditor(
        createInput(entry),
        preview ? { pinned: false, preserveFocus: true } : { pinned: true },
      )
    },
    [editorService, createInput],
  )
}
