/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared helpers for editor Action2 implementations.
 *--------------------------------------------------------------------------------------------*/

import {
  type EditorInput,
  type IEditorGroup,
  IEditorGroupsService,
  type ServicesAccessor,
  type UriComponents,
  URI,
} from '@universe-editor/platform'

export interface ITabTarget {
  readonly group: IEditorGroup
  readonly editor: EditorInput
}

/**
 * Tab Action2 invocation argument. Right-click context menu passes
 * `{ groupId, editorId, resource }`. `editorId` pins the exact tab even when two
 * editors share one URI (e.g. an image preview and the text view of the same
 * file); `resource` remains the fallback for callers that only know the URI
 * (explorer, editor-title overflow). Absent arguments fall back to the active
 * editor.
 */
export interface ITabActionArg {
  readonly groupId?: number
  readonly editorId?: string
  readonly resource?: UriComponents
}

function isTabActionArg(value: unknown): value is ITabActionArg {
  return typeof value === 'object' && value !== null
}

/**
 * Resolve which `(group, editor)` an editor command should operate on:
 * 1. If the argument carries `editorId`, find that exact editor (scoped to
 *    `groupId` when given). Disambiguates two editors sharing one URI.
 * 2. Else if `resource` is given, find the first editor with that URI.
 * 3. Otherwise, fall back to `activeGroup.activeEditor`.
 */
export function resolveTargetEditor(
  accessor: ServicesAccessor,
  arg: unknown,
): ITabTarget | undefined {
  const groups = accessor.get(IEditorGroupsService)

  if (isTabActionArg(arg) && (arg.editorId !== undefined || arg.resource)) {
    const candidateGroups =
      arg.groupId !== undefined
        ? [groups.getGroup(arg.groupId)].filter((g): g is IEditorGroup => g !== undefined)
        : groups.groups

    if (arg.editorId !== undefined) {
      for (const g of candidateGroups) {
        const found = g.editors.find((e) => e.id === arg.editorId)
        if (found) return { group: g, editor: found }
      }
    }

    if (arg.resource) {
      const uri = URI.revive(arg.resource)
      if (uri) {
        const targetKey = uri.toString()
        for (const g of candidateGroups) {
          const found = g.editors.find((e) => e.resource?.toString() === targetKey)
          if (found) return { group: g, editor: found }
        }
      }
    }
  }

  // A group-only argument (e.g. the editor-title `…` overflow) targets that
  // group's active editor rather than the workbench-active group.
  if (isTabActionArg(arg) && arg.groupId !== undefined && !arg.resource) {
    const g = groups.getGroup(arg.groupId)
    if (g?.activeEditor) return { group: g, editor: g.activeEditor }
  }

  const active = groups.activeGroup
  const editor = active.activeEditor
  return editor ? { group: active, editor } : undefined
}
