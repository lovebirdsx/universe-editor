/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IQuickInputService (platform/quickinput/common/quickInput.ts).
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import { IDisposable } from '../base/lifecycle.js'
import { createDecorator } from '../di/instantiation.js'

export interface IQuickPickItem {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly detail?: string
  readonly keybinding?: string
}

export type QuickPickFilterMode = 'fuzzy' | 'word'

export interface IPickOptions {
  readonly id?: string
  readonly placeholder?: string
  readonly matchOnDescription?: boolean
  readonly matchOnDetail?: boolean
  readonly filterMode?: QuickPickFilterMode
  /**
   * Optional prefix string identifying the picker's mode (VSCode-style quick
   * access, e.g. ">" for commands). When set, the input is prefilled with this
   * prefix and filtering only happens against the remainder; if the user wipes
   * the prefix away, the list is suppressed and a hint is shown instead.
   */
  readonly prefix?: string
}

export interface IInputOptions {
  readonly id?: string
  readonly placeholder?: string
  readonly prompt?: string
  readonly value?: string
  readonly validateInput?: (value: string) => string | undefined
}

export interface IQuickPick<T extends IQuickPickItem> extends IDisposable {
  placeholder: string | undefined
  items: readonly T[]

  readonly onDidAccept: Event<T[]>
  readonly onDidHide: Event<void>

  show(): void
  hide(): void
}

export interface IQuickInputService {
  readonly _serviceBrand: undefined

  createQuickPick<T extends IQuickPickItem>(): IQuickPick<T>

  /** Convenience: show a quick pick and resolve with the selected item(s). */
  pick<T extends IQuickPickItem>(
    items: readonly T[],
    options?: IPickOptions,
  ): Promise<T | undefined>

  /** Convenience: show an input box and resolve with the entered text. */
  input(options?: IInputOptions): Promise<string | undefined>

  /**
   * Dismiss the currently visible panel (if any). Fires the panel's
   * `onHide` callback and clears the `quickInputVisible` ContextKey.
   * No-op when nothing is shown.
   */
  hide(): void
}

export const IQuickInputService = createDecorator<IQuickInputService>('quickInputService')
