import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  IDialogService,
  IEditorGroupsService,
  IEditorService,
  IHostService,
  IInstantiationService,
  ILayoutService,
  MenuId,
  MenuRegistry,
  INotificationService,
  IQuickInputService,
  IUriIdentityService,
  IViewsService,
  IWorkspaceService,
  InstantiationService,
  KeybindingsRegistry,
  ServiceCollection,
  UriIdentityService,
  GroupDirection,
  observableValue,
  registerAction2,
  type IDisposable,
  type IQuickPickItem,
} from '@universe-editor/platform'
import {
  ResumeAgentSessionAction,
  ScrollAcpTimelinePageDownAction,
  ScrollAcpTimelinePageUpAction,
  FocusBottomAcpTimelineAction,
  FocusTopAcpTimelineAction,
  JumpToAcpPlanAction,
  SelectNextAcpPromptSuggestionAction,
  SelectPreviousAcpPromptSuggestionAction,
  AcceptAcpPromptSuggestionAction,
  HideAcpPromptSuggestionAction,
  NewAgentSessionInCurrentEditorAction,
} from '../agentActions.js'
import {
  IAcpChatWidgetService,
  type AcpChatWidget,
} from '../../services/acp/acpChatWidgetService.js'
import {
  AcpForeignWorktreeError,
  IAcpSessionService,
  type IAcpSession,
} from '../../services/acp/acpSessionService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
} from '../../services/acp/acpSessionHistory.js'
import { IAcpChatLocationService } from '../../services/acp/acpChatLocationService.js'
import { AcpSessionEditorInput } from '../../services/acp/acpSessionEditorInput.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { EditorService } from '../../services/editor/EditorService.js'

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
    scrollTimeline: ReturnType<typeof vi.fn>
    jumpToPlan: ReturnType<typeof vi.fn>
    popoverSelectNext: ReturnType<typeof vi.fn>
    popoverSelectPrev: ReturnType<typeof vi.fn>
    popoverAccept: ReturnType<typeof vi.fn>
    popoverHide: ReturnType<typeof vi.fn>
  } {
    const moveTimeline = vi.fn()
    const scrollTimeline = vi.fn()
    const jumpToPlan = vi.fn()
    const popoverSelectNext = vi.fn()
    const popoverSelectPrev = vi.fn()
    const popoverAccept = vi.fn()
    const popoverHide = vi.fn()
    return {
      moveTimeline,
      scrollTimeline,
      jumpToPlan,
      popoverSelectNext,
      popoverSelectPrev,
      popoverAccept,
      popoverHide,
      widget: {
        container: document.createElement('div'),
        moveTimeline,
        scrollTimeline,
        focusInput: vi.fn(),
        jumpToPlan,
        toggleCollapse: vi.fn(),
        cycleCollapseMode: vi.fn(),
        getFocusedText: vi.fn(),
        popoverSelectNext,
        popoverSelectPrev,
        popoverAccept,
        popoverHide,
        openFind: vi.fn(),
        closeFind: vi.fn(),
        findNext: vi.fn(),
        findPrev: vi.fn(),
      },
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
      widget: {
        container: document.createElement('div'),
        moveTimeline: vi.fn(),
        scrollTimeline: vi.fn(),
        focusInput: vi.fn(),
        jumpToPlan: vi.fn(),
        toggleCollapse: vi.fn(),
        cycleCollapseMode: vi.fn(),
        getFocusedText: vi.fn(),
        popoverSelectNext,
        popoverSelectPrev,
        popoverAccept,
        popoverHide,
        openFind: vi.fn(),
        closeFind: vi.fn(),
        findNext: vi.fn(),
        findPrev: vi.fn(),
      },
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
  function fakeSession(id: string, agentId: string, title: string): IAcpSession {
    return {
      id,
      agentId,
      title,
      status: observableValue('test.status', 'idle'),
      sessionIdOnAgent: observableValue<string | undefined>('test.sessionIdOnAgent', id),
    } as unknown as IAcpSession
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
      // Simulate AcpChatLocationService's active-session autorun: createSession
      // may already have opened the new session before the title action resumes.
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
    } as unknown as IAcpChatWidgetService)
    services.set(IEditorGroupsService, groups)
    services.set(IDialogService, {
      _serviceBrand: undefined,
      confirm: vi.fn(),
      prompt: vi.fn(),
    } as unknown as IDialogService)
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

    expect(createSession).toHaveBeenCalledWith('codex')
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
  // and stay the active group. createSession's side effect (the chat location
  // autorun) opens the new session via EditorService.openEditor, whose lock-aware
  // routing hands a brand-new editor to a *different* unlocked group and activates
  // it; without our cleanup + re-activation the real editor would end up split
  // across groups with focus in the wrong one.
  it('creates the new session directly in the locked group and keeps it active', async () => {
    const groups = new EditorGroupsService()
    const editorService = new EditorService(groups)
    const live = new Map<string, IAcpSession>()
    live.set('old-session', fakeSession('old-session', 'codex', 'Old'))

    const instRef: { current?: InstantiationService } = {}
    const createSession = vi.fn(async (agentId?: string) => {
      const session = fakeSession('new-session', agentId ?? 'missing-agent', 'New')
      live.set(session.id, session)
      // Mirror AcpChatLocationService's active-session autorun: it opens the
      // freshly created session through the shared EditorService, which routes a
      // new editor away from the locked active group into an unlocked one.
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
    } as unknown as IAcpChatWidgetService)
    services.set(IEditorGroupsService, groups)
    services.set(IEditorService, editorService)
    services.set(IDialogService, {
      _serviceBrand: undefined,
      confirm: vi.fn(),
      prompt: vi.fn(),
    } as unknown as IDialogService)
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
    location?: 'editor' | 'sidebar'
    resumeImpl?: (id: string) => Promise<IAcpSession>
  }) {
    const resumeSession = vi.fn(
      opts.resumeImpl ??
        ((_id: string) => Promise.resolve({ id: 'live', agentId: 'fake' } as IAcpSession)),
    )
    const setActive = vi.fn()
    const openEditor = vi.fn()
    const openViewContainer = vi.fn()
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
    const location = {
      _serviceBrand: undefined,
      location: observableValue('test.loc', opts.location ?? 'editor'),
    } as unknown as IAcpChatLocationService
    const layout = {
      _serviceBrand: undefined,
      getVisible: () => true,
      toggleVisible: vi.fn(),
    } as unknown as ILayoutService
    const views = {
      _serviceBrand: undefined,
      openViewContainer,
    } as unknown as IViewsService
    const editor = {
      _serviceBrand: undefined,
      openEditor,
    } as unknown as IEditorService
    const notification = {
      _serviceBrand: undefined,
      notify,
    } as unknown as INotificationService
    const workspace = {
      _serviceBrand: undefined,
      current: opts.currentCwd ? { folder: { fsPath: opts.currentCwd }, name: 'ws' } : null,
    } as unknown as IWorkspaceService
    const host = { _serviceBrand: undefined, platform: opts.platform ?? 'linux' } as IHostService

    const services = new ServiceCollection()
    services.set(IAcpSessionService, sessions)
    services.set(IAcpSessionHistoryService, history)
    services.set(IQuickInputService, quickInput)
    services.set(IAcpChatLocationService, location)
    services.set(ILayoutService, layout)
    services.set(IViewsService, views)
    services.set(IEditorService, editor)
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
    return { inst, resumeSession, setActive, openEditor, openViewContainer, notify, pickedItems }
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
    expect(b.openEditor).toHaveBeenCalledTimes(1)
    const opened = b.openEditor.mock.calls[0]?.[0]
    expect(opened).toBeInstanceOf(AcpSessionEditorInput)
    expect((opened as AcpSessionEditorInput).sessionId).toBe('sess-1')
  })

  it('resumes a session whose cwd matches the open workspace', async () => {
    const entry = makeEntry({ cwd: '/repo/main', title: 'Local' })
    const b = build({ entries: [entry], pickIndex: 0, currentCwd: '/repo/main' })
    await run(b)
    expect(b.resumeSession).toHaveBeenCalledWith('sess-1')
  })

  it('shows the session directory name in the picker description', async () => {
    const entries = [
      makeEntry({
        id: 'sess-win',
        sessionIdOnAgent: 'sess-win',
        cwd: 'D:\\git_project\\universe-editor\\',
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
    expect(b.openEditor).toHaveBeenCalledTimes(1)
  })
})
