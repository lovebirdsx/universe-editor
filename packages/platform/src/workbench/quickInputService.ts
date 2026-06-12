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
  /**
   * Optional string icon id rendered before the label. Resolved to a concrete
   * icon component by the renderer, keeping the platform layer icon-library free.
   */
  readonly iconId?: string
  /**
   * Optional fixed-width leading column rendered before the label. When set, the
   * row renders as aligned columns: `leadingLabel` (fixed) · `label` (flex,
   * truncates) · trailing icon. Also folded into fuzzy matching. Used by the
   * cross-window session switcher to align the workspace-name column.
   */
  readonly leadingLabel?: string
  /**
   * Optional string id of a trailing status icon, rendered right-aligned after
   * the label/description. Resolved to a concrete icon component by the renderer
   * (distinct from `iconId`'s agent-icon resolver).
   */
  readonly statusIconId?: string
  readonly highlights?: IQuickPickItemHighlights
}

export interface IQuickPickSeparator {
  readonly type: 'separator'
  readonly id: string
  readonly label?: string
  readonly description?: string
}

export interface IQuickItemHighlight {
  readonly start: number
  readonly end: number
}

export interface IQuickPickItemHighlights {
  readonly label?: readonly IQuickItemHighlight[]
  readonly description?: readonly IQuickItemHighlight[]
  readonly detail?: readonly IQuickItemHighlight[]
}

export type QuickPickInput<T extends IQuickPickItem = IQuickPickItem> = T | IQuickPickSeparator

export type QuickPickFilterMode = 'fuzzy' | 'word'
export type QuickPickPresentation = 'default' | 'compact'

/**
 * Modifier keys held at the moment a quick pick item is accepted. Passed as a
 * mutable out-param via `IPickOptions.keyMods`: the service writes the live
 * modifier state into it just before `pick` resolves, so callers can branch
 * (e.g. Ctrl+Enter → open in new window).
 */
export interface IKeyMods {
  ctrl: boolean
  alt: boolean
}

export interface IPickOptions {
  readonly id?: string
  readonly placeholder?: string
  readonly matchOnDescription?: boolean
  readonly matchOnDetail?: boolean
  readonly filterMode?: QuickPickFilterMode
  readonly presentation?: QuickPickPresentation
  /**
   * Optional prefix string identifying the picker's mode (VSCode-style quick
   * access, e.g. ">" for commands). When set, the input is prefilled with this
   * prefix and filtering only happens against the remainder; if the user wipes
   * the prefix away, the list is suppressed and a hint is shown instead.
   */
  readonly prefix?: string
  /** Initial busy state — useful when items are still being computed when `pick` is called. */
  readonly busy?: boolean
  /**
   * Enables VSCode-style "quick navigate" mode: while the configured modifier
   * key remains held, Tab / Shift+Tab cycles focus; releasing the modifier
   * accepts the focused item. Used by Ctrl+Tab editor switching.
   */
  readonly quickNavigate?: {
    readonly modifier: 'ctrl'
    readonly initialSelectionIndex?: number
  }
  /**
   * Mutable out-param. When provided, the service writes the modifier state held
   * at acceptance time into it right before `pick` resolves.
   */
  readonly keyMods?: IKeyMods
  /**
   * When provided, each item gains an inline remove affordance (a ✕ button and
   * the Delete key on the focused item). Invoked without closing the picker;
   * the item is also removed from the visible list locally.
   */
  readonly onItemRemove?: (item: IQuickPickItem) => void
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
  items: readonly QuickPickInput<T>[]
  value: string
  /**
   * Routing/display prefix (e.g. '@', '>'). When set, the panel strips it off the
   * input before filtering and shows a hint if the user deletes it. Defaults to ''.
   */
  prefix: string
  /**
   * Ids of recently-accepted items, most-recent-first. The panel sorts matching
   * items by this order (and marks them) so a quick access mode can surface a
   * "recently used" ranking. Defaults to []. Providers own the persistence.
   */
  mruIds: readonly string[]
  filterExternally: boolean
  /** Panel-side filtering algorithm when `filterExternally` is false. Defaults to 'fuzzy'. */
  filterMode: QuickPickFilterMode
  /** Also match the query against each item's description. Defaults to false. */
  matchOnDescription: boolean
  /** Also match the query against each item's detail. Defaults to false. */
  matchOnDetail: boolean
  presentation: QuickPickPresentation
  /**
   * When true, the picker UI shows an indeterminate progress bar at the top.
   * Used while resolving items asynchronously (search results, dynamic completion, ...).
   */
  busy: boolean

  readonly onDidAccept: Event<T[]>
  readonly onDidHide: Event<void>
  readonly onDidChangeValue: Event<string>
  /**
   * Fires when the focused (active) item changes — on keyboard navigation, mouse
   * hover, or list re-filtering. Carries the active item, or `undefined` when the
   * list is empty / has no selectable item. Used for live preview (e.g. Go to
   * Symbol revealing the symbol as you move through results).
   */
  readonly onDidChangeActive: Event<T | undefined>

  show(): void
  hide(): void
}

export interface IQuickInputService {
  readonly _serviceBrand: undefined

  createQuickPick<T extends IQuickPickItem>(): IQuickPick<T>

  /** Convenience: show a quick pick and resolve with the selected item(s). */
  pick<T extends IQuickPickItem>(
    items: readonly QuickPickInput<T>[],
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
