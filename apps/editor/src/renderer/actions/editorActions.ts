/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Editor command Action2 definitions: close / tab navigation / split / focus.
 *  Inspired by VSCode's `editorActions.ts` and `editorCommands.ts`.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ConfigurationTarget,
  GroupDirection,
  GroupLocation,
  IConfigurationService,
  IContextKeyService,
  IDialogService,
  IEditorGroupsService,
  MenuId,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { closeEditorWithConfirm } from '../services/editor/closeEditorWithConfirm.js'
import { focusEditorInput } from '../services/editor/editorFocus.js'

// ---------------------------------------------------------------------------
// Close group
// ---------------------------------------------------------------------------

export class CloseActiveEditorAction extends Action2 {
  static readonly ID = 'workbench.action.closeActiveEditor'
  constructor() {
    super({
      id: CloseActiveEditorAction.ID,
      title: localize('action.closeActiveEditor.title', 'Close Editor'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+w' },
      precondition: 'hasActiveEditor',
      menu: { id: MenuId.EditorTitle, group: '1_close', order: 1 },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const groups = accessor.get(IEditorGroupsService)
    const editor = groups.activeGroup.activeEditor
    if (editor)
      await closeEditorWithConfirm(editor, groups.activeGroup, accessor.get(IDialogService))
  }
}

export class CloseAllEditorsAction extends Action2 {
  static readonly ID = 'workbench.action.closeAllEditors'
  constructor() {
    super({
      id: CloseAllEditorsAction.ID,
      title: localize('action.closeAllEditors.title', 'Close All Editors'),
      category: localize('command.category.view', 'View'),
      precondition: 'editorIsOpen',
      menu: { id: MenuId.EditorTitle, group: '1_close', order: 4 },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)
    for (const g of groups.groups) g.closeAllEditors()
  }
}

export class CloseOtherEditorsAction extends Action2 {
  static readonly ID = 'workbench.action.closeOtherEditors'
  constructor() {
    super({
      id: CloseOtherEditorsAction.ID,
      title: localize('action.closeOtherEditors.title', 'Close Other Editors'),
      category: localize('command.category.view', 'View'),
      precondition: 'hasActiveEditor',
      menu: { id: MenuId.EditorTitle, group: '1_close', order: 2 },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const group = accessor.get(IEditorGroupsService).activeGroup
    const active = group.activeEditor
    if (!active) return
    for (const e of [...group.editors]) {
      if (e !== active) group.closeEditor(e)
    }
  }
}

export class CloseEditorsToTheRightAction extends Action2 {
  static readonly ID = 'workbench.action.closeEditorsToTheRight'
  constructor() {
    super({
      id: CloseEditorsToTheRightAction.ID,
      title: localize('action.closeEditorsToTheRight.title', 'Close Editors to the Right'),
      category: localize('command.category.view', 'View'),
      precondition: 'hasActiveEditor && !activeEditorIsLastInGroup',
      menu: { id: MenuId.EditorTitle, group: '1_close', order: 3 },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const group = accessor.get(IEditorGroupsService).activeGroup
    const active = group.activeEditor
    if (!active) return
    const idx = group.indexOf(active)
    if (idx === -1) return
    for (const e of group.editors.slice(idx + 1)) {
      group.closeEditor(e)
    }
  }
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------

export class NextEditorAction extends Action2 {
  static readonly ID = 'workbench.action.nextEditor'
  constructor() {
    super({
      id: NextEditorAction.ID,
      title: localize('action.nextEditor.title', 'Open Next Editor'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+tab' },
      precondition: 'hasActiveEditor',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const group = accessor.get(IEditorGroupsService).activeGroup
    const active = group.activeEditor
    if (!active) return
    const idx = group.indexOf(active)
    const next = group.getEditorByIndex(idx + 1) ?? group.getEditorByIndex(0)
    if (next) group.setActive(next)
  }
}

export class PreviousEditorAction extends Action2 {
  static readonly ID = 'workbench.action.previousEditor'
  constructor() {
    super({
      id: PreviousEditorAction.ID,
      title: localize('action.previousEditor.title', 'Open Previous Editor'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+shift+tab' },
      precondition: 'hasActiveEditor',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const group = accessor.get(IEditorGroupsService).activeGroup
    const active = group.activeEditor
    if (!active) return
    const idx = group.indexOf(active)
    const prev = group.getEditorByIndex(idx - 1) ?? group.getEditorByIndex(group.count - 1)
    if (prev) group.setActive(prev)
  }
}

export class FirstEditorInGroupAction extends Action2 {
  static readonly ID = 'workbench.action.firstEditorInGroup'
  constructor() {
    super({
      id: FirstEditorInGroupAction.ID,
      title: localize('action.firstEditorInGroup.title', 'Open First Editor in Group'),
      category: localize('command.category.view', 'View'),
      precondition: 'editorIsOpen',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const group = accessor.get(IEditorGroupsService).activeGroup
    const first = group.getEditorByIndex(0)
    if (first) group.setActive(first)
  }
}

export class LastEditorInGroupAction extends Action2 {
  static readonly ID = 'workbench.action.lastEditorInGroup'
  constructor() {
    super({
      id: LastEditorInGroupAction.ID,
      title: localize('action.lastEditorInGroup.title', 'Open Last Editor in Group'),
      category: localize('command.category.view', 'View'),
      precondition: 'editorIsOpen',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const group = accessor.get(IEditorGroupsService).activeGroup
    const last = group.getEditorByIndex(group.count - 1)
    if (last) group.setActive(last)
  }
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

function splitInDirection(accessor: ServicesAccessor, direction: GroupDirection): void {
  const groups = accessor.get(IEditorGroupsService)
  const source = groups.activeGroup
  const active = source.activeEditor
  if (!active) return
  const newGroup = groups.addGroup(source, direction)
  groups.copyEditor(active, newGroup)
  groups.activateGroup(newGroup)
}

export class SplitEditorRightAction extends Action2 {
  static readonly ID = 'workbench.action.splitEditorRight'
  constructor() {
    super({
      id: SplitEditorRightAction.ID,
      title: localize('action.splitEditorRight.title', 'Split Editor Right'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+\\' },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    splitInDirection(accessor, GroupDirection.Right)
  }
}

export class SplitEditorDownAction extends Action2 {
  static readonly ID = 'workbench.action.splitEditorDown'
  constructor() {
    super({
      id: SplitEditorDownAction.ID,
      title: localize('action.splitEditorDown.title', 'Split Editor Down'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+k' },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    splitInDirection(accessor, GroupDirection.Down)
  }
}

export class SplitEditorLeftAction extends Action2 {
  static readonly ID = 'workbench.action.splitEditorLeft'
  constructor() {
    super({
      id: SplitEditorLeftAction.ID,
      title: localize('action.splitEditorLeft.title', 'Split Editor Left'),
      category: localize('command.category.view', 'View'),
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    splitInDirection(accessor, GroupDirection.Left)
  }
}

export class SplitEditorUpAction extends Action2 {
  static readonly ID = 'workbench.action.splitEditorUp'
  constructor() {
    super({
      id: SplitEditorUpAction.ID,
      title: localize('action.splitEditorUp.title', 'Split Editor Up'),
      category: localize('command.category.view', 'View'),
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    splitInDirection(accessor, GroupDirection.Up)
  }
}

// ---------------------------------------------------------------------------
// Group focus
// ---------------------------------------------------------------------------

export class FocusNextGroupAction extends Action2 {
  static readonly ID = 'workbench.action.focusNextGroup'
  constructor() {
    super({
      id: FocusNextGroupAction.ID,
      title: localize('action.focusNextGroup.title', 'Focus Next Group'),
      category: localize('command.category.view', 'View'),
      precondition: 'editorPartMultipleEditorGroups',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)
    const next = groups.findGroup({ location: GroupLocation.Next }, undefined, true)
    if (next) groups.activateGroup(next)
  }
}

export class FocusPreviousGroupAction extends Action2 {
  static readonly ID = 'workbench.action.focusPreviousGroup'
  constructor() {
    super({
      id: FocusPreviousGroupAction.ID,
      title: localize('action.focusPreviousGroup.title', 'Focus Previous Group'),
      category: localize('command.category.view', 'View'),
      precondition: 'editorPartMultipleEditorGroups',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)
    const prev = groups.findGroup({ location: GroupLocation.Previous }, undefined, true)
    if (prev) groups.activateGroup(prev)
  }
}

export class FocusFirstGroupAction extends Action2 {
  static readonly ID = 'workbench.action.focusFirstGroup'
  constructor() {
    super({
      id: FocusFirstGroupAction.ID,
      title: localize('action.focusFirstGroup.title', 'Focus First Group'),
      category: localize('command.category.view', 'View'),
      precondition: 'editorPartMultipleEditorGroups',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)
    const first = groups.findGroup({ location: GroupLocation.First })
    if (first) groups.activateGroup(first)
  }
}

export class FocusLastGroupAction extends Action2 {
  static readonly ID = 'workbench.action.focusLastGroup'
  constructor() {
    super({
      id: FocusLastGroupAction.ID,
      title: localize('action.focusLastGroup.title', 'Focus Last Group'),
      category: localize('command.category.view', 'View'),
      precondition: 'editorPartMultipleEditorGroups',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)
    const last = groups.findGroup({ location: GroupLocation.Last })
    if (last) groups.activateGroup(last)
  }
}

export class FocusActiveEditorGroupAction extends Action2 {
  static readonly ID = 'workbench.action.focusActiveEditorGroup'
  constructor() {
    super({
      id: FocusActiveEditorGroupAction.ID,
      title: localize('action.focusActiveEditorGroup.title', 'Focus Active Editor Group'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'escape', when: '!quickInputVisible && !editorFocus' },
      precondition: 'hasActiveEditor',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const activeEditor = accessor.get(IEditorGroupsService).activeGroup.activeEditor
    if (activeEditor) focusEditorInput(activeEditor, accessor.get(IContextKeyService))
  }
}

// ---------------------------------------------------------------------------
// Minimap
// ---------------------------------------------------------------------------

export class ToggleMinimapAction extends Action2 {
  static readonly ID = 'editor.action.toggleMinimap'
  constructor() {
    super({
      id: ToggleMinimapAction.ID,
      title: localize('action.toggleMinimap.title', 'Toggle Minimap'),
      category: localize('command.category.view', 'View'),
      menu: { id: MenuId.MenubarViewMenu, group: '3_editor', order: 1 },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const config = accessor.get(IConfigurationService)
    const current = config.get<boolean>('editor.minimap.enabled') ?? true
    config.update('editor.minimap.enabled', !current, ConfigurationTarget.User)
  }
}
