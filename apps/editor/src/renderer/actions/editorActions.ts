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
  IDialogService,
  IEditorGroupsService,
  MenuId,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { closeEditorWithConfirm } from '../workbench/editor/closeEditorWithConfirm.js'
import { FileEditorInput } from '../workbench/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../workbench/editor/FileEditorRegistry.js'

// ---------------------------------------------------------------------------
// Close group
// ---------------------------------------------------------------------------

export class CloseActiveEditorAction extends Action2 {
  static readonly ID = 'workbench.action.closeActiveEditor'
  constructor() {
    super({
      id: CloseActiveEditorAction.ID,
      title: 'Close Editor',
      category: 'View',
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
      title: 'Close All Editors',
      category: 'View',
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
      title: 'Close Other Editors',
      category: 'View',
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
      title: 'Close Editors to the Right',
      category: 'View',
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
      title: 'Open Next Editor',
      category: 'View',
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
      title: 'Open Previous Editor',
      category: 'View',
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
      title: 'Open First Editor in Group',
      category: 'View',
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
      title: 'Open Last Editor in Group',
      category: 'View',
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
  const newGroup = groups.addGroup(source, direction)
  const active = source.activeEditor
  if (active) groups.copyEditor(active, newGroup)
  groups.activateGroup(newGroup)
}

export class SplitEditorRightAction extends Action2 {
  static readonly ID = 'workbench.action.splitEditorRight'
  constructor() {
    super({
      id: SplitEditorRightAction.ID,
      title: 'Split Editor Right',
      category: 'View',
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
      title: 'Split Editor Down',
      category: 'View',
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
      title: 'Split Editor Left',
      category: 'View',
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
      title: 'Split Editor Up',
      category: 'View',
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
      title: 'Focus Next Group',
      category: 'View',
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
      title: 'Focus Previous Group',
      category: 'View',
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
      title: 'Focus First Group',
      category: 'View',
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
      title: 'Focus Last Group',
      category: 'View',
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
      title: 'Focus Active Editor Group',
      category: 'View',
      keybinding: { primary: 'escape', when: '!quickInputVisible && !editorFocus' },
      precondition: 'hasActiveEditor',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const activeEditor = accessor.get(IEditorGroupsService).activeGroup.activeEditor
    if (activeEditor instanceof FileEditorInput) {
      FileEditorRegistry.get(activeEditor)?.focus()
    }
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
      title: 'Toggle Minimap',
      category: 'View',
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
