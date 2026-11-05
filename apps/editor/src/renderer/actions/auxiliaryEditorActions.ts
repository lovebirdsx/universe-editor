/*---------------------------------------------------------------------------------------------
 *  Auxiliary editor window commands (VSCode command ids).
 *
 *  The async window operations live in IAuxiliaryEditorWindowService; every run
 *  snapshots the services and resolved editor/group synchronously because a
 *  ServicesAccessor dies at the first await.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  IQuickInputService,
  IWorkspaceService,
  MenuId,
  localize,
  localize2,
  type IEditorGroup,
  type IEditorPart,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  IAuxiliaryEditorWindowService,
  type EditorWindowTransferMode,
} from '../services/windows/auxiliaryEditorWindowService.js'
import {
  IWorkbenchWindowService,
  type IWorkbenchWindow,
} from '../services/windows/workbenchWindowService.js'
import { workspaceFullLabel } from '../services/workspace/workspaceLabel.js'
import { resolveTargetEditor } from './editorActionHelpers.js'

interface GroupArg {
  readonly groupId?: number
}

function resolveTargetGroup(accessor: ServicesAccessor, arg: unknown): IEditorGroup | undefined {
  const groups = accessor.get(IEditorGroupsService)
  if (typeof arg === 'object' && arg !== null && 'groupId' in arg) {
    const groupId = (arg as GroupArg).groupId
    // An explicit but stale group id is a no-op — never retarget the active group.
    return typeof groupId === 'number' ? groups.getGroup(groupId) : undefined
  }
  return groups.activeGroup
}

function runMoveEditor(accessor: ServicesAccessor, arg: unknown, copy: boolean): void {
  const target = resolveTargetEditor(accessor, arg)
  if (!target) return
  const service = accessor.get(IAuxiliaryEditorWindowService)
  const { editor, group } = target
  void (copy
    ? service.copyEditorToNewWindow(editor, group)
    : service.moveEditorToNewWindow(editor, group))
}

function runMoveGroup(accessor: ServicesAccessor, arg: unknown, copy: boolean): void {
  const group = resolveTargetGroup(accessor, arg)
  if (!group) return
  const service = accessor.get(IAuxiliaryEditorWindowService)
  void (copy ? service.copyGroupToNewWindow(group) : service.moveGroupToNewWindow(group))
}

function runMoveToMainWindow(accessor: ServicesAccessor, arg: unknown): void {
  const target = resolveTargetEditor(accessor, arg)
  if (!target) return
  accessor.get(IAuxiliaryEditorWindowService).moveEditorToMainWindow(target.editor, target.group)
}

function runMoveGroupToMainWindow(accessor: ServicesAccessor, arg: unknown): void {
  const group = resolveTargetGroup(accessor, arg)
  if (!group) return
  accessor.get(IAuxiliaryEditorWindowService).moveGroupToMainWindow(group)
}

interface WindowPickItem extends IQuickPickItem {
  readonly target: IWorkbenchWindow
}

/**
 * Destination picker for the "into window…" commands. `targets` already excludes
 * the source window; labels are read at invocation time because auxiliary
 * window titles follow their active editor.
 */
async function pickDestinationWindow(
  quickInput: IQuickInputService,
  targets: readonly IWorkbenchWindow[],
  workspace: IWorkspaceService,
  placeholder: string,
): Promise<IWorkbenchWindow | undefined> {
  if (targets.length === 0) return undefined
  const items: WindowPickItem[] = targets.map((target) => {
    if (target.isMain) {
      const folder = workspace.current?.folder
      return {
        id: 'window.main',
        label: localize('quickInput.windowPicker.mainWindow', 'Main Window'),
        ...(folder ? { description: workspaceFullLabel(folder) } : {}),
        target,
      }
    }
    const label = target.document.title || localize('auxiliaryWindow.windowTitle', 'Editor Window')
    const active = target.part.activeGroup.activeEditor
    const description = target.part.isEmpty
      ? localize('quickInput.windowPicker.emptyWindow', 'Empty Window')
      : active?.isDirty === true
        ? localize('quickInput.windowPicker.unsavedChanges', 'Unsaved Changes')
        : undefined
    return {
      id: `window.${target.id}`,
      label,
      ...(description ? { description } : {}),
      target,
    }
  })
  const pick = await quickInput.pick<WindowPickItem>(items, {
    placeholder,
    matchOnDescription: true,
  })
  return pick?.target
}

/** Other workbench windows (the source window is never a destination). */
function otherWindows(
  windows: IWorkbenchWindowService,
  sourcePart: IEditorPart,
): readonly IWorkbenchWindow[] {
  return windows.windows.filter((candidate) => candidate.part !== sourcePart)
}

