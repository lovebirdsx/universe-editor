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
  } {
    const moveTimeline = vi.fn()
    const scrollTimeline = vi.fn()
    const jumpToPlan = vi.fn()
    return {
      moveTimeline,
      scrollTimeline,
      jumpToPlan,
      widget: {
        container: document.createElement('div'),
        moveTimeline,
        scrollTimeline,
        focusInput: vi.fn(),
        jumpToPlan,
        toggleCollapse: vi.fn(),
        cycleCollapseMode: vi.fn(),
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
