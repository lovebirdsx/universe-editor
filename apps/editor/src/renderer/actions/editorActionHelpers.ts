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
 * `{ groupId, resource }` to disambiguate when the same URI is open in
 * multiple split groups; absent arguments fall back to the active editor.
 */
export interface ITabActionArg {
  readonly groupId?: number
  readonly resource?: UriComponents
}

function isTabActionArg(value: unknown): value is ITabActionArg {
  return typeof value === 'object' && value !== null
}

/**
 * Resolve which `(group, editor)` an editor command should operate on:
 * 1. If the command argument carries `{ groupId, resource }`, look up that
 *    group and find the editor whose resource matches.
 * 2. If only `resource` is given, scan all groups for the first match.
 * 3. Otherwise, fall back to `activeGroup.activeEditor`.
 */
export function resolveTargetEditor(
  accessor: ServicesAccessor,
  arg: unknown,
): ITabTarget | undefined {
  const groups = accessor.get(IEditorGroupsService)

  if (isTabActionArg(arg) && arg.resource) {
    const uri = URI.revive(arg.resource)
    if (uri) {
      const targetKey = uri.toString()
      const candidateGroups =
        arg.groupId !== undefined
          ? [groups.getGroup(arg.groupId)].filter((g): g is IEditorGroup => g !== undefined)
          : groups.groups
      for (const g of candidateGroups) {
        const found = g.editors.find((e) => e.resource?.toString() === targetKey)
        if (found) return { group: g, editor: found }
      }
    }
  }

  const active = groups.activeGroup
  const editor = active.activeEditor
  return editor ? { group: active, editor } : undefined
}