async function runTransferEditor(
  accessor: ServicesAccessor,
  arg: unknown,
  mode: EditorWindowTransferMode,
): Promise<void> {
  const target = resolveTargetEditor(accessor, arg)
  if (!target) return
  // Snapshot every service before the picker: the accessor dies at the first await.
  const service = accessor.get(IAuxiliaryEditorWindowService)
  const workbenchWindows = accessor.get(IWorkbenchWindowService)
  const quickInput = accessor.get(IQuickInputService)
  const workspace = accessor.get(IWorkspaceService)
  const destinations = otherWindows(workbenchWindows, target.group.part)
  const picked = await pickDestinationWindow(
    quickInput,
    destinations,
    workspace,
    mode === 'copy'
      ? localize(
          'quickInput.copyEditorToWindow.placeholder',
          'Select a window to copy the editor into',
        )
      : localize(
          'quickInput.moveEditorToWindow.placeholder',
          'Select a window to move the editor into',
        ),
  )
  if (!picked) return
  service.openEditorInWindow(target.editor, target.group, picked, { mode })
}

async function runTransferGroup(
  accessor: ServicesAccessor,
  arg: unknown,
  mode: EditorWindowTransferMode,
): Promise<void> {
  const group = resolveTargetGroup(accessor, arg)
  // Nothing to transfer: the service would reject after the picker was shown.
  if (!group || group.count === 0) return
  const service = accessor.get(IAuxiliaryEditorWindowService)
  const workbenchWindows = accessor.get(IWorkbenchWindowService)
  const quickInput = accessor.get(IQuickInputService)
  const workspace = accessor.get(IWorkspaceService)
  const destinations = otherWindows(workbenchWindows, group.part)
  const picked = await pickDestinationWindow(
    quickInput,
    destinations,
    workspace,
    mode === 'copy'
      ? localize(
          'quickInput.copyGroupToWindow.placeholder',
          'Select a window to copy the group into',
        )
      : localize(
          'quickInput.moveGroupToWindow.placeholder',
          'Select a window to move the group into',
        ),
  )
  if (!picked) return
  service.openGroupInWindow(group, picked, { mode })
}

const CATEGORY = localize2('command.category.view', 'View')

