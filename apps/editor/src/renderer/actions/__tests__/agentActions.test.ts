import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  EditorInput,
  IDialogService,
  IEditorGroupsService,
  IEditorService,
  IFileDialogService,
  IHostService,
  IInstantiationService,
  ILoggerService,
  MenuId,
  MenuRegistry,
  INotificationService,
  IQuickInputService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationService,
  KeybindingsRegistry,
  KeybindingWeight,
  NullLogger,
  REMOTE_SCHEME,
  ServiceCollection,
  UriIdentityService,
  URI,
  GroupDirection,
  observableValue,
  registerAction2,
  type IDisposable,
  type IQuickPickItem,
} from '@universe-editor/platform'
import {
  ResumeAgentSessionAction,
  RevealAgentSessionInOSAction,
  ScrollAcpTimelinePageDownAction,
  ScrollAcpTimelinePageUpAction,
  FocusBottomAcpTimelineAction,
  FocusTopAcpTimelineAction,
  FocusNextAcpTimelineItemAction,
  FocusPreviousAcpTimelineItemAction,
  FocusDeeperAcpTimelineItemAction,
  FocusOuterAcpTimelineItemAction,
  ToggleAcpTimelineCardSubtreeAction,
  ToggleAcpTimelineItemCollapseAction,
  JumpToAcpPlanAction,
  SelectNextAcpPromptSuggestionAction,
  SelectPreviousAcpPromptSuggestionAction,
  AcceptAcpPromptSuggestionAction,
  HideAcpPromptSuggestionAction,
  NewAgentSessionInCurrentEditorAction,
} from '../agentActions.js'
import { NewSideTaskAction } from '../agentSessionActions.js'
import { ActivateAgentConfigEntryAction } from '../agentModelActions.js'
import {
  NewAgentSessionInFolderAction,
  NewAgentSessionWithScopeAction,
} from '../agentSessionActions.js'
import { FindWordAtCursorNextAction, FindWordAtCursorPreviousAction } from '../findWordActions.js'
import { AcpPromptReplaceInbox } from '../../services/acp/session/acpPromptReplaceInbox.js'
import { makeFakeAcpChatWidget } from '../../__tests__/_helpers/fakeAcpChatWidget.js'
import {
  IAcpChatWidgetService,
  type AcpChatWidget,
} from '../../services/acp/session/acpChatWidgetService.js'
import {
  AcpForeignWorktreeError,
  IAcpSessionService,
  type AcpMessage,
  type AcpToolCall,
  type IAcpSession,
  type TimelineItem,
} from '../../services/acp/session/acpSessionService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
} from '../../services/acp/session/acpSessionHistory.js'
import {
  ISubProjectService,
  type SubProjectScope,
} from '../../services/acp/session/acpSubProjectService.js'
import { AcpSessionEditorInput } from '../../services/acp/session/acpSessionEditorInput.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { IAcpLastSessionCwdService } from '../../services/acp/session/acpLastSessionCwdService.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { EditorService } from '../../services/editor/EditorService.js'
import { Event } from '@universe-editor/platform'

/** AcpSessionEditorInput's cwd-badge autorun pulls these two services. */
function registerWorkspaceServices(services: ServiceCollection): void {
  services.set(IWorkspaceService, {
    _serviceBrand: undefined,
    current: null,
    onDidChangeWorkspace: Event.None,
  } as unknown as IWorkspaceService)
  services.set(IUriIdentityService, { _serviceBrand: undefined } as unknown as IUriIdentityService)
}

describe('Agent timeline navigation actions', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function focusedContext(): ContextKeyService {
    const ctx = new ContextKeyService()
    ctx.createKey<boolean>('acpChatFocused', true)
    return ctx
  }

  function makeWidget(): {
    widget: AcpChatWidget
    moveTimeline: ReturnType<typeof vi.fn>
    moveTimelineLevel: ReturnType<typeof vi.fn>
    scrollTimeline: ReturnType<typeof vi.fn>
    jumpToPlan: ReturnType<typeof vi.fn>
    popoverSelectNext: ReturnType<typeof vi.fn>
    popoverSelectPrev: ReturnType<typeof vi.fn>
    popoverAccept: ReturnType<typeof vi.fn>
    popoverHide: ReturnType<typeof vi.fn>
  } {
    const moveTimeline = vi.fn()
    const moveTimelineLevel = vi.fn()
    const scrollTimeline = vi.fn()
    const jumpToPlan = vi.fn()
    const popoverSelectNext = vi.fn()
    const popoverSelectPrev = vi.fn()
    const popoverAccept = vi.fn()
    const popoverHide = vi.fn()
    return {
      moveTimeline,
      moveTimelineLevel,
      scrollTimeline,
      jumpToPlan,
      popoverSelectNext,
      popoverSelectPrev,
      popoverAccept,
      popoverHide,
      widget: makeFakeAcpChatWidget({
        moveTimeline,
        moveTimelineLevel,
        scrollTimeline,
        jumpToPlan,
        popoverSelectNext,
        popoverSelectPrev,
        popoverAccept,
        popoverHide,
      }),
    }
  }

  function run(commandId: string, widget: AcpChatWidget): void {
    const services = new ServiceCollection()
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      lastFocusedWidget: widget,
      register: vi.fn(),
      widgetForSession: () => undefined,
    } as unknown as IAcpChatWidgetService)
    // No active session editor → resolveNavWidget falls back to lastFocusedWidget.
    services.set(IEditorService, {
      _serviceBrand: undefined,
      activeEditor: observableValue<unknown>('t.activeEditor', undefined),
    } as unknown as IEditorService)
    const inst = new InstantiationService(services)
    inst.invokeFunction((accessor) => {
      CommandsRegistry.getCommand(commandId)!.handler(accessor)
    })
  }

  it('binds top/bottom keys and moves focus to first/last timeline item', () => {
    disposables.push(registerAction2(FocusTopAcpTimelineAction))
    disposables.push(registerAction2(FocusBottomAcpTimelineAction))
    const ctx = focusedContext()
    expect(KeybindingsRegistry.resolveKeybinding('alt+a', ctx)).toBe(FocusTopAcpTimelineAction.ID)
    expect(KeybindingsRegistry.resolveKeybinding('alt+e', ctx)).toBe(
      FocusBottomAcpTimelineAction.ID,
    )

    const top = makeWidget()
    run(FocusTopAcpTimelineAction.ID, top.widget)
    expect(top.moveTimeline).toHaveBeenCalledWith('first')
    expect(top.scrollTimeline).not.toHaveBeenCalled()

    const bottom = makeWidget()
    run(FocusBottomAcpTimelineAction.ID, bottom.widget)
    expect(bottom.moveTimeline).toHaveBeenCalledWith('last')
    expect(bottom.scrollTimeline).not.toHaveBeenCalled()
  })

  it('binds Alt+P to jump to the plan card', () => {
    disposables.push(registerAction2(JumpToAcpPlanAction))
    const ctx = focusedContext()
    expect(KeybindingsRegistry.resolveKeybinding('alt+p', ctx)).toBe(JumpToAcpPlanAction.ID)

    const w = makeWidget()
    run(JumpToAcpPlanAction.ID, w.widget)
    expect(w.jumpToPlan).toHaveBeenCalledTimes(1)
    expect(w.moveTimeline).not.toHaveBeenCalled()
  })

  it('binds Alt+L/Alt+H to step into / out of a sub-agent timeline level', () => {
    disposables.push(registerAction2(FocusDeeperAcpTimelineItemAction))
    disposables.push(registerAction2(FocusOuterAcpTimelineItemAction))
    const ctx = focusedContext()
    expect(KeybindingsRegistry.resolveKeybinding('alt+l', ctx)).toBe(
      FocusDeeperAcpTimelineItemAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('alt+h', ctx)).toBe(
      FocusOuterAcpTimelineItemAction.ID,
    )

    const deeper = makeWidget()
    run(FocusDeeperAcpTimelineItemAction.ID, deeper.widget)
    expect(deeper.moveTimelineLevel).toHaveBeenCalledWith('in')
    expect(deeper.moveTimeline).not.toHaveBeenCalled()

    const outer = makeWidget()
    run(FocusOuterAcpTimelineItemAction.ID, outer.widget)
    expect(outer.moveTimelineLevel).toHaveBeenCalledWith('out')
    expect(outer.moveTimeline).not.toHaveBeenCalled()
  })

  it('binds Ctrl+Alt+PageUp/PageDown to page scroll without moving focus', () => {
    disposables.push(registerAction2(ScrollAcpTimelinePageUpAction))
    disposables.push(registerAction2(ScrollAcpTimelinePageDownAction))
    const ctx = focusedContext()
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+alt+pageup', ctx)).toBe(
      ScrollAcpTimelinePageUpAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+alt+pagedown', ctx)).toBe(
      ScrollAcpTimelinePageDownAction.ID,
    )

    const pageUp = makeWidget()
    run(ScrollAcpTimelinePageUpAction.ID, pageUp.widget)
    expect(pageUp.scrollTimeline).toHaveBeenCalledWith('pageUp')
    expect(pageUp.moveTimeline).not.toHaveBeenCalled()

    const pageDown = makeWidget()
    run(ScrollAcpTimelinePageDownAction.ID, pageDown.widget)
    expect(pageDown.scrollTimeline).toHaveBeenCalledWith('pageDown')
    expect(pageDown.moveTimeline).not.toHaveBeenCalled()
  })

  // The chat is reachable from the keyboard whenever a session editor is active
  // AND focus is in the editor area, even if DOM focus never entered its timeline
  // (read-only foreign session, which focuses the editor group body).
  it('binds nav keys when a session editor is active and the editor area has focus', () => {
    disposables.push(registerAction2(FocusTopAcpTimelineAction))
    const ctx = new ContextKeyService()
    ctx.createKey<string>('activeEditorTypeId', AcpSessionEditorInput.TYPE_ID)
    ctx.createKey<boolean>('editorAreaFocus', true)
    expect(KeybindingsRegistry.resolveKeybinding('alt+a', ctx)).toBe(FocusTopAcpTimelineAction.ID)
  })

  // The whole point of the editorAreaFocus conjunct: a session editor can be the
  // active editor while focus sits elsewhere (command palette, focused terminal /
  // panel, sidebar). The nav keys must NOT fire there.
  it('does not bind nav keys when a session editor is active but focus is outside the editor area', () => {
    disposables.push(registerAction2(FocusTopAcpTimelineAction))
    const ctx = new ContextKeyService()
    ctx.createKey<string>('activeEditorTypeId', AcpSessionEditorInput.TYPE_ID)
    ctx.createKey<boolean>('editorAreaFocus', false)
    expect(KeybindingsRegistry.resolveKeybinding('alt+a', ctx)).toBeUndefined()
  })

  it('does not bind nav keys when neither focused nor a session editor is active', () => {
    disposables.push(registerAction2(FocusTopAcpTimelineAction))
    const ctx = new ContextKeyService()
    ctx.createKey<string>('activeEditorTypeId', 'some.other.editor')
    ctx.createKey<boolean>('editorAreaFocus', true)
    expect(KeybindingsRegistry.resolveKeybinding('alt+a', ctx)).toBeUndefined()
  })

  // Routing: when the active editor is a session editor, the command targets that
  // session's widget via widgetForSession — even if lastFocusedWidget is undefined
  // (focus never landed in the read-only chat).
  it('routes to the active session editor widget when focus never entered the chat', () => {
    disposables.push(registerAction2(FocusTopAcpTimelineAction))
    const w = makeWidget()
    const services = new ServiceCollection()
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      lastFocusedWidget: undefined,
      register: vi.fn(),
      widgetForSession: (id: string) => (id === 'sess-1' ? w.widget : undefined),
    } as unknown as IAcpChatWidgetService)
    const input = { sessionId: 'sess-1' }
    Object.setPrototypeOf(input, AcpSessionEditorInput.prototype)
    services.set(IEditorService, {
      _serviceBrand: undefined,
      activeEditor: observableValue<unknown>('t.activeEditor', input),
    } as unknown as IEditorService)
    const inst = new InstantiationService(services)
    inst.invokeFunction((accessor) => {
      CommandsRegistry.getCommand(FocusTopAcpTimelineAction.ID)!.handler(accessor)
    })
    expect(w.moveTimeline).toHaveBeenCalledWith('first')
  })

  // The prompt input is an embedded Monaco editor, so while it has focus both
  // `editorTextFocus` and `acpChatFocused` hold. findWordAtCursor binds the same
  // Alt+Up/Down keys at the default weight (when `editorTextFocus && !findWidgetVisible`),
  // so the timeline nav binding must outrank it regardless of registration order.
  it('binds Alt+Up/Down to timeline nav over findWordAtCursor while the prompt input has focus', () => {
    disposables.push(registerAction2(FocusPreviousAcpTimelineItemAction))
    disposables.push(registerAction2(FocusNextAcpTimelineItemAction))
    disposables.push(registerAction2(FindWordAtCursorPreviousAction))
    disposables.push(registerAction2(FindWordAtCursorNextAction))

    const ctx = new ContextKeyService()
    ctx.createKey<boolean>('editorTextFocus', true)
    ctx.createKey<boolean>('acpChatFocused', true)
    ctx.createKey<boolean>('hasActiveEditor', true)

    expect(KeybindingsRegistry.resolveKeybinding('alt+up', ctx)).toBe(
      FocusPreviousAcpTimelineItemAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('alt+down', ctx)).toBe(
      FocusNextAcpTimelineItemAction.ID,
    )
  })

  // Reverse case: a normal text editor has focus (editorTextFocus holds, the chat
  // doesn't). Alt+Up/Down must stay with findWordAtCursor — the scoped weight
  // must not leak outside ACP_NAV_WHEN.
  it('keeps Alt+Up/Down with findWordAtCursor in a normal editor (no acpChatFocused)', () => {
    disposables.push(registerAction2(FocusPreviousAcpTimelineItemAction))
    disposables.push(registerAction2(FocusNextAcpTimelineItemAction))
    disposables.push(registerAction2(FindWordAtCursorPreviousAction))
    disposables.push(registerAction2(FindWordAtCursorNextAction))

    const ctx = new ContextKeyService()
    ctx.createKey<boolean>('editorTextFocus', true)
    ctx.createKey<boolean>('hasActiveEditor', true)
    ctx.createKey<boolean>('editorAreaFocus', true)
    ctx.createKey<string>('activeEditorTypeId', 'some.other.editor')

    expect(KeybindingsRegistry.resolveKeybinding('alt+up', ctx)).toBe(
      FindWordAtCursorPreviousAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('alt+down', ctx)).toBe(
      FindWordAtCursorNextAction.ID,
    )
  })

  // The prompt input is an embedded Monaco editor, but it must NOT mirror focus
  // onto `editorTextFocus` (commands gated on that key assume a real file editor
  // is actionable — findWordAtCursor, dirtyDiff, inline completion, …). It sets
  // its own `acpPromptInputFocused` key instead. Here a VSCode-imported
  // User-weight binding (findWordAtCursor.previous on Alt+Up) would otherwise
  // outrank the scoped timeline binding (1000 > 250) and swallow Alt+Up in the
  // prompt. The red baseline is the pre-fix prompt state (`editorTextFocus` set
  // alongside `acpChatFocused`), where Alt+Up resolved to the User binding.
  it('prompt focus keeps Alt+Up with timeline nav; a real editor keeps the User binding', () => {
    disposables.push(registerAction2(FocusPreviousAcpTimelineItemAction))
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: 'alt+up',
        command: 'findWordAtCursor.previous',
        when: 'editorTextFocus && !findWidgetVisible',
        weight: KeybindingWeight.User,
      }),
    )

    // Fixed prompt state: prompt + chat focused, editorTextFocus false → the
    // User binding's when-clause fails, so the timeline nav binding wins.
    const prompt = new ContextKeyService()
    prompt.createKey<boolean>('acpChatFocused', true)
    prompt.createKey<boolean>('acpPromptInputFocused', true)
    prompt.createKey<boolean>('editorTextFocus', false)
    expect(KeybindingsRegistry.resolveKeybinding('alt+up', prompt)).toBe(
      FocusPreviousAcpTimelineItemAction.ID,
    )

    // Real file editor: editorTextFocus holds, chat not focused → the user's
    // imported binding must keep winning.
    const file = new ContextKeyService()
    file.createKey<boolean>('editorTextFocus', true)
    file.createKey<boolean>('acpChatFocused', false)
    expect(KeybindingsRegistry.resolveKeybinding('alt+up', file)).toBe('findWordAtCursor.previous')

    // Red baseline (pre-fix prompt state): editorTextFocus + acpChatFocused both
    // hold → the User-weight binding steals Alt+Up, exactly the bug being fixed.
    // This asserts the test is sensitive enough to catch the regression.
    const before = new ContextKeyService()
    before.createKey<boolean>('editorTextFocus', true)
    before.createKey<boolean>('acpChatFocused', true)
    expect(KeybindingsRegistry.resolveKeybinding('alt+up', before)).toBe(
      'findWordAtCursor.previous',
    )
  })
})

