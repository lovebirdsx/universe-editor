/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Populates the editor right-click menu (MenuId.EditorContext) with the core
 *  built-in items — command palette, the two add-selection-to-agent-chat
 *  entries (existing chat / new chat), and the Monaco clipboard actions
 *  (cut/copy/paste). Cut/paste are hidden when the editor is read-only; the
 *  agent actions only show with a non-empty selection. Extensions contribute
 *  further items to the same menu via `contributes.menus['editor/context']`.
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
