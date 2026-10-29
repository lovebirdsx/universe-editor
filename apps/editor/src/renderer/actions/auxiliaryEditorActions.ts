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
  type IEditorGroup,
  MenuId,
  type ServicesAccessor,
  localize2,
} from '@universe-editor/platform'
import { IAuxiliaryEditorWindowService } from '../services/windows/auxiliaryEditorWindowService.js'
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
      menu: { id: MenuId.EditorTabContext, group: '2_newWindow', order: 20 },
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
      menu: { id: MenuId.EditorTabsBarContext, group: '2_newWindow', order: 20 },
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