describe('ActivateAgentConfigEntryAction', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function editorContext(): ContextKeyService {
    const ctx = new ContextKeyService()
    ctx.createKey<string>('activeEditorTypeId', AcpSessionEditorInput.TYPE_ID)
    ctx.createKey<boolean>('editorAreaFocus', true)
    return ctx
  }

  /**
   * Invoke the command the way the key dispatcher does: with the keybinding's
   * `args` — the entry index — and a widget resolved through `widgetForSession`.
   */
  function run(
    lastFocusedWidget: AcpChatWidget | undefined,
    sessionWidget: AcpChatWidget | undefined,
    index: number,
  ): { notify: ReturnType<typeof vi.fn> } {
    const notify = vi.fn()
    const services = new ServiceCollection()
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      lastFocusedWidget,
      register: vi.fn(),
      widgetForSession: () => sessionWidget,
    } as unknown as IAcpChatWidgetService)
    const input = { sessionId: 'sess-1' }
    Object.setPrototypeOf(input, AcpSessionEditorInput.prototype)
    services.set(IEditorService, {
      _serviceBrand: undefined,
      activeEditor: observableValue<unknown>('t.activeEditor', input),
    } as unknown as IEditorService)
    services.set(INotificationService, {
      _serviceBrand: undefined,
      notify,
    } as unknown as INotificationService)
    const inst = new InstantiationService(services)
    inst.invokeFunction((accessor) => {
      CommandsRegistry.getCommand(ActivateAgentConfigEntryAction.ID)!.handler(accessor, index)
    })
    return { notify }
  }

  it('binds Alt+1..Alt+8 to entry indices 0..7 in the session editor', () => {
    disposables.push(registerAction2(ActivateAgentConfigEntryAction))
    const ctx = editorContext()
    expect(KeybindingsRegistry.resolveKeybinding('alt+1', ctx)).toBe(
      ActivateAgentConfigEntryAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('alt+8', ctx)).toBe(
      ActivateAgentConfigEntryAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('alt+9', ctx)).not.toBe(
      ActivateAgentConfigEntryAction.ID,
    )

    const widget = { activateConfigEntry: vi.fn(() => true) } as unknown as AcpChatWidget
    run(undefined, widget, 2)
    // The keybinding's `args` is the entry index, not the digit.
    expect(widget.activateConfigEntry).toHaveBeenCalledWith(2)
  })

  // A chat timeline holding DOM focus still sets `acpChatFocused`, so
  // ACP_NAV_WHEN would match it — the editor-only gate is what keeps Alt+<n> off
  // any chat that is not the editor in front. Only e2e covers the positive
  // polarity; the exclusion has to be asserted here.
  it('does not bind Alt+<n> for a focused chat that is not the active editor', () => {
    disposables.push(registerAction2(ActivateAgentConfigEntryAction))
    const ctx = new ContextKeyService()
    ctx.createKey<boolean>('acpChatFocused', true)
    expect(KeybindingsRegistry.resolveKeybinding('alt+1', ctx)).toBeUndefined()
  })

  it('does not bind Alt+<n> when a session editor is active but focus is outside the editor area', () => {
    disposables.push(registerAction2(ActivateAgentConfigEntryAction))
    const ctx = new ContextKeyService()
    ctx.createKey<string>('activeEditorTypeId', AcpSessionEditorInput.TYPE_ID)
    ctx.createKey<boolean>('editorAreaFocus', false)
    expect(KeybindingsRegistry.resolveKeybinding('alt+1', ctx)).toBeUndefined()
  })

  // The window where the editor is active but its widget has not registered yet
  // (ChatBody registers on mount). The shared resolver would fall back to the
  // last-focused widget — another session's chat — and drive the wrong bar.
  it('ignores the last-focused widget when the active session editor has none yet', () => {
    disposables.push(registerAction2(ActivateAgentConfigEntryAction))
    const otherChat = { activateConfigEntry: vi.fn(() => true) } as unknown as AcpChatWidget
    const { notify } = run(otherChat, undefined, 0)
    expect(otherChat.activateConfigEntry).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalled()
  })
})

