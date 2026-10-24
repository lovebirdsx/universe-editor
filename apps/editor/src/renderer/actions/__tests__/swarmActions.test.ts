/*---------------------------------------------------------------------------------------------
 *  Ctrl+Shift+Enter (not Ctrl+Enter) is the Swarm Changes jump: plain Ctrl+Enter
 *  now belongs to the review row's side-open gesture.
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

  it('registers the Swarm Changes jump on Ctrl+Shift+Enter', () => {
    disposables.push(registerAction2(JumpToSwarmChangesAction))
    const context = new ContextKeyService()
    context.createKey('focusedView', SWARM_REVIEWS_VIEW_ID)

    expect(CommandsRegistry.getCommand(JumpToSwarmChangesAction.ID)).toBeDefined()
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+shift+enter', context)).toBe(
      JumpToSwarmChangesAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+enter', context)).not.toBe(
      JumpToSwarmChangesAction.ID,
    )
  })
})
