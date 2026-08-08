/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Keyboard Shortcuts editor Action2 commands (VSCode parity). Ids and default
 *  keys mirror VSCode's preferences.ts / preferences.contribution.ts; every
 *  command reaches the live editor through the runtime handle. None of them is
 *  f1-visible, matching VSCode where these live outside the command palette.
 *--------------------------------------------------------------------------------------------*/

import { Action2, KeybindingWeight, localize2 } from '@universe-editor/platform'
import { getActiveKeybindingsEditor } from '../services/keybindings/keybindingsEditorRuntime.js'

// All bindings sit above plain WorkbenchContrib so the editor-scoped key wins
// over same-key global bindings (ctrl+f Find, bare Escape focus-editor-group,
// Explorer ctrl+c/delete) purely by weight, independent of registration order.
const KEYBINDINGS_EDITOR_KEY_WEIGHT = KeybindingWeight.WorkbenchContrib + 50

const TABLE_FOCUS_WHEN = 'inKeybindings && keybindingFocus && !whenFocus'

export class DefineKeybindingAction extends Action2 {
  static readonly ID = 'keybindings.editor.defineKeybinding'
  constructor() {
    super({
      id: DefineKeybindingAction.ID,
      title: localize2('keybindings.action.defineKeybinding.title', 'Change Keybinding'),
      keybinding: {
        primary: 'enter',
        when: TABLE_FOCUS_WHEN,
        weight: KEYBINDINGS_EDITOR_KEY_WEIGHT,
      },
      f1: false,
    })
  }
  override run(): void {
    getActiveKeybindingsEditor()?.defineKeybinding(false)
  }
}

export class AddKeybindingAction extends Action2 {
  static readonly ID = 'keybindings.editor.addKeybinding'
  constructor() {
    super({
      id: AddKeybindingAction.ID,
      title: localize2('keybindings.action.addKeybinding.title', 'Add Keybinding'),
      keybinding: {
        primary: ['ctrl+k', 'ctrl+a'],
        when: TABLE_FOCUS_WHEN,
        weight: KEYBINDINGS_EDITOR_KEY_WEIGHT,
      },
      f1: false,
    })
  }
  override run(): void {
    getActiveKeybindingsEditor()?.defineKeybinding(true)
  }
}

export class DefineWhenExpressionAction extends Action2 {
  static readonly ID = 'keybindings.editor.defineWhenExpression'
  constructor() {
    super({
      id: DefineWhenExpressionAction.ID,
      title: localize2('keybindings.action.defineWhenExpression.title', 'Change When Expression'),
      keybinding: {
        primary: ['ctrl+k', 'ctrl+e'],
        when: TABLE_FOCUS_WHEN,
        weight: KEYBINDINGS_EDITOR_KEY_WEIGHT,
      },
      f1: false,
    })
  }
  override run(): void {
    getActiveKeybindingsEditor()?.defineWhenExpression()
  }
}

export class RemoveKeybindingAction extends Action2 {
  static readonly ID = 'keybindings.editor.removeKeybinding'
  constructor() {
    super({
      id: RemoveKeybindingAction.ID,
      title: localize2('keybindings.action.removeKeybinding.title', 'Remove Keybinding'),
      keybinding: {
        primary: 'delete',
        when: 'inKeybindings && keybindingFocus && !inKeybindingsSearch && !whenFocus',
        weight: KEYBINDINGS_EDITOR_KEY_WEIGHT,
      },
      f1: false,
    })
  }
  override run(): void {
    getActiveKeybindingsEditor()?.removeSelectedKeybinding()
  }
}

export class ResetKeybindingAction extends Action2 {
  static readonly ID = 'keybindings.editor.resetKeybinding'
  constructor() {
    super({
      id: ResetKeybindingAction.ID,
      title: localize2('keybindings.action.resetKeybinding.title', 'Reset Keybinding'),
      f1: false,
    })
  }
  override run(): void {
    getActiveKeybindingsEditor()?.resetSelectedKeybinding()
  }
}

export class CopyKeybindingEntryAction extends Action2 {
  static readonly ID = 'keybindings.editor.copyKeybindingEntry'
  constructor() {
    super({
      id: CopyKeybindingEntryAction.ID,
      title: localize2('keybindings.action.copyKeybindingEntry.title', 'Copy'),
      keybinding: {
        primary: 'ctrl+c',
        when: 'inKeybindings && keybindingFocus && !inKeybindingsSearch && !whenFocus',
        weight: KEYBINDINGS_EDITOR_KEY_WEIGHT,
      },
      f1: false,
    })
  }
  override run(): void {
    getActiveKeybindingsEditor()?.copyEntry('json')
  }
}

