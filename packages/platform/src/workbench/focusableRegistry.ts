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

export interface IFocusableRegistry {
  readonly _serviceBrand: undefined

  /** Register the focusable element getter for `viewId`. Returns a disposable. */
  register(viewId: string, getter: FocusableElementGetter): IDisposable
  /** Resolve a registered getter; undefined when no view is registered. */
  get(viewId: string): FocusableElementGetter | undefined

  /** Fires when a registration is added or removed. */
  readonly onDidChange: Event<string>
}

export const IFocusableRegistry = createDecorator<IFocusableRegistry>('focusableRegistry')