describe('Agent prompt suggestion popover actions', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function popupVisibleContext(): ContextKeyService {
    const ctx = new ContextKeyService()
    ctx.createKey<boolean>('acpPromptPopupVisible', true)
    return ctx
  }

  function makeWidget(): {
    widget: AcpChatWidget
    popoverSelectNext: ReturnType<typeof vi.fn>
    popoverSelectPrev: ReturnType<typeof vi.fn>
    popoverAccept: ReturnType<typeof vi.fn>
    popoverHide: ReturnType<typeof vi.fn>
  } {
    const popoverSelectNext = vi.fn()
    const popoverSelectPrev = vi.fn()
    const popoverAccept = vi.fn()
    const popoverHide = vi.fn()
    return {
      popoverSelectNext,
      popoverSelectPrev,
      popoverAccept,
      popoverHide,
      widget: makeFakeAcpChatWidget({
        popoverSelectNext,
        popoverSelectPrev,
        popoverAccept,
        popoverHide,
      }),
    }
  }

  function run(commandId: string, widget: AcpChatWidget): void {
    const services = new ServiceCollection()
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      lastFocusedWidget: widget,
      register: vi.fn(),
    } as unknown as IAcpChatWidgetService)
    const inst = new InstantiationService(services)
    inst.invokeFunction((accessor) => {
      CommandsRegistry.getCommand(commandId)!.handler(accessor)
    })
  }

  it('binds navigation/accept/hide keys only while the popover is visible', () => {
    disposables.push(registerAction2(SelectNextAcpPromptSuggestionAction))
    disposables.push(registerAction2(SelectPreviousAcpPromptSuggestionAction))
    disposables.push(registerAction2(AcceptAcpPromptSuggestionAction))
    disposables.push(registerAction2(HideAcpPromptSuggestionAction))
    const ctx = popupVisibleContext()

    expect(KeybindingsRegistry.resolveKeybinding('down', ctx)).toBe(
      SelectNextAcpPromptSuggestionAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+n', ctx)).toBe(
      SelectNextAcpPromptSuggestionAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+j', ctx)).toBe(
      SelectNextAcpPromptSuggestionAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('up', ctx)).toBe(
      SelectPreviousAcpPromptSuggestionAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+p', ctx)).toBe(
      SelectPreviousAcpPromptSuggestionAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('tab', ctx)).toBe(
      AcceptAcpPromptSuggestionAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('enter', ctx)).toBe(
      AcceptAcpPromptSuggestionAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('escape', ctx)).toBe(
      HideAcpPromptSuggestionAction.ID,
    )
  })

  it('does not bind navigation keys when the popover is hidden', () => {
    disposables.push(registerAction2(SelectNextAcpPromptSuggestionAction))
    disposables.push(registerAction2(HideAcpPromptSuggestionAction))
    const ctx = new ContextKeyService()
    expect(KeybindingsRegistry.resolveKeybinding('down', ctx)).toBeUndefined()
    expect(KeybindingsRegistry.resolveKeybinding('escape', ctx)).toBeUndefined()
  })

  it('routes each command to the focused widget popover handle', () => {
    disposables.push(registerAction2(SelectNextAcpPromptSuggestionAction))
    disposables.push(registerAction2(SelectPreviousAcpPromptSuggestionAction))
    disposables.push(registerAction2(AcceptAcpPromptSuggestionAction))
    disposables.push(registerAction2(HideAcpPromptSuggestionAction))

    const next = makeWidget()
    run(SelectNextAcpPromptSuggestionAction.ID, next.widget)
    expect(next.popoverSelectNext).toHaveBeenCalledTimes(1)

    const prev = makeWidget()
    run(SelectPreviousAcpPromptSuggestionAction.ID, prev.widget)
    expect(prev.popoverSelectPrev).toHaveBeenCalledTimes(1)

    const accept = makeWidget()
    run(AcceptAcpPromptSuggestionAction.ID, accept.widget)
    expect(accept.popoverAccept).toHaveBeenCalledTimes(1)

    const hide = makeWidget()
    run(HideAcpPromptSuggestionAction.ID, hide.widget)
    expect(hide.popoverHide).toHaveBeenCalledTimes(1)
  })
})

describe('NewAgentSessionInCurrentEditorAction', () => {
  function fakeSession(id: string, agentId: string, title: string, cwd?: string): IAcpSession {
    return {
      id,
      agentId,
      title,
      status: observableValue('test.status', 'idle'),
      sessionIdOnAgent: observableValue<string | undefined>('test.sessionIdOnAgent', id),
      ...(cwd !== undefined ? { cwd } : {}),
    } as unknown as IAcpSession
  }

  class PlainEditorInput extends EditorInput {
    get typeId(): string {
      return 'test.plain'
    }
    get resource(): URI | undefined {
      return undefined
    }
    getName(): string {
      return 'plain'
    }
  }

  it('is available from the session message context menu', () => {
    const disposable = registerAction2(NewAgentSessionInCurrentEditorAction)
    try {
      const ctx = new ContextKeyService()
      ctx.createKey<string>('activeEditorType', AcpSessionEditorInput.TYPE_ID)
      expect(
        MenuRegistry.getMenuItems(MenuId.AcpChatContext, ctx).some(
          (item) => 'command' in item && item.command === NewAgentSessionInCurrentEditorAction.ID,
        ),
      ).toBe(true)
    } finally {
      disposable.dispose()
    }
  })

  it('opens a same-agent session as a new tab next to the current one', async () => {
    const groups = new EditorGroupsService()
    const live = new Map<string, IAcpSession>()
    live.set('old-session', fakeSession('old-session', 'codex', 'Old'))

    const instRef: { current?: InstantiationService } = {}
    const createSession = vi.fn(async (agentId?: string) => {
      const session = fakeSession('new-session', agentId ?? 'missing-agent', 'New')
      live.set(session.id, session)
      // Simulate AgentsActiveSessionSyncContribution's active-session autorun:
      // createSession may already have opened the new session before the title
      // action resumes.
      groups.activeGroup.openEditor(
        instRef.current!.createInstance(AcpSessionEditorInput, session.id, session.agentId, 'New'),
      )
      return session
    })
    const defaultAgentId = vi.fn(() => 'claude-code')

    const services = new ServiceCollection()
    services.set(IAcpSessionService, {
      _serviceBrand: undefined,
      createSession,
      getById: (id: string) => live.get(id),
      activeSession: observableValue<IAcpSession | undefined>('test.activeSession', undefined),
    } as unknown as IAcpSessionService)
    services.set(IAcpAgentRegistry, {
      _serviceBrand: undefined,
      defaultAgentId,
    } as unknown as IAcpAgentRegistry)
    services.set(IAcpSessionHistoryService, {
      _serviceBrand: undefined,
      entries: observableValue<readonly AcpSessionHistoryEntry[]>('test.entries', []),
      get: () => undefined,
    } as unknown as IAcpSessionHistoryService)
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      register: vi.fn(),
      focusSessionInput: vi.fn(),
      focusSession: vi.fn(),
    } as unknown as IAcpChatWidgetService)
    services.set(IEditorGroupsService, groups)
    services.set(IDialogService, {
      _serviceBrand: undefined,
      confirm: vi.fn(),
      prompt: vi.fn(),
    } as unknown as IDialogService)
    registerWorkspaceServices(services)
    const inst = new InstantiationService(services)
    instRef.current = inst
    services.set(IInstantiationService, inst)

    const oldInput = inst.createInstance(AcpSessionEditorInput, 'old-session', 'codex', 'Old')
    groups.activeGroup.openEditor(oldInput)

    await inst.invokeFunction((accessor) =>
      new NewAgentSessionInCurrentEditorAction().run(accessor, {
        sessionId: 'old-session',
      }),
    )

    expect(createSession).toHaveBeenCalledWith('codex', undefined)
    expect(defaultAgentId).not.toHaveBeenCalled()
    // The old session stays open; the new one is added right after it and active.
    const editors = groups.activeGroup.editors
    expect(editors).toHaveLength(2)
    expect((editors[0] as AcpSessionEditorInput).sessionId).toBe('old-session')
    expect((editors[1] as AcpSessionEditorInput).sessionId).toBe('new-session')
    const active = groups.activeGroup.activeEditor
    expect(active).toBeInstanceOf(AcpSessionEditorInput)
    expect((active as AcpSessionEditorInput).sessionId).toBe('new-session')
  })

  // A locked session-editor group must still accept the new session directly as a
  // new tab (the lock only guards lock-aware routing, not explicit group opens),
  // and stay the active group. createSession's side effect — the activeSession
  // autorun in AgentsActiveSessionSyncContribution — opens the new session via
  // EditorService.openEditor, whose lock-aware routing hands a brand-new editor to
  // a *different* unlocked group and activates it; without our cleanup +
  // re-activation the real editor would end up split across groups with focus in
  // the wrong one.
  it('creates the new session directly in the locked group and keeps it active', async () => {
    const groups = new EditorGroupsService()
    const editorService = new EditorService(groups)
    const live = new Map<string, IAcpSession>()
    live.set('old-session', fakeSession('old-session', 'codex', 'Old'))

    const instRef: { current?: InstantiationService } = {}
    const createSession = vi.fn(async (agentId?: string) => {
      const session = fakeSession('new-session', agentId ?? 'missing-agent', 'New')
      live.set(session.id, session)
      // Mirror AgentsActiveSessionSyncContribution's active-session autorun: it
      // opens the freshly created session through the shared EditorService, which
      // routes a new editor away from the locked active group into an unlocked one.
      editorService.openEditor(
        instRef.current!.createInstance(AcpSessionEditorInput, session.id, session.agentId, 'New'),
      )
      return session
    })
    const defaultAgentId = vi.fn(() => 'claude-code')

    const services = new ServiceCollection()
    services.set(IAcpSessionService, {
      _serviceBrand: undefined,
      createSession,
      getById: (id: string) => live.get(id),
      activeSession: observableValue<IAcpSession | undefined>('test.activeSession', undefined),
    } as unknown as IAcpSessionService)
    services.set(IAcpAgentRegistry, {
      _serviceBrand: undefined,
      defaultAgentId,
    } as unknown as IAcpAgentRegistry)
    services.set(IAcpSessionHistoryService, {
      _serviceBrand: undefined,
      entries: observableValue<readonly AcpSessionHistoryEntry[]>('test.entries', []),
      get: () => undefined,
    } as unknown as IAcpSessionHistoryService)
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      register: vi.fn(),
      focusSessionInput: vi.fn(),
      focusSession: vi.fn(),
    } as unknown as IAcpChatWidgetService)
    services.set(IEditorGroupsService, groups)
    services.set(IEditorService, editorService)
    services.set(IDialogService, {
      _serviceBrand: undefined,
      confirm: vi.fn(),
      prompt: vi.fn(),
    } as unknown as IDialogService)
    registerWorkspaceServices(services)
    const inst = new InstantiationService(services)
    instRef.current = inst
    services.set(IInstantiationService, inst)

    // A second, unlocked group exists (with its own unrelated editor, so it
    // survives duplicate-cleanup) — lock-aware routing lands there.
    const otherGroup = groups.addGroup(groups.activeGroup, GroupDirection.Right)
    live.set('other-session', fakeSession('other-session', 'codex', 'Other'))
    otherGroup.openEditor(
      inst.createInstance(AcpSessionEditorInput, 'other-session', 'codex', 'Other'),
    )
    const lockedGroup = groups.groups[0]!
    groups.activateGroup(lockedGroup)

    const oldInput = inst.createInstance(AcpSessionEditorInput, 'old-session', 'codex', 'Old')
    lockedGroup.openEditor(oldInput)
    lockedGroup.lock(true)

    await inst.invokeFunction((accessor) =>
      new NewAgentSessionInCurrentEditorAction().run(accessor, {
        groupId: lockedGroup.id,
        sessionId: 'old-session',
      }),
    )

    // The locked group keeps the old session and gains the new one as a new tab…
    const lockedEditors = lockedGroup.editors.filter(
      (e): e is AcpSessionEditorInput => e instanceof AcpSessionEditorInput,
    )
    expect(lockedEditors.map((e) => e.sessionId)).toEqual(['old-session', 'new-session'])
    // …the new session is active…
    const activeInLocked = lockedGroup.activeEditor
    expect(activeInLocked).toBeInstanceOf(AcpSessionEditorInput)
    expect((activeInLocked as AcpSessionEditorInput).sessionId).toBe('new-session')
    // …the group is still locked (creating a session must not unlock it)…
    expect(lockedGroup.isLocked).toBe(true)
    // …and the locked group must still be the active one (focus didn't run away).
    expect(groups.activeGroup).toBe(lockedGroup)
    // No stray duplicate of the new session left in any other group.
    const duplicates = groups.groups
      .filter((g) => g !== lockedGroup)
      .flatMap((g) => g.editors)
      .filter((e) => e instanceof AcpSessionEditorInput && e.sessionId === 'new-session')
    expect(duplicates).toHaveLength(0)
  })

  function buildCwdCase(opts: {
    live?: IAcpSession
    activeSession?: IAcpSession
    historyGet?: (id: string) => AcpSessionHistoryEntry | undefined
  }) {
    const groups = new EditorGroupsService()
    const live = new Map<string, IAcpSession>()
    if (opts.live !== undefined) live.set(opts.live.id, opts.live)

    const createSession = vi.fn(async (agentId?: string) => {
      const session = fakeSession('new-session', agentId ?? 'missing-agent', 'New')
      live.set(session.id, session)
      return session
    })
    const defaultAgentId = vi.fn(() => 'claude-code')

    const services = new ServiceCollection()
    services.set(IAcpSessionService, {
      _serviceBrand: undefined,
      createSession,
      getById: (id: string) => live.get(id),
      activeSession: observableValue<IAcpSession | undefined>(
        'test.activeSession',
        opts.activeSession,
      ),
    } as unknown as IAcpSessionService)
    services.set(IAcpAgentRegistry, {
      _serviceBrand: undefined,
      defaultAgentId,
    } as unknown as IAcpAgentRegistry)
    services.set(IAcpSessionHistoryService, {
      _serviceBrand: undefined,
      entries: observableValue<readonly AcpSessionHistoryEntry[]>('test.entries', []),
      get: opts.historyGet ?? (() => undefined),
    } as unknown as IAcpSessionHistoryService)
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      register: vi.fn(),
      focusSessionInput: vi.fn(),
      focusSession: vi.fn(),
    } as unknown as IAcpChatWidgetService)
    services.set(IEditorGroupsService, groups)
    services.set(IDialogService, {
      _serviceBrand: undefined,
      confirm: vi.fn(),
      prompt: vi.fn(),
    } as unknown as IDialogService)
    registerWorkspaceServices(services)
    const inst = new InstantiationService(services)
    services.set(IInstantiationService, inst)
    return { groups, inst, createSession, defaultAgentId }
  }

  it('inherits the current session cwd from the live session', async () => {
    const b = buildCwdCase({
      live: fakeSession('old-session', 'codex', 'Old', 'X:/workspace/packages/app'),
    })
    b.groups.activeGroup.openEditor(
      b.inst.createInstance(AcpSessionEditorInput, 'old-session', 'codex', 'Old'),
    )

    await b.inst.invokeFunction((accessor) =>
      new NewAgentSessionInCurrentEditorAction().run(accessor, { sessionId: 'old-session' }),
    )

    expect(b.createSession).toHaveBeenCalledWith('codex', { cwd: 'X:/workspace/packages/app' })
  })

  it('falls back to the history row cwd when the session editor is not live', async () => {
    const entry = {
      id: 'durable-sess',
      sessionIdOnAgent: 'durable-sess',
      agentId: 'codex',
      title: 'Old',
      cwd: 'X:/workspace/packages/app',
      createdAt: 0,
      lastUsedAt: 0,
    } as unknown as AcpSessionHistoryEntry
    const b = buildCwdCase({ historyGet: (id) => (id === 'durable-sess' ? entry : undefined) })
    b.groups.activeGroup.openEditor(
      b.inst.createInstance(AcpSessionEditorInput, 'durable-sess', 'codex', 'Old'),
    )

    await b.inst.invokeFunction((accessor) =>
      new NewAgentSessionInCurrentEditorAction().run(accessor, { sessionId: 'durable-sess' }),
    )

    expect(b.createSession).toHaveBeenCalledWith('codex', { cwd: 'X:/workspace/packages/app' })
  })

  it('does not inherit the active session cwd when the current editor is not a session', async () => {
    const b = buildCwdCase({
      activeSession: fakeSession('active-sess', 'codex', 'Active', 'X:/workspace/active'),
    })
    b.groups.activeGroup.openEditor(new PlainEditorInput())

    await b.inst.invokeFunction((accessor) =>
      new NewAgentSessionInCurrentEditorAction().run(accessor),
    )

    expect(b.createSession).toHaveBeenCalledWith('codex', undefined)
    expect(b.defaultAgentId).not.toHaveBeenCalled()
  })
})