export class CopyCommandIdAction extends Action2 {
  static readonly ID = 'keybindings.editor.copyCommandKeybindingEntry'
  constructor() {
    super({
      id: CopyCommandIdAction.ID,
      title: localize2('keybindings.action.copyCommandId.title', 'Copy Command ID'),
      f1: false,
    })
  }
  override run(): void {
    getActiveKeybindingsEditor()?.copyEntry('commandId')
  }
}

export class CopyCommandTitleAction extends Action2 {
  static readonly ID = 'keybindings.editor.copyCommandTitle'
  constructor() {
    super({
      id: CopyCommandTitleAction.ID,
      title: localize2('keybindings.action.copyCommandTitle.title', 'Copy Command Title'),
      f1: false,
    })
  }
  override run(): void {
    getActiveKeybindingsEditor()?.copyEntry('commandTitle')
  }
}

export class ShowSameKeybindingsAction extends Action2 {
  static readonly ID = 'keybindings.editor.showConflicts'
  constructor() {
    super({
      id: ShowSameKeybindingsAction.ID,
      title: localize2('keybindings.action.showSameKeybindings.title', 'Show Same Keybindings'),
      f1: false,
    })
  }
  override run(): void {
    getActiveKeybindingsEditor()?.showSameKeybindings()
  }
}

export class RecordSearchKeysAction extends Action2 {
  static readonly ID = 'keybindings.editor.recordSearchKeys'
  constructor() {
    super({
      id: RecordSearchKeysAction.ID,
      title: localize2('keybindings.action.recordSearchKeys.title', 'Record Keys'),
      keybinding: {
        primary: 'alt+k',
        when: 'inKeybindings && inKeybindingsSearch',
        weight: KEYBINDINGS_EDITOR_KEY_WEIGHT,
      },
      f1: false,
    })
  }
  override run(): void {
    getActiveKeybindingsEditor()?.toggleRecordKeys()
  }
}

export class ToggleSortByPrecedenceAction extends Action2 {
  static readonly ID = 'keybindings.editor.toggleSortByPrecedence'
  constructor() {
    super({
      id: ToggleSortByPrecedenceAction.ID,
      title: localize2('keybindings.action.toggleSortByPrecedence.title', 'Sort by Precedence'),
      keybinding: {
        primary: 'alt+p',
        when: 'inKeybindings',
        weight: KEYBINDINGS_EDITOR_KEY_WEIGHT,
      },
      f1: false,
    })
  }
  override run(): void {
    getActiveKeybindingsEditor()?.toggleSortByPrecedence()
  }
}

export class ClearKeybindingsSearchResultsAction extends Action2 {
  static readonly ID = 'keybindings.editor.clearSearchResults'
  constructor() {
    super({
      id: ClearKeybindingsSearchResultsAction.ID,
      title: localize2('keybindings.action.clearSearchResults.title', 'Clear Search Results'),
      keybinding: {
        primary: 'escape',
        when: 'inKeybindings && inKeybindingsSearch && keybindingsSearchHasValue',
        weight: KEYBINDINGS_EDITOR_KEY_WEIGHT,
      },
      f1: false,
    })
  }
  override run(): void {
    getActiveKeybindingsEditor()?.clearSearch()
  }
}

export class FocusKeybindingsAction extends Action2 {
  static readonly ID = 'keybindings.editor.focusKeybindings'
  constructor() {
    super({
      id: FocusKeybindingsAction.ID,
      title: localize2('keybindings.action.focusKeybindings.title', 'Focus Keybindings'),
      keybinding: {
        primary: 'ctrl+down',
        when: 'inKeybindings && inKeybindingsSearch',
        weight: KEYBINDINGS_EDITOR_KEY_WEIGHT,
      },
      f1: false,
    })
  }
  override run(): void {
    getActiveKeybindingsEditor()?.focusTable()
  }
}

export class SearchKeybindingsAction extends Action2 {
  static readonly ID = 'keybindings.editor.searchKeybindings'
  constructor() {
    super({
      id: SearchKeybindingsAction.ID,
      title: localize2('keybindings.action.searchKeybindings.title', 'Focus Search'),
      keybinding: {
        primary: 'ctrl+f',
        when: 'inKeybindings',
        weight: KEYBINDINGS_EDITOR_KEY_WEIGHT,
      },
      f1: false,
    })
  }
  override run(): void {
    getActiveKeybindingsEditor()?.focusSearch()
  }
}

export const keybindingsEditorActions = [
  DefineKeybindingAction,
  AddKeybindingAction,
  DefineWhenExpressionAction,
  RemoveKeybindingAction,
  ResetKeybindingAction,
  CopyKeybindingEntryAction,
  CopyCommandIdAction,
  CopyCommandTitleAction,
  ShowSameKeybindingsAction,
  RecordSearchKeysAction,
  ToggleSortByPrecedenceAction,
  ClearKeybindingsSearchResultsAction,
  FocusKeybindingsAction,
  SearchKeybindingsAction,
] as const
