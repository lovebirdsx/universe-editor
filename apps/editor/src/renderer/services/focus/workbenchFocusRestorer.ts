import {
  IContextKeyService,
  IEditorGroupsService,
  ILayoutService,
  PartId,
  ViewContainerLocation,
  type IEditorGroup,
  type IViewsService,
} from '@universe-editor/platform'
import { focusEditorInput, syncEditorFocusContext } from '../editor/editorFocus.js'

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
  const group = resolveGroupWithEditor(editorGroupsService)
  const editor = group?.activeEditor

  if (group && editor) {
    if (editorGroupsService.activeGroup !== group) editorGroupsService.activateGroup(group)
    let ok = focusEditorInput(editor, contextKeyService, group.id)
    if (!ok) ok = await layoutService.focusPart(PartId.EditorArea, { source: 'restore' })
    syncEditorFocusContext(contextKeyService)
    syncTerminalFocusContext(contextKeyService, layoutService)
    return { target: 'editor', ok, groupId: group.id, editorId: editor.id }
  }

  // Restoring focus must not steal the side bar from a container the user has
  // already switched to (e.g. clicking Search right after opening a folder) —
  // focusView() would flip the active container back to Explorer.
  const active = viewsService.getActiveViewContainerId(ViewContainerLocation.SideBar)
  if (active !== undefined && active !== EXPLORER_CONTAINER_ID) {
    syncEditorFocusContext(contextKeyService)
    syncTerminalFocusContext(contextKeyService, layoutService)
    return { target: 'kept', ok: true }
  }

  const ok = await layoutService.focusView(EXPLORER_TREE_VIEW_ID, { source: 'restore' })
  syncEditorFocusContext(contextKeyService)
  syncTerminalFocusContext(contextKeyService, layoutService)
  return { target: 'explorer', ok }
}

export function syncTerminalFocusContext(
  contextKeyService: IContextKeyService,
  layoutService?: ILayoutService,
): void {
  const active = globalThis.document?.activeElement
  const terminalHost =
    active instanceof HTMLElement ? active.closest<HTMLElement>('[data-terminal-id]') : null
  const panelTerminal =
    terminalHost !== null && active instanceof HTMLElement
      ? active.closest('[data-testid="part-panel"]') !== null
      : false
  const hiddenPanelTerminal =
    panelTerminal && layoutService !== undefined && !layoutService.getVisible(PartId.Panel)
  contextKeyService.set('terminalFocus', terminalHost !== null && !hiddenPanelTerminal)
}

function resolveGroupWithEditor(
  editorGroupsService: IEditorGroupsService,
): IEditorGroup | undefined {
  const active = editorGroupsService.activeGroup
  if (active.activeEditor) return active
  return editorGroupsService.groups.find((group) => group.activeEditor)
}
