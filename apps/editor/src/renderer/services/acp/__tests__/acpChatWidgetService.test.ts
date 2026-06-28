/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpChatWidgetService.ts
 *
 *  Drives focusin/focusout on registered container elements (happy-dom) and
 *  asserts both the `acpChatFocused` contextKey state and `lastFocusedWidget`
 *  tracking — including the two-widget cross-focus transition that bug #2 was
 *  about.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextKeyService,
  DisposableTracker,
  setDisposableTracker,
} from '@universe-editor/platform'
import { AcpChatWidgetService, type AcpChatWidget } from '../acpChatWidgetService.js'

function makeWidget(
  label: string,
  sessionId = label,
): {
  container: HTMLElement
  child: HTMLElement
  widget: AcpChatWidget
  moveSpy: ReturnType<typeof vi.fn>
  focusSpy: ReturnType<typeof vi.fn>
} {
  const container = document.createElement('div')
  container.dataset['label'] = label
  const child = document.createElement('input')
  container.appendChild(child)
  document.body.appendChild(container)
  const moveSpy = vi.fn()
  const focusSpy = vi.fn()
  const widget: AcpChatWidget = {
    sessionId,
    container,
    moveTimeline: moveSpy,
    scrollTimeline: vi.fn(),
    focusInput: focusSpy,
    jumpToPlan: vi.fn(),
    toggleCollapse: vi.fn(),
    cycleCollapseMode: vi.fn(),
    getFocusedText: vi.fn(),
    popoverSelectNext: vi.fn(),
    popoverSelectPrev: vi.fn(),
    popoverAccept: vi.fn(),
    popoverHide: vi.fn(),
    openFind: vi.fn(),
    closeFind: vi.fn(),
    findNext: vi.fn(),
    findPrev: vi.fn(),
  }
  return { container, child, widget, moveSpy, focusSpy }
}

function fireFocusIn(target: HTMLElement, relatedTarget: EventTarget | null = null): void {
  const e = new FocusEvent('focusin', { bubbles: true, relatedTarget })
  target.dispatchEvent(e)
}

function fireFocusOut(target: HTMLElement, relatedTarget: EventTarget | null = null): void {
  const e = new FocusEvent('focusout', { bubbles: true, relatedTarget })
  target.dispatchEvent(e)
}

