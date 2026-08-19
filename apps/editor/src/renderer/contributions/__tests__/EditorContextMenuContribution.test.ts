/*---------------------------------------------------------------------------------------------
 *  Tests for EditorContextMenuContribution — the built-in editor/context menu
 *  items land in MenuRegistry with the right command + when/group/order gating.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  ContextKeyService,
  MenuId,
  MenuRegistry,
  type IDisposable,
} from '@universe-editor/platform'
import { AddSelectionToAgentChatAction } from '../../actions/agentContextActions.js'
import { ShowCommandsAction } from '../../actions/layoutActions.js'
import { EditorContextMenuContribution } from '../EditorContextMenuContribution.js'

const disposables: IDisposable[] = []

function menuCommandsFor(overrides: Record<string, unknown>): string[] {
  const ctx = new ContextKeyService().createScoped(overrides)
  disposables.push(ctx)
  return MenuRegistry.getMenuItems(MenuId.EditorContext, ctx)
    .filter((e): e is { command: string } => 'command' in e)
    .map((e) => e.command)
}

afterEach(() => {
  while (disposables.length) disposables.pop()!.dispose()
})

describe('EditorContextMenuContribution', () => {
  it('registers command palette, agent and clipboard items', () => {
    disposables.push(new EditorContextMenuContribution())
    const commands = menuCommandsFor({ editorHasSelection: true })
    expect(commands).toContain(ShowCommandsAction.ID)
    expect(commands).toContain(AddSelectionToAgentChatAction.ID)
    expect(commands).toContain('editor.action.clipboardCutAction')
    expect(commands).toContain('editor.action.clipboardCopyAction')
    expect(commands).toContain('editor.action.clipboardPasteAction')
  })

  it('hides the agent item without a selection', () => {
    disposables.push(new EditorContextMenuContribution())
    const commands = menuCommandsFor({ editorHasSelection: false })
    expect(commands).not.toContain(AddSelectionToAgentChatAction.ID)
  })

  it('hides cut/paste in a read-only editor but keeps copy', () => {
    disposables.push(new EditorContextMenuContribution())
    const commands = menuCommandsFor({ editorReadonly: true })
    expect(commands).not.toContain('editor.action.clipboardCutAction')
    expect(commands).not.toContain('editor.action.clipboardPasteAction')
    expect(commands).toContain('editor.action.clipboardCopyAction')
  })
})