describe('NewAgentSessionInFolderAction', () => {
  function fakeSession(id: string): IAcpSession {
    return { id, agentId: 'claude-code', title: 'New' } as unknown as IAcpSession
  }

  function build() {
    const createSession = vi.fn(async () => fakeSession('sess-1'))
    const defaultAgentId = vi.fn(() => 'claude-code')
    const openEditor = vi.fn()

    const services = new ServiceCollection()
    services.set(IAcpSessionService, {
      _serviceBrand: undefined,
      createSession,
      getById: () => undefined,
      activeSession: observableValue<IAcpSession | undefined>('test.activeSession', undefined),
    } as unknown as IAcpSessionService)
    services.set(IAcpSessionHistoryService, {
      _serviceBrand: undefined,
      entries: observableValue<readonly AcpSessionHistoryEntry[]>('test.entries', []),
      list: () => [],
      get: () => undefined,
    } as unknown as IAcpSessionHistoryService)
    services.set(IAcpAgentRegistry, {
      _serviceBrand: undefined,
      defaultAgentId,
    } as unknown as IAcpAgentRegistry)
    services.set(IEditorService, {
      _serviceBrand: undefined,
      openEditor,
    } as unknown as IEditorService)
    // AcpSessionEditorInput construction pulls the chat widget service.
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      register: vi.fn(),
    } as unknown as IAcpChatWidgetService)
    registerWorkspaceServices(services)
    const inst = new InstantiationService(services)
    services.set(IInstantiationService, inst)
    return { inst, createSession, defaultAgentId, openEditor }
  }

  it('roots the session at the folder arg and opens it as an editor tab', async () => {
    const b = build()
    const folder = URI.file('/ws/src')
    await b.inst.invokeFunction((accessor) =>
      new NewAgentSessionInFolderAction().run(accessor, { parent: folder }),
    )
    expect(b.createSession).toHaveBeenCalledWith('claude-code', { cwd: folder.fsPath })
    expect(b.openEditor).toHaveBeenCalledTimes(1)
  })

  it('resolves a file target to its parent folder when no parent arg is present', async () => {
    const b = build()
    const file = URI.file('/ws/src/main.ts')
    await b.inst.invokeFunction((accessor) =>
      new NewAgentSessionInFolderAction().run(accessor, {
        target: file,
        resource: file,
        isDirectory: false,
      }),
    )
    const parent = URI.joinPath(file, '..')
    expect(b.createSession).toHaveBeenCalledWith('claude-code', { cwd: parent.fsPath })
  })
})

