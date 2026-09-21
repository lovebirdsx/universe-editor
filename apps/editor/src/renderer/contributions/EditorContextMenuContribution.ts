/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Populates the editor right-click menu (MenuId.EditorContext) with the core
 *  built-in items — command palette, the two add-selection-to-agent-chat
 *  entries (existing chat / new chat), the sort-selected-lines pair, and the
 *  Monaco clipboard actions (cut/copy/paste). Cut/paste and sort are hidden when
 *  the editor is read-only; the agent actions and sort only show with a non-empty
 *  selection. Extensions contribute further items to the same menu via
 *  `contributes.menus['editor/context']`.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  type IWorkbenchContribution,
  localize,
  MenuId,
  MenuRegistry,
} from '@universe-editor/platform'
import {
  AddSelectionToExistingAgentChatAction,
  AddSelectionToNewAgentChatAction,
} from '../actions/agentContextActions.js'
import { ShowCommandsAction } from '../actions/layoutActions.js'

export class EditorContextMenuContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    this._register(
      MenuRegistry.addMenuItem(MenuId.EditorContext, {
        command: ShowCommandsAction.ID,
        icon: 'list-view',
        title: localize('action.showAllCommands.title', 'Show All Commands'),
        group: 'navigation',
        order: 1,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.EditorContext, {
        command: AddSelectionToExistingAgentChatAction.ID,
        icon: 'sparkle',
        title: localize(
          'action.agent.addSelectionToExistingChat',
          'Add Selection to Existing Agent Chat',
        ),
        when: 'editorHasSelection',
        group: '1_agent',
        order: 1,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.EditorContext, {
        command: AddSelectionToNewAgentChatAction.ID,
        icon: 'add',
        title: localize('action.agent.addSelectionToNewChat', 'Add Selection to New Agent Chat'),
        when: 'editorHasSelection',
        group: '1_agent',
        order: 2,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.EditorContext, {
        command: 'editor.action.sortLinesAscending',
        icon: 'arrow-up',
        title: localize('action.sortLinesAscending.title', 'Sort Selected Lines: Ascending'),
        // Both keys are seeded into the scoped context by EditorContextMenu from
        // the *clicked* editor; the mirrored actions no-op on a read-only model.
        when: 'editorHasSelection && !editorReadonly',
        group: '2_sort',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.EditorContext, {
        command: 'editor.action.sortLinesDescending',
        icon: 'arrow-down',
        title: localize('action.sortLinesDescending.title', 'Sort Selected Lines: Descending'),
        when: 'editorHasSelection && !editorReadonly',
        group: '2_sort',
        order: 2,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.EditorContext, {
        command: 'editor.action.clipboardCutAction',
        icon: 'cut',
        title: localize('action.cut.title', 'Cut'),
        when: '!editorReadonly',
        group: '9_cutcopypaste',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.EditorContext, {
        command: 'editor.action.clipboardCopyAction',
        icon: 'copy',
        title: localize('action.copy.title', 'Copy'),
        group: '9_cutcopypaste',
        order: 2,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.EditorContext, {
        command: 'editor.action.clipboardPasteAction',
        icon: 'paste',
        title: localize('action.paste.title', 'Paste'),
        when: '!editorReadonly',
        group: '9_cutcopypaste',
        order: 3,
      }),
    )
  }
}
