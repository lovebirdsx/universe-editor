/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Editor command Action2 definitions: close / tab navigation / split / focus.
 *  Inspired by VSCode's `editorActions.ts` and `editorCommands.ts`.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ConfigurationTarget,
  type EditorInput,
  GroupDirection,
  GroupLocation,
  IConfigurationService,
  IContextKeyService,
  IDialogService,
  IEditorGroupsService,
  type IEditorGroup,
  IQuickInputService,
  type IQuickPickItem,
  MenuId,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { closeEditorWithConfirm } from '../services/editor/closeEditorWithConfirm.js'
import { focusEditorInput } from '../services/editor/editorFocus.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { IRecentEditorsService } from '../services/editor/RecentEditorsService.js'
import { resolveTargetEditor } from './editorActionHelpers.js'

// ---------------------------------------------------------------------------
// Shared helper: activate a group and transfer DOM focus to Monaco
// ---------------------------------------------------------------------------

function activateGroupAndFocus(groups: IEditorGroupsService, group: IEditorGroup): void {
  groups.activateGroup(group)
  const ae = group.activeEditor
  if (!(ae instanceof FileEditorInput)) return
  FileEditorRegistry.get(ae)?.focus()
}

// ---------------------------------------------------------------------------
// Close group
// ---------------------------------------------------------------------------

/**
 * Close a batch of editors from a single group, confirming with the user on
 * each dirty editor. Stops at the first cancel — matching VSCode behaviour
 * (already-closed editors are not reopened).
 */
async function closeEditorsWithConfirm(
  editors: readonly EditorInput[],
  group: IEditorGroup,
  dialogService: IDialogService,
): Promise<void> {
  for (const e of editors) {
    const ok = await closeEditorWithConfirm(e, group, dialogService)
    if (!ok) return
  }
}

