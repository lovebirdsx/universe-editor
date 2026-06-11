import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  InstantiationService,
  KeybindingsRegistry,
  ServiceCollection,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import {
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
