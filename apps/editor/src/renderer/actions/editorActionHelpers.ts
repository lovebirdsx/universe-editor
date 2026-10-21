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
 * file); the editor-title overflow passes `{ groupId }`; `resource` remains the
 * fallback for callers that only know the URI. Absent arguments fall back to the
 * active editor.
 */
export interface ITabActionArg {
  readonly groupId?: number
  readonly editorId?: string
  readonly resource?: UriComponents | null | undefined
}

function isTabActionArg(value: unknown): value is ITabActionArg {
  return typeof value === 'object' && value !== null
}

/**
 * Whether the invocation carries an explicit editor/tab target. Distinguishes
 * editor menu arguments from unrelated payloads (e.g. the ACP chat menu's
 * `{ sessionId, slotKey }`), which some actions also receive.
 */
export function hasTabActionTarget(arg: unknown): arg is ITabActionArg {
  if (!isTabActionArg(arg)) return false
  return (
    arg.groupId !== undefined ||
    arg.editorId !== undefined ||
    (arg.resource !== undefined && arg.resource !== null)
  )
}

/**
 * Resolve which `(group, editor)` an editor command should operate on:
 * 1. If the argument carries `editorId`, find that exact editor (scoped to
 *    `groupId` when given). Disambiguates two editors sharing one URI.
 * 2. Else if `resource` is given, find the first editor with that URI.
 * 3. Else if only `groupId` is given, use that group's active editor.
 * 4. Otherwise, fall back to `activeGroup.activeEditor`.
 *
 * Explicit targets never fall back to the active editor: a stale menu argument
 * (tab closed, group gone) must become a no-op instead of silently acting on an
 * unrelated editor.
 */
export function resolveTargetEditor(
  accessor: ServicesAccessor,
  arg: unknown,
): ITabTarget | undefined {
  const groups = accessor.get(IEditorGroupsService)
  const explicitResource = isTabActionArg(arg) && arg.resource !== null ? arg.resource : undefined

  if (isTabActionArg(arg) && (arg.editorId !== undefined || explicitResource !== undefined)) {
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

    if (explicitResource !== undefined) {
      const uri = URI.revive(explicitResource)
      if (uri) {
        const targetKey = uri.toString()
        for (const g of candidateGroups) {
          const found = g.editors.find((e) => e.resource?.toString() === targetKey)
          if (found) return { group: g, editor: found }
        }
      }
    }

    return undefined
  }

  // A group-only argument (e.g. the editor-title `…` overflow) targets that
  // group's active editor rather than the workbench-active group.
  if (isTabActionArg(arg) && arg.groupId !== undefined) {
    const g = groups.getGroup(arg.groupId)
    return g?.activeEditor ? { group: g, editor: g.activeEditor } : undefined
  }

  const active = groups.activeGroup
  const editor = active.activeEditor
  return editor ? { group: active, editor } : undefined
}
