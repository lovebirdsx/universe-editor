/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpChatWidgetService — renderer-side registry of mounted ACP ChatBody widgets.
 *  Each ChatBody registers its DOM container plus `moveTimeline` / `focusInput`
 *  callbacks; the service listens for focusin/focusout on those containers and
 *  exposes `lastFocusedWidget` so commands can target one specific instance
 *  instead of broadcasting to every mounted chat.
 *
 *  Owns the root `acpChatFocused` contextKey: true iff any registered widget
 *  currently contains DOM focus. Action `when` clauses gate on this so Alt+J
 *  doesn't fire from the Explorer.
 *
 *  Also owns the `acpPromptPopupVisible` contextKey: true iff the *focused*
 *  widget has its slash/mention popover open. Per-widget popover state is pushed
 *  via `setPopoverOpen` and aggregated against focus the same way as
 *  `acpChatFocused`. The SelectNext/Prev/Accept/Hide suggestion commands gate
 *  their keybindings on it (mirroring VSCode's `suggestWidgetVisible`).
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  DisposableStore,
  IContextKeyService,
  toDisposable,
  type IContextKey,
  type IDisposable,
} from '@universe-editor/platform'

export type AcpTimelineMoveDirection = 'next' | 'prev' | 'first' | 'last'

export type AcpTimelineScrollTarget = 'top' | 'bottom' | 'pageUp' | 'pageDown' | 'up' | 'down'

export interface AcpChatWidget {
  readonly sessionId?: string
  readonly container: HTMLElement
  moveTimeline(direction: AcpTimelineMoveDirection): void
  scrollTimeline(target: AcpTimelineScrollTarget): void
  focusInput(): void
  /** Reveal the latest ExitPlanMode plan card (a `switch_mode` tool call). */
  jumpToPlan(): void
  /** Toggle the collapsed state of the currently focused timeline item. */
  toggleCollapse(): void
  /** Cycle the whole timeline: by-kind default → all collapsed → all expanded. */
  cycleCollapseMode(): void
  /** Plain text of the currently focused timeline message; undefined when none. */
  getFocusedText(): string | undefined
  /** Move selection to the next item in the open slash/mention popover. */
  popoverSelectNext(): void
  /** Move selection to the previous item in the open slash/mention popover. */
  popoverSelectPrev(): void
  /** Accept the highlighted slash/mention popover item. */
  popoverAccept(): void
  /** Dismiss the open slash/mention popover. */
  popoverHide(): void
}

export interface IAcpChatWidgetService {
  readonly _serviceBrand: undefined
  readonly lastFocusedWidget: AcpChatWidget | undefined
  register(widget: AcpChatWidget): IDisposable
  focusSessionInput(sessionId: string): boolean
  /** Push a widget's popover open/closed state; the service flips
   *  `acpPromptPopupVisible` on iff the *focused* widget's popover is open. */
  setPopoverOpen(widget: AcpChatWidget, open: boolean): void
}

export const IAcpChatWidgetService = createDecorator<IAcpChatWidgetService>('acpChatWidgetService')

interface Entry {
  widget: AcpChatWidget
  focused: boolean
  popoverOpen: boolean
  onFocusIn: (e: FocusEvent) => void
  onFocusOut: (e: FocusEvent) => void
}

export class AcpChatWidgetService extends Disposable implements IAcpChatWidgetService {
  declare readonly _serviceBrand: undefined

  private readonly _entries = new Map<AcpChatWidget, Entry>()
  private _lastFocusedWidget: AcpChatWidget | undefined
  private readonly _key: IContextKey<boolean>
  private readonly _popupKey: IContextKey<boolean>

  // Roots every registration's cleanup under this (singleton-rooted) service so
  // the leak detector doesn't report a still-mounted ChatBody's registration
  // when `beforeunload` fires before React flushes the useEffect cleanup.
  private readonly _registrations = this._register(new DisposableStore())

  constructor(@IContextKeyService contextKeyService: IContextKeyService) {
    super()
    this._key = contextKeyService.createKey<boolean>('acpChatFocused', false)
    this._popupKey = contextKeyService.createKey<boolean>('acpPromptPopupVisible', false)
  }

  get lastFocusedWidget(): AcpChatWidget | undefined {
    return this._lastFocusedWidget
  }

  register(widget: AcpChatWidget): IDisposable {
    if (this._entries.has(widget)) {
      throw new Error('AcpChatWidget already registered')
    }
    const onFocusIn = (_e: FocusEvent): void => {
      this._setFocused(widget, true)
    }
    const onFocusOut = (e: FocusEvent): void => {
      // Descendant→descendant focus shift within the same container: keep
      // focused=true. Only flip to false when focus exits the container.
      const next = e.relatedTarget
      if (next instanceof Node && widget.container.contains(next)) return
      this._setFocused(widget, false)
    }
    const entry: Entry = { widget, focused: false, popoverOpen: false, onFocusIn, onFocusOut }
    widget.container.addEventListener('focusin', onFocusIn)
    widget.container.addEventListener('focusout', onFocusOut)
    this._entries.set(widget, entry)
    // If the container already contains the active element (e.g. registered
    // mid-stream after PromptInput auto-focused), seed the focused state.
    const doc = widget.container.ownerDocument
    const active = doc?.activeElement
    if (active instanceof Node && widget.container.contains(active)) {
      this._setFocused(widget, true)
    }
    const sub = toDisposable(() => {
      this._registrations.deleteAndLeak(sub)
      this._unregister(widget)
    })
    return this._registrations.add(sub)
  }

  focusSessionInput(sessionId: string): boolean {
    let target: AcpChatWidget | undefined
    for (const entry of this._entries.values()) {
      if (entry.widget.sessionId === sessionId) target = entry.widget
    }
    if (!target) return false
    target.focusInput()
    return true
  }

  // The popover gates its commands on the *focused* widget, so a blurred input
  // that still has its popover open (state survives blur) does not steal the
  // keys — only when it regains focus does `acpPromptPopupVisible` flip back on.
  setPopoverOpen(widget: AcpChatWidget, open: boolean): void {
    const entry = this._entries.get(widget)
    if (!entry || entry.popoverOpen === open) return
    entry.popoverOpen = open
    this._recomputePopupKey()
  }

  private _unregister(widget: AcpChatWidget): void {
    const entry = this._entries.get(widget)
    if (!entry) return
    widget.container.removeEventListener('focusin', entry.onFocusIn)
    widget.container.removeEventListener('focusout', entry.onFocusOut)
    this._entries.delete(widget)
    if (this._lastFocusedWidget === widget) {
      this._lastFocusedWidget = undefined
    }
    this._recomputeKey()
    this._recomputePopupKey()
  }

  private _setFocused(widget: AcpChatWidget, focused: boolean): void {
    const entry = this._entries.get(widget)
    if (!entry) return
    if (entry.focused === focused) return
    entry.focused = focused
    if (focused) {
      this._lastFocusedWidget = widget
    }
    this._recomputeKey()
    this._recomputePopupKey()
  }

  private _recomputeKey(): void {
    let any = false
    for (const entry of this._entries.values()) {
      if (entry.focused) {
        any = true
        break
      }
    }
    this._key.set(any)
  }

  private _recomputePopupKey(): void {
    let visible = false
    for (const entry of this._entries.values()) {
      if (entry.focused && entry.popoverOpen) {
        visible = true
        break
      }
    }
    this._popupKey.set(visible)
  }
}
