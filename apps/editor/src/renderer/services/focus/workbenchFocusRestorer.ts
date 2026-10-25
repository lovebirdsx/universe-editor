import {
  IContextKeyService,
  IEditorGroupsService,
  ILayoutService,
  PartId,
  ViewContainerLocation,
  type IEditorGroup,
  type IViewsService,
} from '@universe-editor/platform'
import { isHTMLElementLike } from '@universe-editor/workbench-ui'
import { focusEditorInput, syncEditorFocusContext } from '../editor/editorFocus.js'
import { currentWorkbenchDocumentOrUndefined } from '../windows/workbenchDocuments.js'

export const EXPLORER_TREE_VIEW_ID = 'workbench.view.explorer.tree'
const EXPLORER_CONTAINER_ID = 'workbench.view.explorer'

export type RestoredWorkbenchFocusTarget = 'editor' | 'explorer' | 'kept'

export interface IRestoredWorkbenchFocusResult {
  readonly target: RestoredWorkbenchFocusTarget
  readonly ok: boolean
  readonly groupId?: number
  readonly editorId?: string
}

export async function restoreWorkbenchFocus(
  editorGroupsService: IEditorGroupsService,
  layoutService: ILayoutService,
  contextKeyService: IContextKeyService,
  viewsService: IViewsService,
): Promise<IRestoredWorkbenchFocusResult> {
  // Restoring focus must not steal it from an element the user already reached
  // inside the editor area (e.g. Ctrl+F's find input opened right after a
  // workspace switch) — the editor branch's goal is already met.
  const activeElement = currentWorkbenchDocumentOrUndefined()?.activeElement
  if (
    isHTMLElementLike(activeElement) &&
    activeElement.closest('[data-testid="part-editorArea"]') !== null
  ) {
    syncEditorFocusContext(contextKeyService)
    return { target: 'kept', ok: true }
  }

  const group = resolveGroupWithEditor(editorGroupsService)
  const editor = group?.activeEditor

  if (group && editor) {
    if (editorGroupsService.activeGroup !== group) {
      // Restore never pulls another window forward; focus is placed explicitly below.
      group.preserveFocusOnActivation?.(true)
      editorGroupsService.activateGroup(group)
    }
    let ok = focusEditorInput(editor, contextKeyService, group.id)
    if (!ok) ok = await layoutService.focusPart(PartId.EditorArea, { source: 'restore' })
    syncEditorFocusContext(contextKeyService)
    return { target: 'editor', ok, groupId: group.id, editorId: editor.id }
  }

  // Restoring focus must not steal the side bar from a container the user has
  // already switched to (e.g. clicking Search right after opening a folder) —
  // focusView() would flip the active container back to Explorer.
  const active = viewsService.getActiveViewContainerId(ViewContainerLocation.SideBar)
  if (active !== undefined && active !== EXPLORER_CONTAINER_ID) {
    syncEditorFocusContext(contextKeyService)
    return { target: 'kept', ok: true }
  }

  // Nor steal a view outside the sidebar the user already focused — e.g. the
  // Output editor focused via toggleOutput mid-restore-window. Restoring to
  // Explorer would rip keyboard focus out of the panel the user is typing in.
  const activeElement2 = currentWorkbenchDocumentOrUndefined()?.activeElement
  if (
    isHTMLElementLike(activeElement2) &&
    activeElement2.closest('[data-view-id]') !== null &&
    activeElement2.closest('[data-testid="part-sidebar"]') === null
  ) {
    syncEditorFocusContext(contextKeyService)
    return { target: 'kept', ok: true }
  }

  const ok = await layoutService.focusView(EXPLORER_TREE_VIEW_ID, { source: 'restore' })
  syncEditorFocusContext(contextKeyService)
  return { target: 'explorer', ok }
}

function resolveGroupWithEditor(
  editorGroupsService: IEditorGroupsService,
): IEditorGroup | undefined {
  const active = editorGroupsService.activeGroup
  if (active.activeEditor) return active
  return editorGroupsService.groups.find((group) => group.activeEditor)
}
