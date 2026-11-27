/*---------------------------------------------------------------------------------------------
 *  The Swarm Changes jump is a tree-level Enter gesture now: the command stays
 *  registered but must NOT claim a global keybinding (Enter and Ctrl+Shift+Enter
 *  belong to the reviews tree's activation semantics).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  KeybindingsRegistry,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { JumpToSwarmChangesAction, SWARM_REVIEWS_VIEW_ID } from '../swarmActions.js'

describe('Swarm actions', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('registers the Swarm Changes jump without a global keybinding', () => {
    disposables.push(registerAction2(JumpToSwarmChangesAction))
    const context = new ContextKeyService()
    context.createKey('focusedView', SWARM_REVIEWS_VIEW_ID)

    expect(CommandsRegistry.getCommand(JumpToSwarmChangesAction.ID)).toBeDefined()
    expect(KeybindingsRegistry.resolveKeybinding('enter', context)).not.toBe(
      JumpToSwarmChangesAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+shift+enter', context)).not.toBe(
      JumpToSwarmChangesAction.ID,
    )
  })
})
