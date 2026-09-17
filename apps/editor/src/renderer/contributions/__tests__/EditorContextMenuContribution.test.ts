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
import {
  AddSelectionToExistingAgentChatAction,
  AddSelectionToNewAgentChatAction,
} from '../../actions/agentContextActions.js'
import { ShowCommandsAction } from '../../actions/layoutActions.js'
import { EditorContextMenuContribution } from '../EditorContextMenuContribution.js'

const disposables: IDisposable[] = []

function menuItemsFor(overrides: Record<string, unknown>) {
  const ctx = new ContextKeyService().createScoped(overrides)
  disposables.push(ctx)
  return MenuRegistry.getMenuItems(MenuId.EditorContext, ctx).filter(
    (e): e is { command: string; group?: string; order?: number } => 'command' in e,
  )
}

function menuCommandsFor(overrides: Record<string, unknown>): string[] {
  return menuItemsFor(overrides).map((e) => e.command)
}

afterEach(() => {
  while (disposables.length) disposables.pop()!.dispose()
})

describe('EditorContextMenuContribution', () => {
  it('registers command palette, both agent entries and clipboard items', () => {
    disposables.push(new EditorContextMenuContribution())
    const commands = menuCommandsFor({ editorHasSelection: true })
    expect(commands).toContain(ShowCommandsAction.ID)
    expect(commands).toContain(AddSelectionToExistingAgentChatAction.ID)
    expect(commands).toContain(AddSelectionToNewAgentChatAction.ID)
    expect(commands).toContain('editor.action.clipboardCutAction')
    expect(commands).toContain('editor.action.clipboardCopyAction')
    expect(commands).toContain('editor.action.clipboardPasteAction')
  })

  it('orders the existing-chat entry first, both in the agent group', () => {
    disposables.push(new EditorContextMenuContribution())
    const agent = menuItemsFor({ editorHasSelection: true }).filter((e) =>
      e.command.startsWith('workbench.action.agent.addSelectionTo'),
    )
    expect(agent.map((e) => e.command)).toEqual([
      AddSelectionToExistingAgentChatAction.ID,
      AddSelectionToNewAgentChatAction.ID,
    ])
    expect(agent.map((e) => e.group)).toEqual(['1_agent', '1_agent'])
    expect(agent.map((e) => e.order)).toEqual([1, 2])
  })

  it('hides both agent entries without a selection', () => {
    disposables.push(new EditorContextMenuContribution())
    const commands = menuCommandsFor({ editorHasSelection: false })
    expect(commands).not.toContain(AddSelectionToExistingAgentChatAction.ID)
    expect(commands).not.toContain(AddSelectionToNewAgentChatAction.ID)
  })

  it('hides cut/paste in a read-only editor but keeps copy', () => {
    disposables.push(new EditorContextMenuContribution())
    const commands = menuCommandsFor({ editorReadonly: true })
    expect(commands).not.toContain('editor.action.clipboardCutAction')
    expect(commands).not.toContain('editor.action.clipboardPasteAction')
    expect(commands).toContain('editor.action.clipboardCopyAction')
  })
})