export class MoveEditorToNewWindowAction extends Action2 {
  static readonly ID = 'workbench.action.moveEditorToNewWindow'
  constructor() {
    super({
      id: MoveEditorToNewWindowAction.ID,
      icon: 'move',
      title: localize2('action.moveEditorToNewWindow.title', 'Move Editor into New Window'),
      category: CATEGORY,
      precondition: 'hasActiveEditor',
      menu: { id: MenuId.EditorTabContext, group: '2_newWindow', order: 10 },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    runMoveEditor(accessor, arg, false)
  }
}

export class MoveEditorToMainWindowAction extends Action2 {
  static readonly ID = 'workbench.action.moveEditorToMainWindow'
  constructor() {
    super({
      id: MoveEditorToMainWindowAction.ID,
      icon: 'arrow-left',
      title: localize2('action.moveEditorToMainWindow.title', 'Move Editor to Main Window'),
      category: CATEGORY,
      // Scoped `when` (clicked tab's part) keeps the entry out of main-window
      // tabs; the palette row reads the root key maintained by
      // ContextKeyContribution. `precondition` is evaluated at root and would
      // gate the tab menu against the wrong window.
      menu: [
        {
          id: MenuId.EditorTabContext,
          group: '2_newWindow',
          order: 30,
          when: 'isAuxiliaryEditorWindow && hasActiveEditor',
        },
        {
          id: MenuId.CommandPalette,
          when: 'isAuxiliaryEditorWindow && hasActiveEditor',
        },
      ],
      f1: false,
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    runMoveToMainWindow(accessor, arg)
  }
}

export class CopyEditorToNewWindowAction extends Action2 {
  static readonly ID = 'workbench.action.copyEditorToNewWindow'
  constructor() {
    super({
      id: CopyEditorToNewWindowAction.ID,
      icon: 'copy',
      title: localize2('action.copyEditorToNewWindow.title', 'Copy Editor into New Window'),
      category: CATEGORY,
      keybinding: { primary: ['ctrl+k', 'o'], when: 'hasActiveEditor' },
      precondition: 'hasActiveEditor',
      menu: { id: MenuId.EditorTabContext, group: '2_newWindow', order: 40 },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    runMoveEditor(accessor, arg, true)
  }
}

export class MoveEditorGroupToNewWindowAction extends Action2 {
  static readonly ID = 'workbench.action.moveEditorGroupToNewWindow'
  constructor() {
    super({
      id: MoveEditorGroupToNewWindowAction.ID,
      icon: 'move',
      title: localize2('action.moveEditorGroupToNewWindow.title', 'Move Group into New Window'),
      category: CATEGORY,
      // Group commands live on the tab bar background: they act on the group
      // that was right-clicked, never on the workbench-active editor.
      menu: { id: MenuId.EditorTabsBarContext, group: '2_newWindow', order: 10 },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    runMoveGroup(accessor, arg, false)
  }
}

export class CopyEditorGroupToNewWindowAction extends Action2 {
  static readonly ID = 'workbench.action.copyEditorGroupToNewWindow'
  constructor() {
    super({
      id: CopyEditorGroupToNewWindowAction.ID,
      icon: 'copy',
      title: localize2('action.copyEditorGroupToNewWindow.title', 'Copy Group into New Window'),
      category: CATEGORY,
      menu: { id: MenuId.EditorTabsBarContext, group: '2_newWindow', order: 40 },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    runMoveGroup(accessor, arg, true)
  }
}

export class MoveEditorGroupToMainWindowAction extends Action2 {
  static readonly ID = 'workbench.action.moveEditorGroupToMainWindow'
  constructor() {
    super({
      id: MoveEditorGroupToMainWindowAction.ID,
      icon: 'arrow-left',
      title: localize2('action.moveEditorGroupToMainWindow.title', 'Move Group to Main Window'),
      category: CATEGORY,
      menu: [
        {
          id: MenuId.EditorTabsBarContext,
          group: '2_newWindow',
          order: 30,
          when: 'isAuxiliaryEditorWindow',
        },
        {
          id: MenuId.CommandPalette,
          when: 'isAuxiliaryEditorWindow',
        },
      ],
      f1: false,
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    runMoveGroupToMainWindow(accessor, arg)
  }
}

export class NewEmptyEditorWindowAction extends Action2 {
  static readonly ID = 'workbench.action.newEmptyEditorWindow'
  constructor() {
    super({
      id: NewEmptyEditorWindowAction.ID,
      icon: 'empty-window',
      title: localize2('action.newEmptyEditorWindow.title', 'New Empty Editor Window'),
      category: CATEGORY,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const service = accessor.get(IAuxiliaryEditorWindowService)
    void service.createEmptyWindow({ explicitEmpty: true })
  }
}

export class RestoreEditorsToMainWindowAction extends Action2 {
  static readonly ID = 'workbench.action.restoreEditorsToMainWindow'
  constructor() {
    super({
      id: RestoreEditorsToMainWindowAction.ID,
      title: localize2('action.restoreEditorsToMainWindow.title', 'Restore Editors to Main Window'),
      category: CATEGORY,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAuxiliaryEditorWindowService).restoreAllToMainWindow()
  }
}

export class MoveEditorToWindowAction extends Action2 {
  static readonly ID = 'workbench.action.moveEditorToWindow'
  constructor() {
    super({
      id: MoveEditorToWindowAction.ID,
      icon: 'move',
      title: localize2('action.moveEditorToWindow.title', 'Move Editor into Window…'),
      category: CATEGORY,
      precondition: 'hasActiveEditor && hasOtherEditorWindows',
      menu: { id: MenuId.EditorTabContext, group: '2_newWindow', order: 20 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    await runTransferEditor(accessor, arg, 'move')
  }
}

export class CopyEditorToWindowAction extends Action2 {
  static readonly ID = 'workbench.action.copyEditorToWindow'
  constructor() {
    super({
      id: CopyEditorToWindowAction.ID,
      icon: 'copy',
      title: localize2('action.copyEditorToWindow.title', 'Copy Editor into Window…'),
      category: CATEGORY,
      precondition: 'hasActiveEditor && hasOtherEditorWindows',
      menu: { id: MenuId.EditorTabContext, group: '2_newWindow', order: 50 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    await runTransferEditor(accessor, arg, 'copy')
  }
}

export class MoveEditorGroupToWindowAction extends Action2 {
  static readonly ID = 'workbench.action.moveEditorGroupToWindow'
  constructor() {
    super({
      id: MoveEditorGroupToWindowAction.ID,
      icon: 'move',
      title: localize2('action.moveEditorGroupToWindow.title', 'Move Group into Window…'),
      category: CATEGORY,
      precondition: 'hasOtherEditorWindows',
      menu: { id: MenuId.EditorTabsBarContext, group: '2_newWindow', order: 20 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    await runTransferGroup(accessor, arg, 'move')
  }
}

export class CopyEditorGroupToWindowAction extends Action2 {
  static readonly ID = 'workbench.action.copyEditorGroupToWindow'
  constructor() {
    super({
      id: CopyEditorGroupToWindowAction.ID,
      icon: 'copy',
      title: localize2('action.copyEditorGroupToWindow.title', 'Copy Group into Window…'),
      category: CATEGORY,
      precondition: 'hasOtherEditorWindows',
      menu: { id: MenuId.EditorTabsBarContext, group: '2_newWindow', order: 50 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    await runTransferGroup(accessor, arg, 'copy')
  }
}
