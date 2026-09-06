/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IFocusableRegistry — viewId → focusable element resolver.
 *
 *  Views register a getter returning the element that should receive focus when
 *  `LayoutService.focusView(viewId)` resolves. The registry is renderer-side
 *  but the interface lives in platform so actions/services can depend on it
 *  without pulling React.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import type { IDisposable } from '../base/lifecycle.js'
import { createDecorator } from '../di/instantiation.js'
import type { IFocusableElement } from './focusTracker.js'

export type FocusableElementGetter = () => IFocusableElement | null

export interface IFocusableRegistrationOptions {
  /**
   * Register as the last-resort target: consulted only when no primary
   * registration resolves to an element. The view container body registers this
   * way so every view is focusable — and therefore enters the focus history —
   * even when it contributes no focusable content of its own (MCP Servers,
   * Output) or renders an empty state before its tree exists (Timeline,
   * Commit Changes). Without it those views can never be switched back to.
   */
  readonly fallback?: boolean
}

export interface IFocusableRegistry {
  readonly _serviceBrand: undefined

  /** Register the focusable element getter for `viewId`. Returns a disposable. */
  register(
    viewId: string,
    getter: FocusableElementGetter,
    options?: IFocusableRegistrationOptions,
  ): IDisposable
  /**
   * Resolve `viewId` to a getter that yields the element to focus, preferring
   * the view's own registration and falling back to its container body.
   * Undefined when nothing is registered at all.
   */
  get(viewId: string): FocusableElementGetter | undefined

  /** Fires when a registration is added or removed. */
  readonly onDidChange: Event<string>
}

export const IFocusableRegistry = createDecorator<IFocusableRegistry>('focusableRegistry')
