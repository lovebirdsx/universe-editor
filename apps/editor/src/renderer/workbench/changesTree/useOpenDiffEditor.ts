/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useOpenDiffEditor — the ChangesTree activation → diff-editor bridge shared
 *  by the changed-files views. Preview activation (Space / single click) opens
 *  into the preview slot without stealing keyboard focus from the tree;
 *  open activation (Enter / double click) pins the tab. Ctrl/Meta/Alt+Enter
 *  additionally selects a side group / auxiliary window. The owning view
 *  supplies the EditorInput factory so no provider-specific type leaks in here.
 *--------------------------------------------------------------------------------------------*/

import { useCallback } from 'react'
import {
  IEditorGroupsService,
  IEditorService,
  IInstantiationService,
  IUriIdentityService,
  type EditorInput,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import type { OpenTarget } from '../../services/editor/openTarget.js'
import {
  openFreshInputWithTarget,
  type OpenTargetServices,
} from '../../services/editor/openWithTarget.js'
import { IAuxiliaryEditorWindowService } from '../../services/windows/auxiliaryEditorWindowService.js'

export function useOpenDiffEditor<TEntry>(
  createInput: (entry: TEntry) => EditorInput,
): (entry: TEntry, preview: boolean, target?: OpenTarget) => void {
  const editorService = useService(IEditorService)
  const groups = useService(IEditorGroupsService)
  const inst = useService(IInstantiationService)
  const uriIdentity = useService(IUriIdentityService)
  const aux = useService(IAuxiliaryEditorWindowService)
  return useCallback(
    (entry: TEntry, preview: boolean, target: OpenTarget = 'default') => {
      const openDefault = (): void => {
        void editorService.openEditor(
          createInput(entry),
          preview ? { pinned: false, preserveFocus: true } : { pinned: true },
        )
      }
      if (target === 'default') {
        openDefault()
        return
      }
      const services: OpenTargetServices = { groups, inst, uriIdentity, aux }
      const input = createInput(entry)
      void (async () => {
        const result = await openFreshInputWithTarget(services, input, target, {
          pinned: !preview,
          preserveFocus: preview,
        })
        if (result.handled) return
        if (!input.isDisposed) input.dispose()
        openDefault()
      })()
    },
    [editorService, groups, inst, uriIdentity, aux, createInput],
  )
}
