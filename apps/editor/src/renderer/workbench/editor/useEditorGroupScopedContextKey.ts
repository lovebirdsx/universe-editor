/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Owns a per-group scoped ContextKeyService mirroring that group's active
 *  editor (language id, editor id, editor type, diff flag), so `MenuId.EditorTitle` actions
 *  resolve independently for each editor group — a split showing a markdown
 *  file and one showing a non-markdown file get the right buttons each.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useReducer, useRef } from 'react'
import {
  autorun,
  combinedDisposable,
  IContextKeyService,
  IUriIdentityService,
  JSONContributionRegistry,
  markAsSingleton,
  type IEditorGroup,
  type IScopedContextKeyService,
} from '@universe-editor/platform'
import { IDirtyDiffNavigationService } from '../../services/scm/DirtyDiffNavigationService.js'
import { IScmDecorationsService } from '../../services/scm/ScmDecorationsService.js'
import { IScmService } from '../../services/extensions/ScmService.js'
import { useRemoteAuthority } from '../useRemoteAuthority.js'
import { useOptionalService, useService } from '../useService.js'
import { editorScopedContextValues } from './editorScopedContext.js'

export function useEditorGroupScopedContextKey(group: IEditorGroup): IContextKeyService {
  const rootCtx = useService(IContextKeyService)
  const uriIdentity = useService(IUriIdentityService)
  const dirtyDiff = useOptionalService(IDirtyDiffNavigationService)
  const scmDecorations = useOptionalService(IScmDecorationsService)
  const scmService = useOptionalService(IScmService)
  const remoteAuthority = useRemoteAuthority()
  const scopedRef = useRef<IScopedContextKeyService | null>(null)
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0)

  const readValues = () =>
    editorScopedContextValues(group, group.activeEditor, {
      uriIdentity,
      dirtyDiff,
      scmDecorations,
      scmService,
      remoteAuthority,
    })

  if (scopedRef.current === null) {
    // Seed synchronously: menu components evaluate their `when` clauses during
    // the same render that creates the scoped service, before any effect runs.
    // Creating it bare and filling it in an effect would let a freshly opened
    // group menu read the root (workbench-active group) context for one frame.
    scopedRef.current = markAsSingleton(rootCtx.createScoped(readValues()))
  }

  useEffect(() => {
    // StrictMode's dev dry-run runs this effect's cleanup (disposing + nulling
    // the scoped service) before the real mount. Recreate it here so the live
    // mount always has a working instance, and re-render so consumers (which read
    // the returned service during render) pick up the live one rather than the
    // disposed throwaway. Without this, `activeEditorType` is never set on a live
    // service and `MenuId.EditorTitle` actions silently vanish in dev.
    if (scopedRef.current === null) {
      scopedRef.current = markAsSingleton(rootCtx.createScoped(readValues()))
      forceUpdate()
    }
    const s = scopedRef.current
    const sync = () => {
      const values = readValues()
      for (const [key, value] of Object.entries(values)) s.set(key, value)
    }
    sync()
    const d = markAsSingleton(
      combinedDisposable(
        group.onDidActiveEditorChange(sync),
        group.onDidChangeModel(sync),
        dirtyDiff?.onDidChangeState(sync) ?? { dispose: () => {} },
        scmDecorations
          ? autorun((reader) => {
              scmDecorations.decorations.read(reader)
              sync()
            })
          : { dispose: () => {} },
        // SCM providers register asynchronously after the extension host connects;
        // re-evaluate resourceScmProvider so provider-gated title actions appear
        // once the owning provider (git / perforce) shows up.
        scmService
          ? autorun((reader) => {
              scmService.sourceControls.read(reader)
              sync()
            })
          : { dispose: () => {} },
        // Remote schemas (e.g. claude-helper's http schema) register asynchronously
        // after the file opens — re-evaluate so the icon appears once they land.
        JSONContributionRegistry.onDidChangeContributions(sync),
      ),
    )
    return () => {
      d.dispose()
      scopedRef.current?.dispose()
      scopedRef.current = null
    }
  }, [dirtyDiff, group, remoteAuthority, rootCtx, scmDecorations, scmService, uriIdentity])

  return scopedRef.current
}