describe('NewAgentSessionWithScopeAction', () => {
  function fakeSession(id: string): IAcpSession {
    return { id, agentId: 'claude-code', title: 'New' } as unknown as IAcpSession
  }

  function scope(over: Partial<SubProjectScope>): SubProjectScope {
    return { cwd: '/ws', source: 'workspace', label: 'Workspace', ...over }
  }

  function build(opts: {
    scopes: SubProjectScope[]
    picked: IQuickPickItem | undefined
    lastCwd?: { cwd: string; authority?: string } | undefined
    workspaceFolder?: URI
  }) {
    const createSession = vi.fn(async () => fakeSession('sess-1'))
    const defaultAgentId = vi.fn(() => 'claude-code')
    const getScopes = vi.fn(async () => opts.scopes)
    const pick = vi.fn(async () => opts.picked)
    const showOpenDialog = vi.fn(
      async (_options: { defaultUri?: URI }): Promise<URI[] | undefined> => undefined,
    )
    const openEditor = vi.fn()
    const notify = vi.fn()

    const services = new ServiceCollection()
    services.set(IAcpSessionService, {
      _serviceBrand: undefined,
      createSession,
      getById: () => undefined,
      activeSession: observableValue<IAcpSession | undefined>('test.activeSession', undefined),
    } as unknown as IAcpSessionService)
    services.set(IAcpSessionHistoryService, {
      _serviceBrand: undefined,
      entries: observableValue<readonly AcpSessionHistoryEntry[]>('test.entries', []),
      list: () => [],
      get: () => undefined,
    } as unknown as IAcpSessionHistoryService)
    services.set(IAcpAgentRegistry, {
      _serviceBrand: undefined,
      defaultAgentId,
    } as unknown as IAcpAgentRegistry)
    services.set(ISubProjectService, {
      _serviceBrand: undefined,
      getScopes,
    } as unknown as ISubProjectService)
    services.set(IQuickInputService, {
      _serviceBrand: undefined,
      pick,
    } as unknown as IQuickInputService)
    services.set(IFileDialogService, {
      _serviceBrand: undefined,
      showOpenDialog,
    } as unknown as IFileDialogService)
    services.set(IEditorService, {
      _serviceBrand: undefined,
      openEditor,
    } as unknown as IEditorService)
    services.set(INotificationService, {
      _serviceBrand: undefined,
      notify,
    } as unknown as INotificationService)
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      register: vi.fn(),
    } as unknown as IAcpChatWidgetService)
    services.set(IAcpLastSessionCwdService, {
      _serviceBrand: undefined,
      lastCwd: () => opts.lastCwd,
    } as unknown as IAcpLastSessionCwdService)
    if (opts.workspaceFolder !== undefined) {
      services.set(IWorkspaceService, {
        _serviceBrand: undefined,
        current: { folder: opts.workspaceFolder, name: 'ws' },
        onDidChangeWorkspace: Event.None,
      } as unknown as IWorkspaceService)
      services.set(IUriIdentityService, new UriIdentityService('linux'))
    } else {
      registerWorkspaceServices(services)
    }
    const inst = new InstantiationService(services)
    services.set(IInstantiationService, inst)
    return { inst, createSession, getScopes, pick, showOpenDialog, openEditor, notify }
  }

  it('creates the session in the chosen configured scope (cwd + authority)', async () => {
    const configured = scope({
      cwd: '/ws/sub',
      authority: 'ssh-remote+192.0.2.10',
      source: 'configured',
      label: 'sub',
    })
    const b = build({
      scopes: [scope({ cwd: '/ws' }), configured],
      picked: { id: configured.cwd, label: configured.label },
    })
    await b.inst.invokeFunction((accessor) => new NewAgentSessionWithScopeAction().run(accessor))
    expect(b.createSession).toHaveBeenCalledWith('claude-code', {
      cwd: configured.cwd,
      authority: configured.authority,
    })
  })

  it('opens the OS folder dialog for the trailing Choose Folder entry', async () => {
    const pickedFolder = URI.file('/ws/other')
    const b = build({
      scopes: [scope({ cwd: '/ws' })],
      picked: { id: '__chooseFolder__', label: 'Choose Folder…' },
    })
    b.showOpenDialog.mockResolvedValueOnce([pickedFolder])
    await b.inst.invokeFunction((accessor) => new NewAgentSessionWithScopeAction().run(accessor))
    expect(b.showOpenDialog).toHaveBeenCalledTimes(1)
    expect(b.createSession).toHaveBeenCalledWith('claude-code', { cwd: pickedFolder.fsPath })
  })

  it('seeds the folder dialog defaultUri from the remembered local cwd', async () => {
    const b = build({
      scopes: [scope({ cwd: '/ws' })],
      picked: { id: '__chooseFolder__', label: 'Choose Folder…' },
      lastCwd: { cwd: '/ws/src' },
      workspaceFolder: URI.file('/ws'),
    })
    await b.inst.invokeFunction((accessor) => new NewAgentSessionWithScopeAction().run(accessor))
    expect(b.showOpenDialog).toHaveBeenCalledTimes(1)
    const options = b.showOpenDialog.mock.calls[0]![0]
    expect(options.defaultUri?.toString()).toBe(URI.file('/ws/src').toString())
  })

  it('seeds the folder dialog defaultUri from a remote memory on the same host', async () => {
    const remoteFolder = URI.from({
      scheme: REMOTE_SCHEME,
      authority: 'ssh-remote+box',
      path: '/ws',
    })
    const b = build({
      scopes: [scope({ cwd: '/ws' })],
      picked: { id: '__chooseFolder__', label: 'Choose Folder…' },
      lastCwd: { cwd: '/ws/src', authority: 'ssh-remote+box' },
      workspaceFolder: remoteFolder,
    })
    await b.inst.invokeFunction((accessor) => new NewAgentSessionWithScopeAction().run(accessor))
    expect(b.showOpenDialog).toHaveBeenCalledTimes(1)
    const options = b.showOpenDialog.mock.calls[0]![0]
    expect(options.defaultUri?.scheme).toBe(REMOTE_SCHEME)
    expect(options.defaultUri?.authority).toBe('ssh-remote+box')
    expect(options.defaultUri?.path).toBe('/ws/src')
  })

  it('omits defaultUri when the remembered cwd is foreign to the window', async () => {
    const b = build({
      scopes: [scope({ cwd: '/ws' })],
      picked: { id: '__chooseFolder__', label: 'Choose Folder…' },
      lastCwd: { cwd: '/elsewhere/src' },
      workspaceFolder: URI.file('/ws'),
    })
    await b.inst.invokeFunction((accessor) => new NewAgentSessionWithScopeAction().run(accessor))
    expect(b.showOpenDialog).toHaveBeenCalledTimes(1)
    const options = b.showOpenDialog.mock.calls[0]![0]
    expect(options.defaultUri).toBeUndefined()
  })

  it('creates nothing when the picker is dismissed', async () => {
    const b = build({ scopes: [scope({ cwd: '/ws' })], picked: undefined })
    await b.inst.invokeFunction((accessor) => new NewAgentSessionWithScopeAction().run(accessor))
    expect(b.createSession).not.toHaveBeenCalled()
  })

  it('notifies an error when scope detection fails', async () => {
    const b = build({ scopes: [], picked: undefined })
    b.getScopes.mockRejectedValueOnce(new Error('io probe failed'))
    await b.inst.invokeFunction((accessor) => new NewAgentSessionWithScopeAction().run(accessor))
    expect(b.notify).toHaveBeenCalledTimes(1)
    expect(b.createSession).not.toHaveBeenCalled()
  })

  it('creates nothing and shows no error when the folder dialog is cancelled', async () => {
    const b = build({
      scopes: [scope({ cwd: '/ws' })],
      picked: { id: '__chooseFolder__', label: 'Choose Folder…' },
    })
    await b.inst.invokeFunction((accessor) => new NewAgentSessionWithScopeAction().run(accessor))
    expect(b.showOpenDialog).toHaveBeenCalledTimes(1)
    expect(b.createSession).not.toHaveBeenCalled()
    expect(b.notify).not.toHaveBeenCalled()
  })
})

