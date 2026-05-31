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
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  IContextKeyService,
  toDisposable,
  type IContextKey,
  type IDisposable,
} from '@universe-editor/platform'

export type AcpTimelineMoveDirection = 'next' | 'prev'

export type AcpTimelineScrollTarget = 'top' | 'bottom' | 'pageUp' | 'pageDown'

export interface AcpChatWidget {
  readonly container: HTMLElement
  moveTimeline(direction: AcpTimelineMoveDirection): void
  scrollTimeline(target: AcpTimelineScrollTarget): void
  focusInput(): void
}

export interface IAcpChatWidgetService {
  readonly _serviceBrand: undefined
  readonly lastFocusedWidget: AcpChatWidget | undefined
  register(widget: AcpChatWidget): IDisposable
}

export const IAcpChatWidgetService = createDecorator<IAcpChatWidgetService>('acpChatWidgetService')

interface Entry {
  widget: AcpChatWidget
  focused: boolean
  onFocusIn: (e: FocusEvent) => void
  onFocusOut: (e: FocusEvent) => void
}

export class AcpChatWidgetService extends Disposable implements IAcpChatWidgetService {
  declare readonly _serviceBrand: undefined

  private readonly _entries = new Map<AcpChatWidget, Entry>()
  private _lastFocusedWidget: AcpChatWidget | undefined
  private readonly _key: IContextKey<boolean>

  constructor(@IContextKeyService contextKeyService: IContextKeyService) {
    super()
    this._key = contextKeyService.createKey<boolean>('acpChatFocused', false)
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
    const entry: Entry = { widget, focused: false, onFocusIn, onFocusOut }
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
    return toDisposable(() => this._unregister(widget))
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

  override dispose(): void {
    for (const widget of [...this._entries.keys()]) {
      this._unregister(widget)
    }
    super.dispose()
  }
}
