/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Owns a per-group scoped ContextKeyService mirroring that group's active
 *  editor (language id, editor id, editor type, diff flag), so `MenuId.EditorTitle` actions
 *  resolve independently for each editor group — a split showing a markdown
 *  file and one showing a non-markdown file get the right buttons each.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
import {
  combinedDisposable,
  IContextKeyService,
  markAsSingleton,
  type IEditorGroup,
  type IScopedContextKeyService,
} from '@universe-editor/platform'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { useService } from '../useService.js'

export function useEditorGroupScopedContextKey(group: IEditorGroup): IContextKeyService {
  const rootCtx = useService(IContextKeyService)
  const scopedRef = useRef<IScopedContextKeyService | null>(null)

  if (scopedRef.current === null) {
    // beforeunload (reload / Restart Editor) fires before React teardown —
    // mark singleton so the leak tracker doesn't flag the scoped service.
    scopedRef.current = markAsSingleton(rootCtx.createScoped())
  }

  useEffect(() => {
    return () => {
      scopedRef.current?.dispose()
      scopedRef.current = null
    }
  }, [])

  useEffect(() => {
    const s = scopedRef.current
    if (!s) return
    const sync = () => {
      const active = group.activeEditor
      s.set('activeEditorLanguageId', active instanceof FileEditorInput ? active.language : '')
      s.set('hasActiveEditor', active !== undefined)
      s.set('isInDiffEditor', active instanceof DiffEditorInput)
      if (active) {
        s.set('activeEditorId', active.id)
        s.set('activeEditorType', active.typeId)
      } else {
        s.remove('activeEditorId')
        s.remove('activeEditorType')
      }
    }
    sync()
    const d = markAsSingleton(
      combinedDisposable(group.onDidActiveEditorChange(sync), group.onDidChangeModel(sync)),
    )
    return () => d.dispose()
  }, [group])

  return scopedRef.current
}
