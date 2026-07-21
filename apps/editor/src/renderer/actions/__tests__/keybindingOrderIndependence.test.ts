/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression lock for the keybinding 去顺序化 change: context-scoped bindings
 *  (Explorer undo/redo, Quick Input escape, ACP prompt-suggestion, in-session
 *  find, Outline navigation) now carry an explicit weight above the default
 *  WorkbenchContrib. This test proves the scoped binding wins over a competing
 *  default-weight global binding *regardless of registration order* — the whole
 *  point of moving off the fragile newest-wins tie-break.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  ContextKeyService,
  KeybindingsRegistry,
  registerAction2,
  type Action2,
  type IDisposable,
} from '@universe-editor/platform'
import {
  RedoExplorerFileOperationAction,
  UndoExplorerFileOperationAction,
} from '../explorerUndoActions.js'
import { CloseQuickInputAction } from '../quickInputActions.js'
import {
  ChatFindAction,
  ChatFindCloseAction,
  ChatFindNextAction,
  ChatFindPreviousAction,
  HideAcpPromptSuggestionAction,
  SelectNextAcpPromptSuggestionAction,
  SelectPreviousAcpPromptSuggestionAction,
} from '../agentTimelineActions.js'
import { OutlineNavigateDownAction, OutlineNavigateUpAction } from '../outlineActions.js'

/**
 * A conflicting global command bound to the same key at the DEFAULT weight
 * (WorkbenchContrib), with no when-clause — the shape of Monaco / global
 * bindings the scoped ones must beat.
 */
const GLOBAL_COMMAND = 'test.global.command'

interface Scenario {
  readonly name: string
  /** Physical key the scoped binding and the global binding both claim. */
  readonly key: string
  /** ContextKey overrides that make the scoped binding's when-clause hold. */
  readonly context: Record<string, unknown>
  /** The scoped Action2 that should win when its context is active. */
  readonly scoped: new () => Action2
  /** Its command id. */
  readonly scopedId: string
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'Explorer undo (ctrl+z) beats global undo',
    key: 'ctrl+z',
    context: {
      focusedView: 'workbench.view.explorer.tree',
      explorerEnableUndo: true,
    },
    scoped: UndoExplorerFileOperationAction,
    scopedId: UndoExplorerFileOperationAction.ID,
  },
  {
    name: 'Explorer redo (ctrl+y) beats global redo',
    key: 'ctrl+y',
    context: {
      focusedView: 'workbench.view.explorer.tree',
      explorerEnableUndo: true,
    },
    scoped: RedoExplorerFileOperationAction,
    scopedId: RedoExplorerFileOperationAction.ID,
  },
  {
    name: 'Quick Input escape beats global escape',
    key: 'escape',
    context: { quickInputVisible: true },
    scoped: CloseQuickInputAction,
    scopedId: CloseQuickInputAction.ID,
  },
  {
    name: 'Prompt suggestion down beats global down',
    key: 'down',
    context: { acpPromptPopupVisible: true },
    scoped: SelectNextAcpPromptSuggestionAction,
    scopedId: SelectNextAcpPromptSuggestionAction.ID,
  },
  {
    name: 'Prompt suggestion up beats global up',
    key: 'up',
    context: { acpPromptPopupVisible: true },
    scoped: SelectPreviousAcpPromptSuggestionAction,
    scopedId: SelectPreviousAcpPromptSuggestionAction.ID,
  },
  {
    name: 'Prompt suggestion escape beats global escape',
    key: 'escape',
    context: { acpPromptPopupVisible: true },
    scoped: HideAcpPromptSuggestionAction,
    scopedId: HideAcpPromptSuggestionAction.ID,
  },
  {
    name: 'In-session find next (f3) beats global f3',
    key: 'f3',
    context: { acpChatFindVisible: true },
    scoped: ChatFindNextAction,
    scopedId: ChatFindNextAction.ID,
  },
  {
    name: 'In-session find previous (shift+f3) beats global shift+f3',
    key: 'shift+f3',
    context: { acpChatFindVisible: true },
    scoped: ChatFindPreviousAction,
    scopedId: ChatFindPreviousAction.ID,
  },
  {
    name: 'In-session find close (escape) beats global escape',
    key: 'escape',
    context: { acpChatFindVisible: true },
    scoped: ChatFindCloseAction,
    scopedId: ChatFindCloseAction.ID,
  },
  {
    name: 'In-session find open (ctrl+f) beats global ctrl+f',
    key: 'ctrl+f',
    context: { acpChatFocused: true },
    scoped: ChatFindAction,
    scopedId: ChatFindAction.ID,
  },
  {
    name: 'Outline navigate down (ctrl+n) beats global ctrl+n',
    key: 'ctrl+n',
    context: { focusedView: 'workbench.view.outline.main' },
    scoped: OutlineNavigateDownAction,
    scopedId: OutlineNavigateDownAction.ID,
  },
  {
    name: 'Outline navigate up (ctrl+p) beats global ctrl+p',
    key: 'ctrl+p',
    context: { focusedView: 'workbench.view.outline.main' },
    scoped: OutlineNavigateUpAction,
    scopedId: OutlineNavigateUpAction.ID,
  },
]

describe('keybinding order independence — scoped weight beats registration order', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function registerGlobal(key: string): void {
    disposables.push(KeybindingsRegistry.registerKeybinding({ key, command: GLOBAL_COMMAND }))
  }

  for (const scenario of SCENARIOS) {
    // Register scoped LAST — the fragile path where newest-wins already agrees.
    it(`${scenario.name} (global first, scoped last)`, () => {
      registerGlobal(scenario.key)
      disposables.push(registerAction2(scenario.scoped))

      const ctx = new ContextKeyService()
      disposables.push(ctx)
      for (const [k, v] of Object.entries(scenario.context)) ctx.set(k, v)

      expect(KeybindingsRegistry.resolveKeystroke(scenario.key, ctx)).toMatchObject({
        kind: 'execute',
        command: scenario.scopedId,
      })
    })

    // Register scoped FIRST — the case newest-wins would GET WRONG. Weight fixes it.
    it(`${scenario.name} (scoped first, global last)`, () => {
      disposables.push(registerAction2(scenario.scoped))
      registerGlobal(scenario.key)

      const ctx = new ContextKeyService()
      disposables.push(ctx)
      for (const [k, v] of Object.entries(scenario.context)) ctx.set(k, v)

      expect(KeybindingsRegistry.resolveKeystroke(scenario.key, ctx)).toMatchObject({
        kind: 'execute',
        command: scenario.scopedId,
      })
    })

    // When the scoped context is NOT active, the global binding must win — the
    // scoped weight must not leak outside its when-clause.
    it(`${scenario.name} (global wins when context inactive)`, () => {
      disposables.push(registerAction2(scenario.scoped))
      registerGlobal(scenario.key)

      const ctx = new ContextKeyService()
      disposables.push(ctx)

      expect(KeybindingsRegistry.resolveKeystroke(scenario.key, ctx)).toMatchObject({
        kind: 'execute',
        command: GLOBAL_COMMAND,
      })
    })
  }
})
