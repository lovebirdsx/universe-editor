import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  IEditorService,
  IHostService,
  ILayoutService,
  INotificationService,
  IQuickInputService,
  IViewsService,
  IWorkspaceService,
  InstantiationService,
  KeybindingsRegistry,
  ServiceCollection,
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
  IncreaseAgentFontSizeAction,
  DecreaseAgentFontSizeAction,
  ResetAgentFontSizeAction,
  SelectNextAcpPromptSuggestionAction,
  SelectPreviousAcpPromptSuggestionAction,
  AcceptAcpPromptSuggestionAction,
  HideAcpPromptSuggestionAction,
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
    } as unknown as IAcpChatWidgetService)
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

describe('Agent chat font zoom actions', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function focusedContext(): ContextKeyService {
    const ctx = new ContextKeyService()
    ctx.createKey<boolean>('acpChatFocused', true)
    return ctx
  }

  it('binds zoom keybindings only while the chat is focused', () => {
    disposables.push(registerAction2(IncreaseAgentFontSizeAction))
    disposables.push(registerAction2(DecreaseAgentFontSizeAction))
    disposables.push(registerAction2(ResetAgentFontSizeAction))
    const ctx = focusedContext()
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+=', ctx)).toBe(
      IncreaseAgentFontSizeAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+-', ctx)).toBe(
      DecreaseAgentFontSizeAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+0', ctx)).toBe(ResetAgentFontSizeAction.ID)
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
      pick: (items: IQuickPickItem[]) => Promise.resolve(items[opts.pickIndex]),
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
    // AcpSessionEditorInput.createInstance pulls these at construction.
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      register: vi.fn(),
    } as unknown as IAcpChatWidgetService)
    const inst = new InstantiationService(services)
    return { inst, resumeSession, setActive, openEditor, openViewContainer, notify }
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