describe('ResumeAgentSessionAction', () => {
  function makeEntry(over: Partial<AcpSessionHistoryEntry>): AcpSessionHistoryEntry {
    return {
      id: 'sess-1',
      agentId: 'fake',
      sessionIdOnAgent: 'sess-1',
      title: 'Session 1',
      createdAt: 0,
      lastUsedAt: 0,
      ...over,
    }
  }

  function build(opts: {
    entries: readonly AcpSessionHistoryEntry[]
    pickIndex: number
    currentCwd: string | undefined
    platform?: 'win32' | 'linux'
    authority?: string
    resumeImpl?: (id: string) => Promise<IAcpSession>
  }) {
    const resumeSession = vi.fn(
      opts.resumeImpl ??
        ((_id: string) => Promise.resolve({ id: 'live', agentId: 'fake' } as IAcpSession)),
    )
    const setActive = vi.fn()
    const notify = vi.fn()
    const pickedItems: IQuickPickItem[][] = []

    const sessions = {
      _serviceBrand: undefined,
      resumeSession,
      setActive,
      getById: () => undefined,
    } as unknown as IAcpSessionService
    const history = {
      _serviceBrand: undefined,
      entries: observableValue<readonly AcpSessionHistoryEntry[]>('test.entries', opts.entries),
      list: () => opts.entries,
      get: (id: string) => opts.entries.find((e) => e.id === id),
    } as unknown as IAcpSessionHistoryService
    const quickInput = {
      _serviceBrand: undefined,
      pick: (items: IQuickPickItem[]) => {
        pickedItems.push(items)
        return Promise.resolve(items[opts.pickIndex])
      },
    } as unknown as IQuickInputService
    const groups = new EditorGroupsService()
    const notification = {
      _serviceBrand: undefined,
      notify,
    } as unknown as INotificationService
    const workspace = {
      _serviceBrand: undefined,
      current: opts.currentCwd
        ? {
            folder: opts.authority
              ? { scheme: 'remote-ssh', authority: opts.authority, fsPath: opts.currentCwd }
              : { fsPath: opts.currentCwd },
            name: 'ws',
          }
        : null,
      onDidChangeWorkspace: Event.None,
    } as unknown as IWorkspaceService
    const host = { _serviceBrand: undefined, platform: opts.platform ?? 'linux' } as IHostService

    const services = new ServiceCollection()
    services.set(IAcpSessionService, sessions)
    services.set(IAcpSessionHistoryService, history)
    services.set(IQuickInputService, quickInput)
    services.set(IEditorGroupsService, groups)
    services.set(INotificationService, notification)
    services.set(IWorkspaceService, workspace)
    services.set(IHostService, host)
    services.set(IUriIdentityService, new UriIdentityService(opts.platform ?? 'linux'))
    // AcpSessionEditorInput.createInstance pulls these at construction.
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      register: vi.fn(),
    } as unknown as IAcpChatWidgetService)
    const inst = new InstantiationService(services)
    return { inst, resumeSession, setActive, groups, notify, pickedItems }
  }

  /** Session tabs across every group — the reveal contract is about all of them. */
  function sessionTabs(groups: EditorGroupsService): AcpSessionEditorInput[] {
    return groups.groups
      .flatMap((group) => group.editors)
      .filter((editor): editor is AcpSessionEditorInput => editor instanceof AcpSessionEditorInput)
  }

  async function run(b: { inst: InstantiationService }): Promise<void> {
    await b.inst.invokeFunction((accessor) => new ResumeAgentSessionAction().run(accessor))
  }

  it('opens a read-only preview tab (no live resume) for a session from another worktree', async () => {
    const entry = makeEntry({ cwd: '/repo/wt1', title: 'From worktree' })
    const b = build({ entries: [entry], pickIndex: 0, currentCwd: '/repo/main' })
    await run(b)
    // Must NOT spawn a live resume against the foreign worktree (split-brain).
    expect(b.resumeSession).not.toHaveBeenCalled()
    // Instead it opens the session as a (read-only) editor tab.
    const tabs = sessionTabs(b.groups)
    expect(tabs).toHaveLength(1)
    expect(tabs[0]!.sessionId).toBe('sess-1')
  })

  it('resumes a session whose cwd matches the open workspace', async () => {
    const entry = makeEntry({ cwd: '/repo/main', title: 'Local' })
    const b = build({ entries: [entry], pickIndex: 0, currentCwd: '/repo/main' })
    await run(b)
    expect(b.resumeSession).toHaveBeenCalledWith('sess-1')
  })

  it('resumes a session rooted in a subdirectory of the open workspace live (not a preview)', async () => {
    const entry = makeEntry({ cwd: '/repo/main/sub', title: 'Sub-project' })
    const b = build({ entries: [entry], pickIndex: 0, currentCwd: '/repo/main' })
    await run(b)
    // A same-workspace subdirectory is not foreign, so it resumes live.
    expect(b.resumeSession).toHaveBeenCalledWith('sess-1')
    // …and opens the *live* session (id 'live'), never the read-only preview of
    // the history row (which would carry the history id 'sess-1').
    const tabs = sessionTabs(b.groups)
    expect(tabs).toHaveLength(1)
    expect(tabs[0]!.sessionId).toBe('live')
  })

  it('shows the session directory name in the picker description', async () => {
    const entries = [
      makeEntry({
        id: 'sess-win',
        sessionIdOnAgent: 'sess-win',
        cwd: 'D:\\workspace\\universe-editor\\',
        title: 'Windows path',
      }),
      makeEntry({
        id: 'sess-posix',
        sessionIdOnAgent: 'sess-posix',
        cwd: '/repo/worktree',
        title: 'POSIX path',
      }),
      makeEntry({
        id: 'sess-legacy',
        sessionIdOnAgent: 'sess-legacy',
        title: 'Legacy path',
      }),
    ]
    const b = build({ entries, pickIndex: 0, currentCwd: undefined })
    await run(b)
    expect(b.pickedItems[0]?.map((item) => item.description)).toEqual([
      'universe-editor',
      'worktree',
      undefined,
    ])
  })

  it('resumes a cwd-less (legacy/global) session as belonging here', async () => {
    const entry = makeEntry({ title: 'Legacy' })
    const b = build({ entries: [entry], pickIndex: 0, currentCwd: '/repo/main' })
    await run(b)
    expect(b.resumeSession).toHaveBeenCalledWith('sess-1')
  })

  it('does not silently swallow a foreign worktree pick (regression: nothing happened)', async () => {
    // Repro of the original bug: picking a foreign-worktree session called
    // resumeSession, which throws AcpForeignWorktreeError; the empty catch meant
    // nothing opened and no notification fired — the user saw no response.
    const entry = makeEntry({ cwd: '/repo/wt1' })
    const b = build({
      entries: [entry],
      pickIndex: 0,
      currentCwd: '/repo/main',
      resumeImpl: (id) =>
        Promise.reject(new AcpForeignWorktreeError(id, '/repo/wt1', '/repo/main')),
    })
    await run(b)
    // The fix routes around resumeSession entirely, so the user gets a tab.
    expect(sessionTabs(b.groups)).toHaveLength(1)
  })

  it('opens a read-only preview (no live resume) for a same-path session on another host', async () => {
    const entry = makeEntry({ cwd: '/repo/main', authority: 'ssh-remote+192.0.2.10' })
    const b = build({
      entries: [entry],
      pickIndex: 0,
      currentCwd: '/repo/main',
      authority: 'ssh-remote+192.0.2.20',
    })
    await run(b)
    // Same cwd, but the entry ran on a different remote host — still split-brain.
    expect(b.resumeSession).not.toHaveBeenCalled()
    const tabs = sessionTabs(b.groups)
    expect(tabs).toHaveLength(1)
    expect(tabs[0]!.sessionId).toBe('sess-1')
  })

  // Regression: IEditorService.openEditor dedupes only inside the active group,
  // so opening the preview of a session whose tab already lives in another group
  // duplicated it there. The resume path must find it across every group first.
  it('focuses a preview tab sitting in another group instead of duplicating it', async () => {
    const entry = makeEntry({ cwd: '/repo/wt1', title: 'From worktree' })
    const b = build({ entries: [entry], pickIndex: 0, currentCwd: '/repo/main' })
    const left = b.groups.activeGroup
    const right = b.groups.addGroup(left, GroupDirection.Right)
    // The left group keeps a tab of its own: an *empty* group is auto-closed on
    // the next model change, which `await run` would reach.
    left.openEditor(b.inst.createInstance(AcpSessionEditorInput, 'other', 'fake', undefined))
    const existing = b.inst.createInstance(AcpSessionEditorInput, 'sess-1', 'fake', 'From worktree')
    right.openEditor(existing, { activate: false, pinned: true })
    b.groups.activateGroup(left)

    await run(b)

    expect(b.groups.count).toBe(2)
    expect(left.editors).toHaveLength(1)
    expect(right.editors).toHaveLength(1)
    expect(sessionTabs(b.groups)).toHaveLength(2)
    expect(b.groups.activeGroup).toBe(right)
    expect(right.activeEditor).toBe(existing)
  })

  it('focuses a resumed session tab sitting in another group instead of duplicating it', async () => {
    const entry = makeEntry({ cwd: '/repo/main', title: 'Local' })
    const b = build({ entries: [entry], pickIndex: 0, currentCwd: '/repo/main' })
    const left = b.groups.activeGroup
    const right = b.groups.addGroup(left, GroupDirection.Right)
    left.openEditor(b.inst.createInstance(AcpSessionEditorInput, 'other', 'fake', undefined))
    // resumeSession (the stub) yields the live session id 'live'.
    const existing = b.inst.createInstance(AcpSessionEditorInput, 'live', 'fake', undefined)
    right.openEditor(existing, { activate: false, pinned: true })
    b.groups.activateGroup(left)

    await run(b)

    expect(b.resumeSession).toHaveBeenCalledWith('sess-1')
    expect(right.editors).toHaveLength(1)
    expect(sessionTabs(b.groups)).toHaveLength(2)
    expect(b.groups.activeGroup).toBe(right)
    expect(right.activeEditor).toBe(existing)
  })
})

describe('RevealAgentSessionInOSAction', () => {
  it('is available from the chat-area context menu', () => {
    const disposable = registerAction2(RevealAgentSessionInOSAction)
    try {
      const items = MenuRegistry.getMenuItems(MenuId.AcpChatContext, new ContextKeyService())
      expect(
        items.some((item) => 'command' in item && item.command === RevealAgentSessionInOSAction.ID),
      ).toBe(true)
    } finally {
      disposable.dispose()
    }
  })

  function makeEntry(over: Partial<AcpSessionHistoryEntry>): AcpSessionHistoryEntry {
    return {
      id: 'sess-1',
      agentId: 'fake',
      sessionIdOnAgent: 'sess-1',
      title: 'Session 1',
      createdAt: 0,
      lastUsedAt: 0,
      ...over,
    }
  }

  function build(opts: {
    entries: readonly AcpSessionHistoryEntry[]
    activeSessionId?: string
    liveSessions?: Record<string, IAcpSession>
    platform?: string
    remoteAuthority?: string
  }) {
    const showItemInFolder = vi.fn(async () => {})
    const notify = vi.fn()
    const resolveTranscriptPath = vi.fn(
      async (_sessionId: string): Promise<string | undefined> => undefined,
    )
    const activeSession = opts.activeSessionId
      ? ({ id: opts.activeSessionId } as IAcpSession)
      : undefined

    const sessions = {
      _serviceBrand: undefined,
      activeSession: observableValue<IAcpSession | undefined>('test.active', activeSession),
      getById: (id: string) => opts.liveSessions?.[id],
      resolveTranscriptPath,
    } as unknown as IAcpSessionService
    const history = {
      _serviceBrand: undefined,
      get: (id: string) => opts.entries.find((e) => e.id === id),
    } as unknown as IAcpSessionHistoryService
    const editor = {
      _serviceBrand: undefined,
      activeEditor: observableValue<unknown>('test.activeEditor', undefined),
    } as unknown as IEditorService
    const host = {
      _serviceBrand: undefined,
      platform: opts.platform ?? 'linux',
      showItemInFolder,
    } as unknown as IHostService
    const notification = { _serviceBrand: undefined, notify } as unknown as INotificationService
    const workspace = opts.remoteAuthority
      ? ({
          _serviceBrand: undefined,
          current: {
            folder: { scheme: 'remote-ssh', authority: opts.remoteAuthority, path: '/root' },
          },
          onDidChangeWorkspace: Event.None,
        } as unknown as IWorkspaceService)
      : ({
          _serviceBrand: undefined,
          current: null,
          onDidChangeWorkspace: Event.None,
        } as unknown as IWorkspaceService)
    const logger = {
      _serviceBrand: undefined,
      createLogger: () => new NullLogger(),
    } as unknown as ILoggerService

    const services = new ServiceCollection()
    services.set(IAcpSessionService, sessions)
    services.set(IAcpSessionHistoryService, history)
    services.set(IEditorService, editor)
    services.set(IHostService, host)
    services.set(INotificationService, notification)
    services.set(IWorkspaceService, workspace)
    services.set(ILoggerService, logger)
    const inst = new InstantiationService(services)
    return { inst, showItemInFolder, notify, resolveTranscriptPath }
  }

  async function run(
    b: { inst: InstantiationService },
    arg?: { sessionId?: unknown; resource?: unknown },
  ): Promise<void> {
    await b.inst.invokeFunction((accessor) => new RevealAgentSessionInOSAction().run(accessor, arg))
  }

  it('reveals the transcript file for the given session id', async () => {
    const entry = makeEntry({ transcriptPath: '/home/u/.claude/projects/x/sess-1.jsonl' })
    const b = build({ entries: [entry] })
    await run(b, { sessionId: 'sess-1' })
    expect(b.showItemInFolder).toHaveBeenCalledWith('/home/u/.claude/projects/x/sess-1.jsonl')
    expect(b.notify).not.toHaveBeenCalled()
    // Cached path wins — no on-demand session/list roundtrip.
    expect(b.resolveTranscriptPath).not.toHaveBeenCalled()
  })

  it('falls back to the active session when no arg is given', async () => {
    const entry = makeEntry({ transcriptPath: '/p/sess-1.jsonl' })
    const b = build({ entries: [entry], activeSessionId: 'sess-1' })
    await run(b)
    expect(b.showItemInFolder).toHaveBeenCalledWith('/p/sess-1.jsonl')
  })

  it('resolves the transcript path on demand when the history row has none', async () => {
    // A session created during this window's lifetime has no transcriptPath on
    // its history row until the next hydrate sweep — reveal must still work.
    const entry = makeEntry({})
    const b = build({ entries: [entry] })
    b.resolveTranscriptPath.mockResolvedValue('/live/sess-1.jsonl')
    await run(b, { sessionId: 'sess-1' })
    expect(b.resolveTranscriptPath).toHaveBeenCalledWith('sess-1')
    expect(b.showItemInFolder).toHaveBeenCalledWith('/live/sess-1.jsonl')
    expect(b.notify).not.toHaveBeenCalled()
  })

  it('notifies (and does not reveal) when no transcript path resolves', async () => {
    const entry = makeEntry({})
    const b = build({ entries: [entry] })
    await run(b, { sessionId: 'sess-1' })
    expect(b.resolveTranscriptPath).toHaveBeenCalledWith('sess-1')
    expect(b.showItemInFolder).not.toHaveBeenCalled()
    expect(b.notify).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when no session id resolves', async () => {
    const b = build({ entries: [] })
    await run(b)
    expect(b.showItemInFolder).not.toHaveBeenCalled()
    expect(b.notify).not.toHaveBeenCalled()
  })

  it('resolves the session from the editor tab context menu resource arg', async () => {
    const entry = makeEntry({ transcriptPath: '/p/sess-1.jsonl' })
    const b = build({ entries: [entry] })
    await run(b, { resource: { scheme: 'universe', path: '/acp/session/sess-1' } })
    expect(b.showItemInFolder).toHaveBeenCalledWith('/p/sess-1.jsonl')
  })

  it('maps a live session local id to the durable agent id before hitting history', async () => {
    // A session created in this window keeps its local uuid on the editor input,
    // but the history row is keyed by sessionIdOnAgent — reveal must map first.
    const entry = makeEntry({
      id: 'agent-1',
      sessionIdOnAgent: 'agent-1',
      transcriptPath: '/p/agent-1.jsonl',
    })
    const live = {
      id: 'local-1',
      sessionIdOnAgent: observableValue<string | undefined>('test.onAgent', 'agent-1'),
    } as unknown as IAcpSession
    const b = build({ entries: [entry], liveSessions: { 'local-1': live } })
    await run(b, { resource: { scheme: 'universe', path: '/acp/session/local-1' } })
    expect(b.showItemInFolder).toHaveBeenCalledWith('/p/agent-1.jsonl')
  })

  it('maps a WSL remote transcript to its UNC path on a Windows client', async () => {
    const entry = makeEntry({
      authority: 'wsl+ubuntu-24.04',
      transcriptPath: '/home/u/sess-1.jsonl',
    })
    const b = build({ entries: [entry], platform: 'win32' })
    await run(b, { sessionId: 'sess-1' })
    expect(b.showItemInFolder).toHaveBeenCalledWith('\\\\wsl$\\ubuntu-24.04\\home\\u\\sess-1.jsonl')
    expect(b.notify).not.toHaveBeenCalled()
  })

  it('notifies (and does not reveal) a WSL remote on a non-Windows client', async () => {
    const entry = makeEntry({
      authority: 'wsl+ubuntu-24.04',
      transcriptPath: '/home/u/sess-1.jsonl',
    })
    const b = build({ entries: [entry], platform: 'linux' })
    await run(b, { sessionId: 'sess-1' })
    expect(b.showItemInFolder).not.toHaveBeenCalled()
    expect(b.notify).toHaveBeenCalledTimes(1)
  })

  it('notifies (and does not reveal) a non-WSL remote session', async () => {
    const entry = makeEntry({
      authority: 'ssh-remote+host',
      transcriptPath: '/home/u/sess-1.jsonl',
    })
    const b = build({ entries: [entry], platform: 'win32' })
    await run(b, { sessionId: 'sess-1' })
    expect(b.showItemInFolder).not.toHaveBeenCalled()
    expect(b.notify).toHaveBeenCalledTimes(1)
  })

  it('falls back to the workspace authority when the history row has none', async () => {
    const entry = makeEntry({ transcriptPath: '/home/u/sess-1.jsonl' })
    const b = build({
      entries: [entry],
      platform: 'win32',
      remoteAuthority: 'wsl+ubuntu-24.04',
    })
    await run(b, { sessionId: 'sess-1' })
    expect(b.showItemInFolder).toHaveBeenCalledWith('\\\\wsl$\\ubuntu-24.04\\home\\u\\sess-1.jsonl')
    expect(b.notify).not.toHaveBeenCalled()
  })
})

