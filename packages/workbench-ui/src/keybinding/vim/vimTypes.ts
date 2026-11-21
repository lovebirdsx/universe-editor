/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Global Vim mode — DOM-free vocabulary shared by the sequence engine, the
 *  surface registry and the renderer-side dispatcher. Surfaces describe what
 *  they can do; the default keymap maps normalized Vim key tokens onto command
 *  ids that the dispatcher executes.
 *--------------------------------------------------------------------------------------------*/

export type VimSurfaceKind =
  | 'editor'
  | 'list'
  | 'menu'
  | 'overlay'
  | 'tabs'
  | 'activityBar'
  | 'viewContainerTabs'
  | 'terminal'
  | 'webview'

export type VimSurfaceMode = 'normal' | 'insert' | 'terminal-normal'

export type VimDirection = 'up' | 'down' | 'left' | 'right'

export type VimPageDirection = 'up' | 'down'

/**
 * One keymap entry. `keys` uses normalized Vim key tokens (`j`, `G`, `ctrl+d`,
 * `<leader>`); multi-token arrays are sequences (`gg`, `<leader>e`). The last
 * token may be a command, not a prefix. `surfaces` narrows the entry to the
 * listed surface kinds; omitted means every non-editor surface.
 */
export interface IVimKeymapEntry {
  readonly id: string
  readonly keys: readonly string[]
  readonly command: string
  readonly args?: unknown
  readonly when?: string
  readonly surfaces?: readonly VimSurfaceKind[]
}

export interface IVimSurfaceActions {
  readonly move?: (direction: VimDirection, count: number) => void
  readonly first?: (count: number) => void
  readonly last?: (count: number) => void
  readonly page?: (direction: VimPageDirection, count: number) => void
  /**
   * Scroll the viewport without moving the focus / selection. Lists, trees and
   * overlays use this for `Ctrl+E` / `Ctrl+Y`.
   */
  readonly scrollViewport?: (direction: VimPageDirection, count: number) => void
  readonly expand?: (count: number) => void
  readonly collapse?: (count: number) => void
  readonly toggle?: (count: number) => void
  readonly activate?: (count: number, preview: boolean) => void
  readonly contextMenu?: (count: number) => void
  readonly copy?: (count: number) => void
  readonly remove?: (count: number) => void
  readonly next?: (count: number) => void
  readonly previous?: (count: number) => void
  readonly escape?: (count: number) => void
  /**
   * Editor surfaces only. Receives the raw keydown while the surface owns the
   * keyboard; returning true means Vim consumed the stroke. The editor's Vim
   * core owns counts/operators/search, so it bypasses the sequence engine.
   */
  readonly handleStroke?: (event: KeyboardEvent) => boolean
}

export interface IVimSurfaceRegistration {
  readonly id: string
  readonly kind: VimSurfaceKind
  /** Resolved at stroke time so a callback ref mounting later still works. */
  readonly getElement?: (() => HTMLElement | null) | undefined
  /** Defaults to `self` for lists/tabs, `within` for every other kind. */
  readonly focus?: 'self' | 'within' | undefined
  /** Identifies the concrete instance for per-surface mode memory. */
  readonly getSurfaceKey: () => string
  /**
   * Closed / row-less widgets stay registered but must not claim strokes.
   * Read at stroke time so a menu that resolves to zero rows is inert.
   */
  readonly enabled?: boolean | undefined
  readonly defaultMode: VimSurfaceMode
  readonly actions: IVimSurfaceActions
}

const DOM_KEY_TOKENS: Readonly<Record<string, string>> = {
  Escape: 'escape',
  Enter: 'enter',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  ' ': 'space',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
}

export interface VimKeyEventLike {
  readonly key: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
}

/**
 * Canonical Vim key token. Printable characters keep their case and spelling
 * (`g` vs `G`, `/` vs `?`), so `gg` and `G` cannot collide; shift is folded
 * into the character unless another modifier is present (`ctrl+shift+f`).
 * This deliberately differs from `buildKeyString`, which lowercases and always
 * prefixes shift — keymap authors write Vim, not keybindings.json.
 */
export function vimKeyToken(event: VimKeyEventLike): string {
  const special = DOM_KEY_TOKENS[event.key]
  const functional = event.ctrlKey || event.altKey || event.metaKey
  const base = special ?? (functional ? event.key.toLowerCase() : event.key)
  if (!functional && special === undefined) return base
  const parts: string[] = []
  if (event.ctrlKey) parts.push('ctrl')
  if (event.altKey) parts.push('alt')
  if (event.metaKey) parts.push('meta')
  if (event.shiftKey) parts.push('shift')
  parts.push(base)
  return parts.join('+')
}
