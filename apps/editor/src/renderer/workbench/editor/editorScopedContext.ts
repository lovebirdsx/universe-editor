/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Per-editor scoped context-key values shared by the editor title bar and the
 *  tab right-click menu. Every key is computed from the *target* group/editor,
 *  never from the workbench-active group, so a menu raised on a non-active tab
 *  (or a non-active group's title bar) gates its entries against what the user
 *  pointed at.
 *--------------------------------------------------------------------------------------------*/

import {
  type EditorInput,
  type IEditorGroup,
  type IUriIdentityService,
  type URI,
} from '@universe-editor/platform'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import {
  encodeScmProviderIds,
  resolveScmProviderIds,
  type IScmService,
} from '../../services/extensions/ScmService.js'
import { matchSchemasForUri } from '../../services/preferences/schemaMatch.js'
import type { IDirtyDiffNavigationService } from '../../services/scm/DirtyDiffNavigationService.js'
import { scmHostPath } from '../../services/scm/scmHostPath.js'
import type { IScmDecorationsService } from '../../services/scm/ScmDecorationsService.js'

export interface EditorScopedContextDeps {
  readonly uriIdentity?: IUriIdentityService | undefined
  readonly dirtyDiff?: IDirtyDiffNavigationService | undefined
  readonly scmDecorations?: IScmDecorationsService | undefined
  readonly scmService?: IScmService | undefined
  readonly remoteAuthority?: string | undefined
}

export interface EditorScopedContextOptions extends EditorScopedContextDeps {
  /**
   * Resource the menu commands should act on. The tab menu passes
   * `tabContextMenuResource(editor)` so a markdown preview tab maps to its
   * source `.md` file; the title bar uses the editor's own resource.
   */
  readonly resource?: URI | null | undefined
}

/** Default resource for context keys — only file-backed editors expose one. */
export function editorScopedContextResource(editor: EditorInput | undefined): URI | undefined {
  if (editor instanceof FileEditorInput || editor instanceof DiffEditorInput) return editor.resource
  return undefined
}

/**
 * Fixed set of primitive values for a scoped ContextKeyService. Callers seed the
 * same keys every time: a varying key set would make `useScopedContextKey`
 * rebuild its service, and explicit empty values keep a group's context from
 * falling through to the root (which describes a different group/editor).
 *
 * `activeEditorIsDirty` is a snapshot of the target editor; this module has no
 * subscriptions (the long-lived title hook owns those).
 */
export function editorScopedContextValues(
  group: IEditorGroup,
  editor: EditorInput | undefined,
  options: EditorScopedContextOptions = {},
): Record<string, string | number | boolean> {
  const resource =
    options.resource !== undefined
      ? (options.resource ?? undefined)
      : editorScopedContextResource(editor)
  const dirtyDiff = options.dirtyDiff
  const dirtyDiffResource = dirtyDiff?.resource
  const hasDirtyDiffChanges =
    editor instanceof FileEditorInput &&
    dirtyDiff !== undefined &&
    dirtyDiffResource !== undefined &&
    options.uriIdentity !== undefined &&
    options.uriIdentity.isEqual(dirtyDiffResource, editor.resource) &&
    dirtyDiff.regions.length > 0
  const hasScmChanges =
    editor instanceof FileEditorInput &&
    options.scmDecorations?.hasChanges(editor.resource) === true
  const scmPath =
    editor instanceof FileEditorInput
      ? scmHostPath(editor.resource, options.remoteAuthority)
      : undefined
  const scmProvider =
    scmPath !== undefined && options.scmService !== undefined
      ? encodeScmProviderIds(
          resolveScmProviderIds(options.scmService.sourceControls.get(), scmPath),
        )
      : ''

  return {
    activeEditorLanguageId: editor instanceof FileEditorInput ? editor.language : '',
    hasActiveEditor: editor !== undefined,
    isInDiffEditor: editor instanceof DiffEditorInput,
    diffEditorHasOpenableFile:
      editor instanceof DiffEditorInput && editor.openableResource !== undefined,
    activeEditorGroupLocked: group.isLocked,
    activeEditorIsPinned: editor !== undefined && group.isSticky(editor),
    resourceScheme: resource?.scheme ?? '',
    resourceScmProvider: scmProvider,
    scmActiveResourceHasChanges: hasDirtyDiffChanges || hasScmChanges,
    activeEditorHasJsonSchema:
      editor instanceof FileEditorInput &&
      editor.language === 'json' &&
      matchSchemasForUri(editor.resource).length > 0,
    activeEditorId: editor?.id ?? '',
    activeEditorType: editor?.typeId ?? '',
    editorIsOpen: group.count > 0,
    groupEditorsCount: group.count,
    activeEditorGroupIndex: group.index,
    activeEditorGroupEmpty: group.count === 0,
    activeEditorIsFirstInGroup: editor !== undefined && group.isFirst(editor),
    activeEditorIsLastInGroup: editor !== undefined && group.isLast(editor),
    activeEditorIsDirty: editor?.isDirty === true,
  }
}