describe('NewSideTaskAction', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    AcpPromptReplaceInbox._resetForTests()
    vi.restoreAllMocks()
  })

  function sideSession(id: string, agentId: string): IAcpSession {
    return { id, agentId } as unknown as IAcpSession
  }

  function makeHarness(
    opts: {
      forkImpl?: (sid: string) => Promise<IAcpSession>
      activeEditor?: unknown
      activeSession?: IAcpSession
      /** What `getById` answers — the palette-only guards read it. */
      live?: IAcpSession
    } = {},
  ) {
    const groups = new EditorGroupsService()
    const notify = vi.fn()
    const forkSideTask = vi.fn(async (sid: string, _quote?: { text: string; label: string }) =>
      opts.forkImpl ? opts.forkImpl(sid) : sideSession('side-1', 'claude-code'),
    )
    const activeEditor = observableValue<unknown>('t.activeEditor', opts.activeEditor)
    const activeSession = observableValue<IAcpSession | undefined>(
      't.activeSession',
      opts.activeSession,
    )
    const services = new ServiceCollection()
    services.set(IAcpSessionService, {
      _serviceBrand: undefined,
      forkSideTask,
      getById: () => opts.live,
      activeSession,
    } as unknown as IAcpSessionService)
    services.set(IAcpSessionHistoryService, {
      _serviceBrand: undefined,
      entries: observableValue<readonly AcpSessionHistoryEntry[]>('test.entries', []),
      get: () => undefined,
    } as unknown as IAcpSessionHistoryService)
    services.set(IEditorGroupsService, groups)
    services.set(IEditorService, { activeEditor } as unknown as IEditorService)
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      register: () => ({ dispose() {} }),
      lastFocusedWidget: undefined,
    } as unknown as IAcpChatWidgetService)
    services.set(INotificationService, {
      _serviceBrand: undefined,
      notify,
    } as unknown as INotificationService)
    services.set(ILoggerService, {
      _serviceBrand: undefined,
      createLogger: () => new NullLogger(),
    } as unknown as ILoggerService)
    registerWorkspaceServices(services)
    const inst = new InstantiationService(services)
    services.set(IInstantiationService, inst)
    return { groups, notify, forkSideTask, inst, activeEditor }
  }

  function stubSelection(text: string | undefined): void {
    vi.spyOn(window, 'getSelection').mockReturnValue(
      text === undefined ? null : ({ toString: () => text } as Selection),
    )
  }

  async function run(inst: InstantiationService, arg?: { sessionId?: unknown }): Promise<void> {
    await inst.invokeFunction((accessor) => new NewSideTaskAction().run(accessor, arg))
  }

  it('appears in the chat context menu on any fork-capable chat, selected text or not', () => {
    disposables.push(registerAction2(NewSideTaskAction))
    const items = (ctx: ContextKeyService) =>
      MenuRegistry.getMenuItems(MenuId.AcpChatContext, ctx).filter(
        (item) => 'command' in item && item.command === NewSideTaskAction.ID,
      )
    const both = new ContextKeyService()
    both.createKey<boolean>('acpChatHasSelection', true)
    both.createKey<boolean>('acpChatForkSupported', true)
    expect(items(both)).toHaveLength(1)

    // The new case: no selection must no longer hide the row.
    const noSelection = new ContextKeyService()
    noSelection.createKey<boolean>('acpChatHasSelection', false)
    noSelection.createKey<boolean>('acpChatForkSupported', true)
    expect(items(noSelection)).toHaveLength(1)

    const noFork = new ContextKeyService()
    noFork.createKey<boolean>('acpChatHasSelection', true)
    noFork.createKey<boolean>('acpChatForkSupported', false)
    expect(items(noFork)).toHaveLength(0)

    // Filed under the card group, next to Fork Session / Rewind to Here.
    expect(items(both)[0]).toEqual(expect.objectContaining({ group: '2_card', order: 9 }))
  })

  it('is listed in the command palette only while a session editor is in front', () => {
    disposables.push(registerAction2(NewSideTaskAction))
    const listed = (ctx: ContextKeyService) =>
      MenuRegistry.getMenuItems(MenuId.CommandPalette, ctx).some(
        (item) => 'command' in item && item.command === NewSideTaskAction.ID,
      )
    const inSession = new ContextKeyService()
    inSession.createKey<string>('activeEditorTypeId', AcpSessionEditorInput.TYPE_ID)
    expect(listed(inSession)).toBe(true)

    const inFile = new ContextKeyService()
    inFile.createKey<string>('activeEditorTypeId', 'default')
    expect(listed(inFile)).toBe(false)

    // The palette gate must not carry editorAreaFocus: opening the palette moves
    // focus into the quick input, which would flip it false and hide the row.
    const blurred = new ContextKeyService()
    blurred.createKey<string>('activeEditorTypeId', AcpSessionEditorInput.TYPE_ID)
    blurred.createKey<boolean>('editorAreaFocus', false)
    expect(listed(blurred)).toBe(true)
  })

  it('ignores the DOM selection when the palette invokes it without args', async () => {
    const h = makeHarness({ activeSession: sideSession('parent-1', 'claude-code') })
    // What the user highlighted inside the quick input is not a quote.
    stubSelection('quick input text')

    await run(h.inst)

    expect(h.forkSideTask).toHaveBeenCalledTimes(1)
    expect(h.forkSideTask.mock.calls[0]![0]).toBe('parent-1')
    expect(h.forkSideTask.mock.calls[0]![1]).toBeUndefined()
    expect(AcpPromptReplaceInbox.drain('side-1')).toBeUndefined()
  })

  it('resolves the session from the active session editor on the palette path', async () => {
    const h = makeHarness()
    const tab = h.inst.createInstance(AcpSessionEditorInput, 'parent-dur', 'fake', undefined)
    h.groups.activeGroup.openEditor(tab, { activate: true, pinned: true })
    h.activeEditor.set(tab, undefined)

    await run(h.inst)

    expect(h.forkSideTask.mock.calls[0]![0]).toBe('parent-dur')
    expect(h.groups.groups).toHaveLength(2)
  })

  it('is a no-op when nothing names a session', async () => {
    const h = makeHarness()

    await run(h.inst)
    expect(h.forkSideTask).not.toHaveBeenCalled()

    // A stray selection in the quick input still needs a session to fork.
    stubSelection('quick input text')
    await run(h.inst)
    expect(h.forkSideTask).not.toHaveBeenCalled()
  })

  it('turns away a read-only session the palette can still reach', async () => {
    const readOnly = {
      id: 'parent-1',
      agentId: 'claude-code',
      readOnly: true,
      forkSupported: observableValue('t.fork', true),
    } as unknown as IAcpSession
    const h = makeHarness({ activeSession: readOnly, live: readOnly })

    await run(h.inst)

    expect(h.forkSideTask).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(h.notify.mock.calls[0]![0].message).toContain('own worktree')
  })

  it('turns away an agent without fork support instead of surfacing the raw service error', async () => {
    const noFork = {
      id: 'parent-1',
      agentId: 'echo',
      readOnly: false,
      forkSupported: observableValue('t.fork', false),
    } as unknown as IAcpSession
    const h = makeHarness({ activeSession: noFork, live: noFork })

    await run(h.inst)

    expect(h.forkSideTask).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(h.notify.mock.calls[0]![0].message).toBe('This agent does not support side tasks.')
  })

  it('forks without a quote when the menu names a session but nothing is selected', async () => {
    const h = makeHarness()
    stubSelection('   ')

    await run(h.inst, { sessionId: 'parent-1' })

    expect(h.forkSideTask.mock.calls[0]![0]).toBe('parent-1')
    expect(h.forkSideTask.mock.calls[0]![1]).toBeUndefined()
    expect(h.groups.groups).toHaveLength(2)
    const sideTab = h.groups.groups[1]!.activeEditor
    expect(sideTab).toBeInstanceOf(AcpSessionEditorInput)
    expect((sideTab as AcpSessionEditorInput).sessionId).toBe('side-1')
    // Nothing is deposited: an empty quote would clear the side chat's input.
    expect(AcpPromptReplaceInbox.drain('side-1')).toBeUndefined()
  })

  it('forks into a new right group, opens the tab there, and deposits the blockquote', async () => {
    const h = makeHarness()
    stubSelection('line one\n\nline two')
    expect(h.groups.groups).toHaveLength(1)

    await run(h.inst, { sessionId: 'parent-1' })

    expect(h.forkSideTask).toHaveBeenCalledWith('parent-1', {
      text: 'line one\n\nline two',
      label: 'line one line two',
    })
    // A right group was created, activated, and holds the side chat tab.
    expect(h.groups.groups).toHaveLength(2)
    const right = h.groups.groups[1]!
    expect(h.groups.activeGroup).toBe(right)
    const tab = right.activeEditor
    expect(tab).toBeInstanceOf(AcpSessionEditorInput)
    expect((tab as AcpSessionEditorInput).sessionId).toBe('side-1')
    // The prefill is a markdown blockquote; blank lines become bare '>'.
    expect(AcpPromptReplaceInbox.drain('side-1')).toEqual({
      text: '> line one\n>\n> line two\n\n',
      contexts: [],
    })
  })

  it('reuses an existing right group instead of splitting again', async () => {
    const h = makeHarness()
    h.groups.addGroup(h.groups.activeGroup, GroupDirection.Right)
    stubSelection('quote')

    await run(h.inst, { sessionId: 'parent-1' })

    expect(h.groups.groups).toHaveLength(2)
    expect(AcpPromptReplaceInbox.drain('side-1')).toEqual({ text: '> quote\n\n', contexts: [] })
  })

  it('truncates quotes past the hard cap and still deposits', async () => {
    const h = makeHarness()
    stubSelection('x'.repeat(8100))

    await run(h.inst, { sessionId: 'parent-1' })

    const quote = h.forkSideTask.mock.calls[0]![1]!.text
    expect(quote.length).toBe(8001)
    expect(quote.endsWith('…')).toBe(true)
  })

  it('notifies an error when forking fails', async () => {
    const h = makeHarness({
      forkImpl: () => Promise.reject(new Error('agent does not support fork')),
    })
    stubSelection('quote')

    await run(h.inst, { sessionId: 'parent-1' })

    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(h.notify.mock.calls[0]![0].message).toContain('agent does not support fork')
    expect(h.groups.groups).toHaveLength(1)
  })

  it('uses the dedicated message for foreign-worktree rejections', async () => {
    const h = makeHarness({
      forkImpl: () => Promise.reject(new AcpForeignWorktreeError('s1', '/a', '/b')),
    })
    stubSelection('quote')

    await run(h.inst, { sessionId: 'parent-1' })

    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(h.notify.mock.calls[0]![0].message).toContain('own worktree')
  })
})