export class CloseActiveEditorAction extends Action2 {
  static readonly ID = 'workbench.action.closeActiveEditor'
  constructor() {
    super({
      id: CloseActiveEditorAction.ID,
      title: localize('action.closeActiveEditor.title', 'Close Editor'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+w' },
      precondition: 'hasActiveEditor',
      menu: [
        { id: MenuId.EditorTitle, group: '1_close', order: 10 },
        { id: MenuId.EditorTabContext, group: '1_close', order: 10 },
      ],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    const target = resolveTargetEditor(accessor, arg)
    if (!target) return
    await closeEditorWithConfirm(target.editor, target.group, accessor.get(IDialogService))
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
      menu: [
        { id: MenuId.EditorTitle, group: '1_close', order: 20 },
        { id: MenuId.EditorTabContext, group: '1_close', order: 20 },
      ],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    const target = resolveTargetEditor(accessor, arg)
    if (!target) return
    const { group, editor } = target
    const others = group.editors.filter((e) => e !== editor)
    await closeEditorsWithConfirm(others, group, accessor.get(IDialogService))
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
      menu: [
        { id: MenuId.EditorTitle, group: '1_close', order: 30 },
        { id: MenuId.EditorTabContext, group: '1_close', order: 30 },
      ],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    const target = resolveTargetEditor(accessor, arg)
    if (!target) return
    const { group, editor } = target
    const idx = group.indexOf(editor)
    if (idx === -1) return
    await closeEditorsWithConfirm(group.editors.slice(idx + 1), group, accessor.get(IDialogService))
  }
}

export class CloseEditorsToTheLeftAction extends Action2 {
  static readonly ID = 'workbench.action.closeEditorsToTheLeft'
  constructor() {
    super({
      id: CloseEditorsToTheLeftAction.ID,
      title: localize('action.closeEditorsToTheLeft.title', 'Close Editors to the Left'),
      category: localize('command.category.view', 'View'),
      precondition: 'hasActiveEditor && !activeEditorIsFirstInGroup',
      menu: [
        { id: MenuId.EditorTitle, group: '1_close', order: 40 },
        { id: MenuId.EditorTabContext, group: '1_close', order: 40 },
      ],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    const target = resolveTargetEditor(accessor, arg)
    if (!target) return
    const { group, editor } = target
    const idx = group.indexOf(editor)
    if (idx <= 0) return
    await closeEditorsWithConfirm(group.editors.slice(0, idx), group, accessor.get(IDialogService))
  }
}

export class CloseUnmodifiedEditorsAction extends Action2 {
  static readonly ID = 'workbench.action.closeUnmodifiedEditors'
  constructor() {
    super({
      id: CloseUnmodifiedEditorsAction.ID,
      title: localize('action.closeUnmodifiedEditors.title', 'Close Saved Editors'),
      category: localize('command.category.view', 'View'),
      precondition: 'editorIsOpen',
      menu: [
        { id: MenuId.EditorTitle, group: '1_close', order: 50 },
        { id: MenuId.EditorTabContext, group: '1_close', order: 50 },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    const target = resolveTargetEditor(accessor, arg)
    if (!target) return
    const { group } = target
    for (const e of [...group.editors]) {
      if (!e.isDirty) group.closeEditor(e)
    }
  }
}

export class CloseEditorsInGroupAction extends Action2 {
  static readonly ID = 'workbench.action.closeEditorsInGroup'
  constructor() {
    super({
      id: CloseEditorsInGroupAction.ID,
      title: localize('action.closeEditorsInGroup.title', 'Close All Editors in Group'),
      category: localize('command.category.view', 'View'),
      precondition: 'editorIsOpen',
      menu: [
        { id: MenuId.EditorTitle, group: '1_close', order: 60 },
        { id: MenuId.EditorTabContext, group: '1_close', order: 60 },
      ],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    const target = resolveTargetEditor(accessor, arg)
    if (!target) return
    await closeEditorsWithConfirm(
      [...target.group.editors],
      target.group,
      accessor.get(IDialogService),
    )
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
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const groups = accessor.get(IEditorGroupsService)
    const dialogService = accessor.get(IDialogService)
    for (const g of groups.groups) {
      for (const e of [...g.editors]) {
        const ok = await closeEditorWithConfirm(e, g, dialogService)
        if (!ok) return
      }
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
      keybinding: { primary: 'ctrl+pagedown' },
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
      keybinding: { primary: 'ctrl+pageup' },
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

// ---------------------------------------------------------------------------
// Quick-pick MRU editor switching (Ctrl+Tab / Ctrl+Shift+Tab)
// ---------------------------------------------------------------------------

// Encodes (groupId, editorId) into a single quick-pick id so we can decode it
// back without an out-of-band map. Editor ids are opaque strings and never
// contain `::` in practice; we still join with a delimiter unlikely to appear.
const PICK_ID_DELIMITER = '::'

function buildRecentEditorPickItems(recentService: IRecentEditorsService): IQuickPickItem[] {
  const items: IQuickPickItem[] = []
  for (const { editor, group } of recentService.getRecentEditors()) {
    items.push({
      id: `${group.id}${PICK_ID_DELIMITER}${editor.id}`,
      label: editor.label,
      description: localize('quickOpenRecentEditor.group', 'Group {id}', { id: group.id }),
    })
  }
  return items
}

async function runQuickOpenRecentEditor(
  accessor: ServicesAccessor,
  reverse: boolean,
): Promise<void> {
  const groups = accessor.get(IEditorGroupsService)
  const recentService = accessor.get(IRecentEditorsService)
  const quickInput = accessor.get(IQuickInputService)

  const items = buildRecentEditorPickItems(recentService)
  if (items.length <= 1) return

  const initialSelectionIndex = reverse ? items.length - 1 : 1
  const picked = await quickInput.pick(items, {
    placeholder: localize('quickOpenRecentEditor.placeholder', 'Recently Used Editors'),
    quickNavigate: { modifier: 'ctrl', initialSelectionIndex },
  })
  if (!picked) return

  const sepIdx = picked.id.indexOf(PICK_ID_DELIMITER)
  if (sepIdx === -1) return
  const groupId = Number(picked.id.slice(0, sepIdx))
  const editorId = picked.id.slice(sepIdx + PICK_ID_DELIMITER.length)
  const group = groups.getGroup(groupId)
  if (!group) return
  const editor = group.editors.find((e) => e.id === editorId)
  if (!editor) return

  groups.activateGroup(group)
  group.setActive(editor)
  activateGroupAndFocus(groups, group)
}

export class QuickOpenRecentEditorAction extends Action2 {
  static readonly ID = 'workbench.action.quickOpenRecentEditor'
  constructor() {
    super({
      id: QuickOpenRecentEditorAction.ID,
      title: localize('action.quickOpenRecentEditor.title', 'Open Recently Used Editor'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+tab', when: '!quickInputVisible' },
      precondition: 'editorIsOpen',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): Promise<void> {
    return runQuickOpenRecentEditor(accessor, false)
  }
}

export class QuickOpenRecentEditorReverseAction extends Action2 {
  static readonly ID = 'workbench.action.quickOpenRecentEditorReverse'
  constructor() {
    super({
      id: QuickOpenRecentEditorReverseAction.ID,
      title: localize(
        'action.quickOpenRecentEditorReverse.title',
        'Open Least Recently Used Editor',
      ),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+shift+tab', when: '!quickInputVisible' },
      precondition: 'editorIsOpen',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): Promise<void> {
    return runQuickOpenRecentEditor(accessor, true)
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
  activateGroupAndFocus(groups, newGroup)
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
      keybinding: { primary: 'alt+0' },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)
    const next = groups.findGroup({ location: GroupLocation.Next }, undefined, true)
    if (next) activateGroupAndFocus(groups, next)
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
      keybinding: { primary: 'alt+9' },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)
    const prev = groups.findGroup({ location: GroupLocation.Previous }, undefined, true)
    if (prev) activateGroupAndFocus(groups, prev)
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
    if (first) activateGroupAndFocus(groups, first)
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
    if (last) activateGroupAndFocus(groups, last)
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
// Direction-based group focus (spatial grid navigation)
// ---------------------------------------------------------------------------

export class FocusLeftGroupAction extends Action2 {
  static readonly ID = 'workbench.action.focusLeftGroup'
  constructor() {
    super({
      id: FocusLeftGroupAction.ID,
      title: localize('action.focusLeftGroup.title', 'Focus Left Editor Group'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: ['ctrl+k', 'ctrl+left'] },
      precondition: 'editorPartMultipleEditorGroups',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)
    const target = groups.findGroup({ direction: GroupDirection.Left })
    if (target) activateGroupAndFocus(groups, target)
  }
}

export class FocusRightGroupAction extends Action2 {
  static readonly ID = 'workbench.action.focusRightGroup'
  constructor() {
    super({
      id: FocusRightGroupAction.ID,
      title: localize('action.focusRightGroup.title', 'Focus Right Editor Group'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: ['ctrl+k', 'ctrl+right'] },
      precondition: 'editorPartMultipleEditorGroups',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)
    const target = groups.findGroup({ direction: GroupDirection.Right })
    if (target) activateGroupAndFocus(groups, target)
  }
}

export class FocusAboveGroupAction extends Action2 {
  static readonly ID = 'workbench.action.focusAboveGroup'
  constructor() {
    super({
      id: FocusAboveGroupAction.ID,
      title: localize('action.focusAboveGroup.title', 'Focus Above Editor Group'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: ['ctrl+k', 'ctrl+up'] },
      precondition: 'editorPartMultipleEditorGroups',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)
    const target = groups.findGroup({ direction: GroupDirection.Up })
    if (target) activateGroupAndFocus(groups, target)
  }
}

export class FocusBelowGroupAction extends Action2 {
  static readonly ID = 'workbench.action.focusBelowGroup'
  constructor() {
    super({
      id: FocusBelowGroupAction.ID,
      title: localize('action.focusBelowGroup.title', 'Focus Below Editor Group'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: ['ctrl+k', 'ctrl+down'] },
      precondition: 'editorPartMultipleEditorGroups',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)
    const target = groups.findGroup({ direction: GroupDirection.Down })
    if (target) activateGroupAndFocus(groups, target)
  }
}

// ---------------------------------------------------------------------------
// Move editor to adjacent group
// ---------------------------------------------------------------------------

function moveEditorInDirection(accessor: ServicesAccessor, direction: GroupDirection): void {
  const groups = accessor.get(IEditorGroupsService)
  const source = groups.activeGroup
  const editor = source.activeEditor
  if (!editor) return
  let target = groups.findGroup({ direction }, source)
  if (!target) target = groups.addGroup(source, direction)
  groups.moveEditor(editor, target)
  activateGroupAndFocus(groups, target)
}

function moveEditorByLocation(
  accessor: ServicesAccessor,
  location: GroupLocation,
  wrap: boolean,
): void {
  const groups = accessor.get(IEditorGroupsService)
  const source = groups.activeGroup
  const editor = source.activeEditor
  if (!editor) return
  const target = groups.findGroup({ location }, source, wrap)
  if (!target || target === source) return
  groups.moveEditor(editor, target)
  activateGroupAndFocus(groups, target)
}

export class MoveEditorToLeftGroupAction extends Action2 {
  static readonly ID = 'workbench.action.moveEditorToLeftGroup'
  constructor() {
    super({
      id: MoveEditorToLeftGroupAction.ID,
      title: localize('action.moveEditorToLeftGroup.title', 'Move Editor into Left Group'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+shift+alt+left' },
      precondition: 'hasActiveEditor',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    moveEditorInDirection(accessor, GroupDirection.Left)
  }
}

export class MoveEditorToRightGroupAction extends Action2 {
  static readonly ID = 'workbench.action.moveEditorToRightGroup'
  constructor() {
    super({
      id: MoveEditorToRightGroupAction.ID,
      title: localize('action.moveEditorToRightGroup.title', 'Move Editor into Right Group'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+shift+alt+right' },
      precondition: 'hasActiveEditor',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    moveEditorInDirection(accessor, GroupDirection.Right)
  }
}

export class MoveEditorToAboveGroupAction extends Action2 {
  static readonly ID = 'workbench.action.moveEditorToAboveGroup'
  constructor() {
    super({
      id: MoveEditorToAboveGroupAction.ID,
      title: localize('action.moveEditorToAboveGroup.title', 'Move Editor into Above Group'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+shift+alt+up' },
      precondition: 'hasActiveEditor',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    moveEditorInDirection(accessor, GroupDirection.Up)
  }
}

export class MoveEditorToBelowGroupAction extends Action2 {
  static readonly ID = 'workbench.action.moveEditorToBelowGroup'
  constructor() {
    super({
      id: MoveEditorToBelowGroupAction.ID,
      title: localize('action.moveEditorToBelowGroup.title', 'Move Editor into Below Group'),
      category: localize('command.category.view', 'View'),
      keybinding: { primary: 'ctrl+shift+alt+down' },
      precondition: 'hasActiveEditor',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    moveEditorInDirection(accessor, GroupDirection.Down)
  }
}

export class MoveEditorToNextGroupAction extends Action2 {
  static readonly ID = 'workbench.action.moveEditorToNextGroup'
  constructor() {
    super({
      id: MoveEditorToNextGroupAction.ID,
      title: localize('action.moveEditorToNextGroup.title', 'Move Editor into Next Group'),
      category: localize('command.category.view', 'View'),
      precondition: 'hasActiveEditor && editorPartMultipleEditorGroups',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    moveEditorByLocation(accessor, GroupLocation.Next, true)
  }
}

export class MoveEditorToPreviousGroupAction extends Action2 {
  static readonly ID = 'workbench.action.moveEditorToPreviousGroup'
  constructor() {
    super({
      id: MoveEditorToPreviousGroupAction.ID,
      title: localize('action.moveEditorToPreviousGroup.title', 'Move Editor into Previous Group'),
      category: localize('command.category.view', 'View'),
      precondition: 'hasActiveEditor && editorPartMultipleEditorGroups',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    moveEditorByLocation(accessor, GroupLocation.Previous, true)
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
