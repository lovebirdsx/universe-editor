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
  ScrollAcpTimelineDownAction,
  ScrollAcpTimelinePageDownAction,
  ScrollAcpTimelinePageUpAction,
  ScrollAcpTimelineToBottomAction,
  ScrollAcpTimelineToTopAction,
  ScrollAcpTimelineUpAction,
  SelectNextAcpPromptSuggestionAction,
  SelectPreviousAcpPromptSuggestionAction,
} from '../agentTimelineActions.js'
import { CancelAgentTurnAction } from '../agentSessionActions.js'
import { CancelExplorerMultiSelectionAction } from '../explorerSelectionActions.js'
import { MarkdownPreviewFindCloseAction } from '../markdownActions.js'
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
    name: 'Cancel agent turn (shift+escape) beats global shift+escape while the turn runs',
    key: 'shift+escape',
    context: { acpChatFocused: true, acpChatTurnRunning: true },
    scoped: CancelAgentTurnAction,
    scopedId: CancelAgentTurnAction.ID,
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
  {
    name: 'Explorer cancel multi-selection (escape) beats global escape',
    key: 'escape',
    context: {
      focusedView: 'workbench.view.explorer.tree',
      explorerMultiSelection: true,
    },
    scoped: CancelExplorerMultiSelectionAction,
    scopedId: CancelExplorerMultiSelectionAction.ID,
  },
  {
    name: 'Timeline scroll down (j) beats global j',
    key: 'j',
    context: { acpChatFocused: true },
    scoped: ScrollAcpTimelineDownAction,
    scopedId: ScrollAcpTimelineDownAction.ID,
  },
  {
    name: 'Timeline scroll up (k) beats global k',
    key: 'k',
    context: { acpChatFocused: true },
    scoped: ScrollAcpTimelineUpAction,
    scopedId: ScrollAcpTimelineUpAction.ID,
  },
  {
    name: 'Timeline scroll to top (a) beats global a',
    key: 'a',
    context: { acpChatFocused: true },
    scoped: ScrollAcpTimelineToTopAction,
    scopedId: ScrollAcpTimelineToTopAction.ID,
  },
  {
    name: 'Timeline scroll to bottom (e) beats global e',
    key: 'e',
    context: { acpChatFocused: true },
    scoped: ScrollAcpTimelineToBottomAction,
    scopedId: ScrollAcpTimelineToBottomAction.ID,
  },
  {
    name: 'Timeline page up (shift+k) beats global shift+k',
    key: 'shift+k',
    context: { acpChatFocused: true },
    scoped: ScrollAcpTimelinePageUpAction,
    scopedId: ScrollAcpTimelinePageUpAction.ID,
  },
  {
    name: 'Timeline page down (shift+j) beats global shift+j',
    key: 'shift+j',
    context: { acpChatFocused: true },
    scoped: ScrollAcpTimelinePageDownAction,
    scopedId: ScrollAcpTimelinePageDownAction.ID,
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

describe('Explorer escape vs Markdown find close', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function findVisibleExplorerContext(): ContextKeyService {
    const ctx = new ContextKeyService()
    disposables.push(ctx)
    ctx.set('focusedView', 'workbench.view.explorer.tree')
    ctx.set('explorerMultiSelection', true)
    ctx.set('markdownPreviewFindVisible', true)
    return ctx
  }

  // The find-close binding is a default-weight global Escape binding whose
  // condition does not follow DOM focus. The scoped Explorer binding must win
  // by weight even when it was registered first.
  it('cancel multi-selection wins when registered first', () => {
    disposables.push(registerAction2(CancelExplorerMultiSelectionAction))
    disposables.push(registerAction2(MarkdownPreviewFindCloseAction))

    expect(
      KeybindingsRegistry.resolveKeystroke('escape', findVisibleExplorerContext()),
    ).toMatchObject({ kind: 'execute', command: CancelExplorerMultiSelectionAction.ID })
  })

  it('cancel multi-selection wins when registered last', () => {
    disposables.push(registerAction2(MarkdownPreviewFindCloseAction))
    disposables.push(registerAction2(CancelExplorerMultiSelectionAction))

    expect(
      KeybindingsRegistry.resolveKeystroke('escape', findVisibleExplorerContext()),
    ).toMatchObject({ kind: 'execute', command: CancelExplorerMultiSelectionAction.ID })
  })
})

describe('cancel-turn moved to shift+escape (bare escape stays with the widgets)', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function runningChatContext(overrides: Record<string, unknown>): ContextKeyService {
    const ctx = new ContextKeyService()
    disposables.push(ctx)
    ctx.set('acpChatFocused', true)
    ctx.set('acpChatTurnRunning', true)
    for (const [k, v] of Object.entries(overrides)) ctx.set(k, v)
    return ctx
  }

  // Shift+Esc is deliberately hard to fat-finger and claims no other owner's
  // key, so it cancels the turn even while the popover or find widget is open.
  it('shift+escape cancels while the suggestion popover is open', () => {
    disposables.push(registerAction2(CancelAgentTurnAction))
    disposables.push(registerAction2(HideAcpPromptSuggestionAction))

    const ctx = runningChatContext({ acpPromptPopupVisible: true })
    expect(KeybindingsRegistry.resolveKeystroke('shift+escape', ctx)).toMatchObject({
      kind: 'execute',
      command: CancelAgentTurnAction.ID,
    })
  })

  it('shift+escape cancels while the find widget is open', () => {
    disposables.push(registerAction2(CancelAgentTurnAction))
    disposables.push(registerAction2(ChatFindCloseAction))

    const ctx = runningChatContext({ acpChatFindVisible: true })
    expect(KeybindingsRegistry.resolveKeystroke('shift+escape', ctx)).toMatchObject({
      kind: 'execute',
      command: CancelAgentTurnAction.ID,
    })
  })

  it('escape no longer cancels the turn — it stays with the popover/find widgets', () => {
    disposables.push(registerAction2(CancelAgentTurnAction))
    disposables.push(registerAction2(HideAcpPromptSuggestionAction))
    disposables.push(registerAction2(ChatFindCloseAction))

    const ctx = runningChatContext({ acpPromptPopupVisible: true })
    expect(KeybindingsRegistry.resolveKeystroke('escape', ctx)).toMatchObject({
      kind: 'execute',
      command: HideAcpPromptSuggestionAction.ID,
    })
  })

  it('escape falls through to the global binding when no widget owns it', () => {
    disposables.push(registerAction2(CancelAgentTurnAction))
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ key: 'escape', command: GLOBAL_COMMAND }),
    )

    const ctx = runningChatContext({})
    expect(KeybindingsRegistry.resolveKeystroke('escape', ctx)).toMatchObject({
      kind: 'execute',
      command: GLOBAL_COMMAND,
    })
  })

  it('shift+escape stays global when the turn is not running', () => {
    disposables.push(registerAction2(CancelAgentTurnAction))
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ key: 'shift+escape', command: GLOBAL_COMMAND }),
    )

    const ctx = new ContextKeyService()
    disposables.push(ctx)
    ctx.set('acpChatFocused', true)

    expect(KeybindingsRegistry.resolveKeystroke('shift+escape', ctx)).toMatchObject({
      kind: 'execute',
      command: GLOBAL_COMMAND,
    })
  })
})