describe('Agent card-targeted collapse actions', () => {
  const disposables: IDisposable[] = []
  const SESSION_ID = 's-cards'

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function makeAgentMessage(id: string): AcpMessage {
    return { id, role: 'agent', text: id, blocks: [], streaming: false }
  }

  function makeTaskCall(id: string, children: AcpToolCall['children']): AcpToolCall {
    return {
      id,
      title: 'Task',
      kind: 'other',
      status: 'completed',
      text: '',
      blocks: [],
      diffs: [],
      ...(children !== undefined ? { children } : {}),
    }
  }

  const SESSION_ITEMS: readonly TimelineItem[] = [
    { kind: 'message', id: 'u', message: makeAgentMessage('u') },
    {
      kind: 'toolCall',
      id: 'task',
      call: makeTaskCall('task', [
        { kind: 'message', id: 'sm1', message: makeAgentMessage('sm1') },
      ]),
    },
  ]

  function runWithArgs(commandId: string, widget: AcpChatWidget, arg?: unknown): void {
    const services = new ServiceCollection()
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      lastFocusedWidget: widget,
      register: vi.fn(),
      widgetForSession: (id: string) => (id === SESSION_ID ? widget : undefined),
    } as unknown as IAcpChatWidgetService)
    services.set(IAcpSessionService, {
      _serviceBrand: undefined,
      getById: (id: string) =>
        id === SESSION_ID
          ? ({
              id: SESSION_ID,
              timeline: observableValue<readonly TimelineItem[]>('t.timeline', SESSION_ITEMS),
            } as unknown as IAcpSession)
          : undefined,
    } as unknown as IAcpSessionService)
    services.set(IEditorService, {
      _serviceBrand: undefined,
      activeEditor: observableValue<unknown>('t.activeEditor', undefined),
    } as unknown as IEditorService)
    const inst = new InstantiationService(services)
    inst.invokeFunction((accessor) => {
      CommandsRegistry.getCommand(commandId)!.handler(accessor, arg)
    })
  }

  it('offers both collapse rows, labelled by the card state they produce', () => {
    disposables.push(registerAction2(ToggleAcpTimelineItemCollapseAction))
    const rows = MenuRegistry.getMenuItems(MenuId.AcpChatContext).filter(
      (i) => 'command' in i && i.command === ToggleAcpTimelineItemCollapseAction.ID,
    )
    const whens = rows.map((r) => {
      if (!('when' in r)) return ''
      return typeof r.when === 'string' ? r.when : r.when.serialize()
    })
    expect(whens).toHaveLength(2)
    // Two mutually exclusive rows rather than one toggle: the label states the
    // end state, so the row that folds must not also match an already-folded card.
    expect(whens[0]).toContain('!acpChatContextCardCollapsed')
    expect(whens[1]).not.toContain('!acpChatContextCardCollapsed')
    expect(whens[1]).toContain('acpChatContextCardCollapsed')
    // registerAction2 ANDs the command's precondition into every menu row — the
    // rows must not survive the chat losing focus, or a stale menu state could
    // fold a card in a chat the user has moved on from.
    expect(whens.every((w) => w.includes('acpChatFocused'))).toBe(true)
    // The command's own title stays generic — only the menu rows are state-specific.
    expect(CommandsRegistry.getCommand(ToggleAcpTimelineItemCollapseAction.ID)).toBeDefined()
  })

  it('collapses the card the menu was raised on, not the focused one', () => {
    disposables.push(registerAction2(ToggleAcpTimelineItemCollapseAction))
    const setSlotCollapsed = vi.fn()
    const toggleCollapse = vi.fn()
    const widget = makeFakeAcpChatWidget({
      isSlotCollapsed: () => false,
      setSlotCollapsed,
      toggleCollapse,
    })

    runWithArgs(ToggleAcpTimelineItemCollapseAction.ID, widget, {
      sessionId: SESSION_ID,
      slotKey: 'm:u',
    })

    // Deterministic: the menu row said "Collapse Card", so the state is written,
    // never toggled — a toggle could fold the wrong way.
    expect(setSlotCollapsed).toHaveBeenCalledWith(new Map([['m:u', true]]))
    expect(toggleCollapse).not.toHaveBeenCalled()
  })

  it('falls back to the focused card when the invocation carries no card', () => {
    disposables.push(registerAction2(ToggleAcpTimelineItemCollapseAction))
    const setSlotCollapsed = vi.fn()
    const toggleCollapse = vi.fn()
    const widget = makeFakeAcpChatWidget({ setSlotCollapsed, toggleCollapse })

    // Alt+F / command palette: no sessionId, no slotKey — the keybinding path.
    runWithArgs(ToggleAcpTimelineItemCollapseAction.ID, widget)

    expect(toggleCollapse).toHaveBeenCalledTimes(1)
    expect(setSlotCollapsed).not.toHaveBeenCalled()
  })

  it('ignores a card named for a session that has no widget', () => {
    disposables.push(registerAction2(ToggleAcpTimelineItemCollapseAction))
    const setSlotCollapsed = vi.fn()
    const widget = makeFakeAcpChatWidget({ setSlotCollapsed, isSlotCollapsed: () => false })

    runWithArgs(ToggleAcpTimelineItemCollapseAction.ID, widget, {
      sessionId: 's-other',
      slotKey: 'm:u',
    })

    expect(setSlotCollapsed).not.toHaveBeenCalled()
  })

  it('folds a sub-agent card and every card nested under it in one write', () => {
    disposables.push(registerAction2(ToggleAcpTimelineCardSubtreeAction))
    const setSlotCollapsed = vi.fn()
    const widget = makeFakeAcpChatWidget({ isSlotCollapsed: () => false, setSlotCollapsed })

    runWithArgs(ToggleAcpTimelineCardSubtreeAction.ID, widget, {
      sessionId: SESSION_ID,
      slotKey: 't:task',
    })

    // One call, one Map — one render and one persisted write for the whole subtree.
    expect(setSlotCollapsed).toHaveBeenCalledTimes(1)
    expect(setSlotCollapsed).toHaveBeenCalledWith(
      new Map([
        ['t:task', true],
        ['t:task/m:sm1', true],
      ]),
    )
  })

  it('expands a folded subtree back to the parent state', () => {
    disposables.push(registerAction2(ToggleAcpTimelineCardSubtreeAction))
    const setSlotCollapsed = vi.fn()
    // The parent reads as folded → the command's stated end state is "expanded".
    const widget = makeFakeAcpChatWidget({ isSlotCollapsed: () => true, setSlotCollapsed })

    runWithArgs(ToggleAcpTimelineCardSubtreeAction.ID, widget, {
      sessionId: SESSION_ID,
      slotKey: 't:task',
    })

    expect(setSlotCollapsed).toHaveBeenCalledWith(
      new Map([
        ['t:task', false],
        ['t:task/m:sm1', false],
      ]),
    )
  })

  it('does nothing for a card key that resolves to no item', () => {
    disposables.push(registerAction2(ToggleAcpTimelineCardSubtreeAction))
    const setSlotCollapsed = vi.fn()
    const widget = makeFakeAcpChatWidget({ setSlotCollapsed })

    runWithArgs(ToggleAcpTimelineCardSubtreeAction.ID, widget, {
      sessionId: SESSION_ID,
      slotKey: 't:gone',
    })
    // A bare invocation has no card to act on at all.
    runWithArgs(ToggleAcpTimelineCardSubtreeAction.ID, widget)

    expect(setSlotCollapsed).not.toHaveBeenCalled()
  })
})
