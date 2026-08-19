/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Populates the editor right-click menu (MenuId.EditorContext) with the core
 *  built-in items — command palette, add-selection-to-agent-chat, and the Monaco
 *  clipboard actions (cut/copy/paste). Cut/paste are hidden when the editor is
 *  read-only; the agent action only shows with a non-empty selection. Extensions
 *  contribute further items to the same menu via `contributes.menus['editor/context']`.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  type IWorkbenchContribution,
  localize,
  MenuId,
  MenuRegistry,
} from '@universe-editor/platform'
import { AddSelectionToAgentChatAction } from '../actions/agentContextActions.js'
import { ShowCommandsAction } from '../actions/layoutActions.js'

export class EditorContextMenuContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    this._register(
      MenuRegistry.addMenuItem(MenuId.EditorContext, {
        command: ShowCommandsAction.ID,
        title: localize('action.showAllCommands.title', 'Show All Commands'),
        group: 'navigation',
        order: 1,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.EditorContext, {
        command: AddSelectionToAgentChatAction.ID,
        title: localize('action.agent.addSelectionToChat', 'Add Selection to Agent Chat'),
        when: 'editorHasSelection',
        group: '1_agent',
        order: 1,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.EditorContext, {
        command: 'editor.action.clipboardCutAction',
        title: localize('action.cut.title', 'Cut'),
        when: '!editorReadonly',
        group: '9_cutcopypaste',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.EditorContext, {
        command: 'editor.action.clipboardCopyAction',
        title: localize('action.copy.title', 'Copy'),
        group: '9_cutcopypaste',
        order: 2,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.EditorContext, {
        command: 'editor.action.clipboardPasteAction',
        title: localize('action.paste.title', 'Paste'),
        when: '!editorReadonly',
        group: '9_cutcopypaste',
        order: 3,
      }),
    )
  }
}
