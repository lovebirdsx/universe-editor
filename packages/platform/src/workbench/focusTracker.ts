/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IFocusTrackerService — global document-level focus observer.
 *
 *  Watches `focusin` / `focusout` events on the document and emits a debounced
 *  `onDidFocusChange` once the focus has settled (one `setTimeout(0)` cycle).
 *  This filters out the transient intermediate state where the previous element
 *  has fired focusout but the next element hasn't yet fired focusin — common
 *  during clicks and Tab navigation.
 *
 *  Renderer-only. Lives in apps/editor; the platform package only exposes the
 *  interface so contributions and services can subscribe without touching DOM.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import type { IDisposable } from '../base/lifecycle.js'
import { createDecorator } from '../di/instantiation.js'

/**
 * Minimal structural type for an element observed by the focus tracker.
 * Matches HTMLElement structurally so platform stays DOM-free.
 */
export interface IFocusableElement {
  contains?(node: unknown): boolean
}

export interface IFocusChangeEvent {
  /** The element that received focus after debounce; null when focus left the window. */
  readonly current: IFocusableElement | null
  /** The element that held focus before this transition. */
  readonly previous: IFocusableElement | null
}

export interface IFocusTrackerService {
  readonly _serviceBrand: undefined

  /** Currently focused element (post-debounce). null if focus is outside the document. */
  readonly current: IFocusableElement | null

  /** Fires once after every focus transition has settled. */
  readonly onDidFocusChange: Event<IFocusChangeEvent>

  /**
   * Subscribe to changes scoped to a given subtree. Listener fires with `true`
   * when focus enters and `false` when it leaves. Returns a disposable.
   */
  trackElement(element: IFocusableElement, listener: (focused: boolean) => void): IDisposable
}

export const IFocusTrackerService = createDecorator<IFocusTrackerService>('focusTrackerService')
