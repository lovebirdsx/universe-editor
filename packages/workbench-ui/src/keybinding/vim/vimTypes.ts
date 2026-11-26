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
  /** Read-only scrollable content (markdown preview): only scroll keys, the rest passes through. */
  | 'reader'
  | 'webview'

/** Every surface kind, for validating user-authored `surfaces` lists. */
export const VIM_SURFACE_KINDS: readonly VimSurfaceKind[] = [
  'editor',
  'list',
  'menu',
  'overlay',
  'tabs',
  'activityBar',
  'viewContainerTabs',
  'terminal',
  'reader',
  'webview',
]

export type VimSurfaceMode = 'normal' | 'insert' | 'terminal-normal'

export type VimDirection = 'up' | 'down' | 'left' | 'right'

export type VimPageDirection = 'up' | 'down'

/**
 * One keymap entry. `keys` uses normalized Vim key tokens (`j`, `G`, `ctrl+d`,
 * `<leader>`); multi-token arrays are sequences (`gg`, `<leader>e`). The last
 * token may be a command, not a prefix. `surfaces` narrows the entry to the
 * listed surface kinds; omitted means every non-editor surface (plus the editor
 * when the sequence starts with `<leader>`, the only keys it routes here).
 */
export interface IVimKeymapEntry {
  readonly id: string
  readonly keys: readonly string[]
  readonly command: string
  readonly args?: unknown
  readonly when?: string
  readonly surfaces?: readonly VimSurfaceKind[]
  /**
   * Set by the keymap merge for entries a surface declared itself: they only
   * exist while that surface is active, so they win over kind-wide entries.
   */
  readonly scope?: 'surface'
}

/** One which-key row: the next key, already display-formatted, and what it does. */
export interface IVimPendingHintItem {
  readonly key: string
  readonly title: string
  readonly isGroup: boolean
}

/**
 * A surface's own pending prefix (the editor core's `g` / operator / text-object
 * sequences). `prefix` uses the same display spelling as the status bar (`g`, `2d`, `ci`).
 */
export interface IVimPendingHint {
  readonly prefix: string
  readonly items: readonly IVimPendingHintItem[]
}

export interface IVimSurfaceActions {
  readonly move?: (direction: VimDirection, count: number) => void
  /**
   * `gg` / `G`. `count` is 0 when no count was typed (go to the edge) and the
   * typed number otherwise, so `1G` (item 1) and `G` (last item) differ.
   */
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
  /**
   * Returns false when there was nothing to escape (a tree with a single selected
   * row). A side bar / panel view list then hands focus back to the editor; a list
   * inside the editor area hands it to the tab strip, like idle Esc without Vim.
   */
  readonly escape?: (count: number) => boolean | void
  /** `/`: open the host's own filter / find box (type-to-filter trees). */
  readonly find?: () => void
  /**
   * `K`: show the same tooltip a pointer hovering the focused row would show,
   * anchored on that row. Dismissed by the next stroke / focus move.
   */
  readonly showHover?: () => void
  /**
   * Editor surfaces only. Receives the raw keydown while the surface owns the
   * keyboard; returning true means Vim consumed the stroke. The editor's Vim
   * core owns counts/operators/search, so it bypasses the sequence engine.
   */
  readonly handleStroke?: (event: KeyboardEvent) => boolean
  /**
   * Editor surfaces only. True while the editor core waits for a literal
   * character (`r`, `f`/`t`, `"` register name…): the next key — even the leader
   * — is that character and must reach `handleStroke`, not start a leader sequence.
   */
  readonly isAwaitingCharArg?: () => boolean
  /**
   * Editor surfaces only. Called before a mapped modifier chord (`Ctrl+O`) leaves
   * the core for the shared engine: returns the count typed so far (0 = none) and
   * clears the core's prefix, or undefined when the core must keep the stroke
   * (Visual, Insert, no text focus).
   */
  readonly takeCount?: () => number | undefined
  /**
   * Editor surfaces only. Keys that can follow the core's pending prefix, for
   * which-key; undefined when nothing is listable (idle, Insert, a char argument
   * such as `f` / `r` / `"`, a bare count). Read after every stroke, so keep it cheap.
   */
  readonly getPendingHint?: () => IVimPendingHint | undefined
  /**
   * Editor surfaces only. Called when the shared engine takes a stroke the core
   * will not see (leader sequence, mapped chord): a visible Monaco hover must be
   * dismissed explicitly. No-op when nothing is visible.
   */
  readonly dismissHover?: () => void
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
  /**
   * Keys only this surface understands (a settings list's `/`, a graph's
   * search). Merged after the kind-wide table and tried first; `surfaces` is
   * ignored. Keep the array identity stable across renders (module constant or
   * `useMemo`) so the keymap cache is not rebuilt on every stroke.
   */
  readonly keymap?: readonly IVimKeymapEntry[] | undefined
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

const NAMED_KEY_TOKENS: ReadonlySet<string> = new Set(Object.values(DOM_KEY_TOKENS))
const MODIFIER_ORDER = ['ctrl', 'alt', 'meta', 'shift'] as const

/**
 * Why `token` can never be produced by {@link vimKeyToken}, or undefined when
 * it can. Keymap authors (`vim.keymap`) write tokens by hand, so a typo such as
 * `Ctrl+D` or `shift+g` would otherwise bind a key nobody can press.
 */
export function describeInvalidVimToken(token: string): string | undefined {
  if (token === '<leader>') return undefined
  let rest = token
  const modifiers: string[] = []
  let order = 0
  while (rest.length > 1) {
    const index = MODIFIER_ORDER.findIndex((name) => rest.startsWith(`${name}+`))
    if (index < 0) break
    if (index < order) return `modifiers must be written in the order ctrl+alt+meta+shift`
    const name = MODIFIER_ORDER[index]!
    modifiers.push(name)
    order = index + 1
    rest = rest.slice(name.length + 1)
  }
  if (rest.length === 0) return 'empty key'
  const single = [...rest].length === 1
  if (!single && !NAMED_KEY_TOKENS.has(rest)) {
    return `unknown key name '${rest}' (named keys are lowercase: ${[...NAMED_KEY_TOKENS].join(', ')})`
  }
  if (modifiers.length > 0 && single) {
    const functional = modifiers.some((name) => name !== 'shift')
    if (!functional) {
      return `'${token}' is never produced; write the shifted character itself (e.g. 'G')`
    }
    if (rest !== rest.toLowerCase())
      return `with ctrl/alt/meta the key is lowercase ('${rest.toLowerCase()}')`
  }
  return undefined
}