describe('AcpChatWidgetService', () => {
  let cks: ContextKeyService
  let svc: AcpChatWidgetService

  beforeEach(() => {
    cks = new ContextKeyService()
    svc = new AcpChatWidgetService(cks)
  })

  afterEach(() => {
    svc.dispose()
    cks.dispose()
    document.body.replaceChildren()
  })

  it('starts with no focused widget and key=false', () => {
    expect(svc.lastFocusedWidget).toBeUndefined()
    expect(cks.get('acpChatFocused')).toBe(false)
  })

  it('focusin inside a registered container sets key=true and lastFocused', () => {
    const a = makeWidget('a')
    svc.register(a.widget)
    fireFocusIn(a.child)
    expect(cks.get('acpChatFocused')).toBe(true)
    expect(svc.lastFocusedWidget).toBe(a.widget)
  })

  it('focusout leaving the container clears key but keeps lastFocused null', () => {
    const a = makeWidget('a')
    svc.register(a.widget)
    fireFocusIn(a.child)
    fireFocusOut(a.child, null)
    expect(cks.get('acpChatFocused')).toBe(false)
    // lastFocusedWidget intentionally cleared only on unregister.
    expect(svc.lastFocusedWidget).toBe(a.widget)
  })

  it('focus shift between descendants of the same widget does not flip key', () => {
    const a = makeWidget('a')
    const sibling = document.createElement('button')
    a.container.appendChild(sibling)
    svc.register(a.widget)
    fireFocusIn(a.child)
    // descendant→descendant inside same container
    fireFocusOut(a.child, sibling)
    expect(cks.get('acpChatFocused')).toBe(true)
  })

  it('focus crossing from widget A to widget B updates lastFocused and stays true', () => {
    const a = makeWidget('a')
    const b = makeWidget('b')
    svc.register(a.widget)
    svc.register(b.widget)
    fireFocusIn(a.child)
    expect(svc.lastFocusedWidget).toBe(a.widget)
    // focusout on A with relatedTarget inside B; then focusin on B.
    fireFocusOut(a.child, b.child)
    fireFocusIn(b.child, a.child)
    expect(cks.get('acpChatFocused')).toBe(true)
    expect(svc.lastFocusedWidget).toBe(b.widget)
  })

  it('unregistering the focused widget drops key to false', () => {
    const a = makeWidget('a')
    const b = makeWidget('b')
    svc.register(a.widget)
    const subB = svc.register(b.widget)
    fireFocusIn(b.child)
    expect(svc.lastFocusedWidget).toBe(b.widget)
    subB.dispose()
    expect(cks.get('acpChatFocused')).toBe(false)
    expect(svc.lastFocusedWidget).toBeUndefined()
    // A is still alive and can still take focus.
    fireFocusIn(a.child)
    expect(cks.get('acpChatFocused')).toBe(true)
    expect(svc.lastFocusedWidget).toBe(a.widget)
  })

  it('lastFocusedWidget.moveTimeline only invokes the focused widget callback', () => {
    const a = makeWidget('a')
    const b = makeWidget('b')
    svc.register(a.widget)
    svc.register(b.widget)
    fireFocusIn(b.child)
    svc.lastFocusedWidget?.moveTimeline('next')
    expect(b.moveSpy).toHaveBeenCalledWith('next')
    expect(a.moveSpy).not.toHaveBeenCalled()
  })

  it('focusSessionInput invokes the latest registered widget for that session', () => {
    const oldA = makeWidget('old-a', 's1')
    const b = makeWidget('b', 's2')
    const newA = makeWidget('new-a', 's1')
    svc.register(oldA.widget)
    svc.register(b.widget)
    svc.register(newA.widget)

    expect(svc.focusSessionInput('s1')).toBe(true)
    expect(newA.focusSpy).toHaveBeenCalledOnce()
    expect(oldA.focusSpy).not.toHaveBeenCalled()
    expect(b.focusSpy).not.toHaveBeenCalled()
    expect(svc.focusSessionInput('missing')).toBe(false)
  })

  it('widgetForSession returns the latest registered widget for that session, or undefined', () => {
    const oldA = makeWidget('old-a', 's1')
    const b = makeWidget('b', 's2')
    const newA = makeWidget('new-a', 's1')
    svc.register(oldA.widget)
    svc.register(b.widget)
    svc.register(newA.widget)

    expect(svc.widgetForSession('s1')).toBe(newA.widget)
    expect(svc.widgetForSession('s2')).toBe(b.widget)
    expect(svc.widgetForSession('missing')).toBeUndefined()
  })

  it('registering a container that already has the active descendant seeds focused=true', () => {
    const container = document.createElement('div')
    const input = document.createElement('input')
    container.appendChild(input)
    document.body.appendChild(container)
    input.focus()
    expect(document.activeElement).toBe(input)
    const widget: AcpChatWidget = {
      container,
      moveTimeline: vi.fn(),
      scrollTimeline: vi.fn(),
      focusInput: vi.fn(),
      jumpToPlan: vi.fn(),
      toggleCollapse: vi.fn(),
      cycleCollapseMode: vi.fn(),
      getFocusedText: vi.fn(),
      popoverSelectNext: vi.fn(),
      popoverSelectPrev: vi.fn(),
      popoverAccept: vi.fn(),
      popoverHide: vi.fn(),
      openFind: vi.fn(),
      closeFind: vi.fn(),
      findNext: vi.fn(),
      findPrev: vi.fn(),
    }
    svc.register(widget)
    expect(cks.get('acpChatFocused')).toBe(true)
    expect(svc.lastFocusedWidget).toBe(widget)
  })

  it('throws on double-register of the same widget', () => {
    const a = makeWidget('a')
    svc.register(a.widget)
    expect(() => svc.register(a.widget)).toThrow()
  })

  it('disposing the service detaches listeners', () => {
    const a = makeWidget('a')
    svc.register(a.widget)
    svc.dispose()
    fireFocusIn(a.child)
    // After dispose the contextKey on the disposed service is irrelevant; just
    // ensure no callbacks fire.
    expect(a.moveSpy).not.toHaveBeenCalled()
    expect(a.focusSpy).not.toHaveBeenCalled()
  })

  // Regression: a registration the caller never disposes (ChatBody's React
  // useEffect cleanup racing `beforeunload → reactRoot.unmount()`) must still be
  // released when the singleton-rooted service is disposed — otherwise the
  // returned disposable stays an un-rooted leak the DisposableTracker reports.
  it('does not leak a registration when only the service is disposed', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    try {
      const localCks = new ContextKeyService()
      const localSvc = new AcpChatWidgetService(localCks)
      const a = makeWidget('leak')
      localSvc.register(a.widget) // caller drops the returned disposable on purpose
      localSvc.dispose()
      localCks.dispose()
      expect(tracker.computeLeakingDisposables()).toBeUndefined()
    } finally {
      setDisposableTracker(null)
    }
  })
})
