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
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { matchSchemasForUri } from '../../services/preferences/schemaMatch.js'
import { IDirtyDiffNavigationService } from '../../services/scm/DirtyDiffNavigationService.js'
import { IScmDecorationsService } from '../../services/scm/ScmDecorationsService.js'
import {
  IScmService,
  encodeScmProviderIds,
  resolveScmProviderIds,
} from '../../services/extensions/ScmService.js'
import { useOptionalService, useService } from '../useService.js'

export function useEditorGroupScopedContextKey(group: IEditorGroup): IContextKeyService {
  const rootCtx = useService(IContextKeyService)
  const uriIdentity = useService(IUriIdentityService)
  const dirtyDiff = useOptionalService(IDirtyDiffNavigationService)
  const scmDecorations = useOptionalService(IScmDecorationsService)
  const scmService = useOptionalService(IScmService)
  const scopedRef = useRef<IScopedContextKeyService | null>(null)
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0)

  if (scopedRef.current === null) {
    // beforeunload (reload / Restart Editor) fires before React teardown —
    // mark singleton so the leak tracker doesn't flag the scoped service.
    scopedRef.current = markAsSingleton(rootCtx.createScoped())
  }

  useEffect(() => {
    // StrictMode's dev dry-run runs this effect's cleanup (disposing + nulling
    // the scoped service) before the real mount. Recreate it here so the live
    // mount always has a working instance, and re-render so consumers (which read
    // the returned service during render) pick up the live one rather than the
    // disposed throwaway. Without this, `activeEditorType` is never set on a live
    // service and `MenuId.EditorTitle` actions silently vanish in dev.
    if (scopedRef.current === null) {
      scopedRef.current = markAsSingleton(rootCtx.createScoped())
      forceUpdate()
    }
    const s = scopedRef.current
    const sync = () => {
      const active = group.activeEditor
      const resource =
        active instanceof FileEditorInput || active instanceof DiffEditorInput
          ? active.resource
          : undefined
      const dirtyDiffResource = dirtyDiff?.resource
      const hasDirtyDiffChanges =
        active instanceof FileEditorInput &&
        dirtyDiff !== undefined &&
        dirtyDiffResource !== undefined &&
        uriIdentity.isEqual(dirtyDiffResource, active.resource) &&
        dirtyDiff.regions.length > 0
      const hasScmChanges =
        active instanceof FileEditorInput && scmDecorations?.getFile(active.resource) !== undefined
      const scmProvider =
        active instanceof FileEditorInput && scmService
          ? encodeScmProviderIds(
              resolveScmProviderIds(scmService.sourceControls.get(), active.resource.fsPath),
            )
          : ''
      s.set('activeEditorLanguageId', active instanceof FileEditorInput ? active.language : '')
      s.set('hasActiveEditor', active !== undefined)
      s.set('isInDiffEditor', active instanceof DiffEditorInput)
      s.set(
        'diffEditorHasOpenableFile',
        active instanceof DiffEditorInput && active.openableResource !== undefined,
      )
      s.set('activeEditorGroupLocked', group.isLocked)
      s.set('resourceScheme', resource?.scheme ?? '')
      s.set('resourceScmProvider', scmProvider)
      s.set('scmActiveResourceHasChanges', hasDirtyDiffChanges || hasScmChanges)
      s.set(
        'activeEditorHasJsonSchema',
        active instanceof FileEditorInput &&
          active.language === 'json' &&
          matchSchemasForUri(active.resource).length > 0,
      )
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
  }, [dirtyDiff, group, rootCtx, scmDecorations, scmService, uriIdentity])

  return scopedRef.current
}
