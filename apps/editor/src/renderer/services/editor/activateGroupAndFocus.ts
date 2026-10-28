/*---------------------------------------------------------------------------------------------
 *  Shared "reveal this group" helper: make the group active, move OS focus to
 *  the window that owns it, then put DOM focus in its active editor.
 *
 *  Callers must pass every service captured synchronously — `ServicesAccessor`
 *  is invalid after the first await.
 *--------------------------------------------------------------------------------------------*/

import {
  PartId,
  type EditorInput,
  type IContextKeyService,
  type IEditorGroup,
  type IEditorGroupsService,
  type IFocusStackService,
} from '@universe-editor/platform'
import { focusEditorInput } from './editorFocus.js'
import type { IWindowFocusService } from '../windows/windowFocusService.js'

export interface ActivateGroupFocusContext {
  readonly groups: IEditorGroupsService
  readonly contextKeyService: IContextKeyService
  readonly windowFocus: IWindowFocusService
  readonly focusStack?: IFocusStackService | undefined
}

export function activateGroupAndFocus(
  group: IEditorGroup,
  ctx: ActivateGroupFocusContext,
  editor?: EditorInput,
): void {
  ctx.groups.activateGroup(group)
  if (editor && group.activeEditor !== editor) group.setActive(editor)
  ctx.focusStack?.push({ partId: PartId.EditorArea, groupId: group.id })
  // Fire-and-forget: window focus is asynchronous, DOM focus is not.
  ctx.windowFocus.focusGroup(group)
  // focusGroup → setActiveWindow → AuxiliaryEditorWindowService.activatePart(
  // preserveFocus: true) writes the window-activation intent synchronously. This
  // helper is an explicit reveal, so that intent must not veto the late-mounted
  // editor's focus (same invariant as EditorGroupView's cross-window branch).
  group.preserveFocusOnActivation?.(false)
  const active = group.activeEditor
  if (!active) return
  focusEditorInput(active, ctx.contextKeyService, group.id)
}
