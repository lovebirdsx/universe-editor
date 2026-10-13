/**
 * The `chat` namespace — contributes context sources to the agent input's `#`
 * popover. A provider surfaces one entry item (label + keywords); accepting it
 * runs the provider's own picker (typically `window.showQuickPick`), and the
 * chosen item is inserted into the input box as a reference pill. The
 * open-ended candidate space stays provider-side, mirroring how the built-in
 * `#` sources with large candidate sets behave.
 */
import type { Disposable } from './util.js'

/** One resolved context item, inserted into the agent input. */
export interface ChatContextItem {
  /** Pill text inserted into the input box. */
  label: string
  /**
   * The text block sent to the model. Structured information (ids, paths,
   * urls) MUST live here: the built-in agents discard `resource_link`
   * names/descriptions/_meta, so anything the model needs to see has to be in
   * this string.
   */
  text: string
}

/** Contributes one `#` entry to the agent input's context popover. */
export interface ChatContextProvider {
  /** Entry-item label shown in the `#` popover, e.g. `Perforce Changelist…`. */
  readonly label: string
  /** Optional secondary text on the entry item. */
  readonly description?: string
  /**
   * Optional icon id for the entry item, resolved against the workbench icon
   * table (names like `history` / `changelist` / `git-pull-request`); an
   * unknown id falls back to a generic glyph.
   */
  readonly iconId?: string
  /**
   * Keywords that surface the entry item. Matching is a case-insensitive
   * substring test against the text typed after `#`, applied to these keywords
   * and to `label`; an empty query surfaces every registered provider.
   */
  readonly keywords: readonly string[]
  /**
   * Runs when the user accepts the entry item: show your own picker (usually
   * `window.showQuickPick`) and return the chosen item, or `undefined` when the
   * user cancelled. `query` is the fragment the user typed after `#` that
   * surfaced this entry — one of your keywords, or part of your label; it
   * cannot be an arbitrary search string, since the entry only appears on a
   * match (`#cl` arrives as `'cl'`, `#changelist` as `'changelist'`).
   */
  resolve(query: string): Promise<ChatContextItem | undefined> | ChatContextItem | undefined
}

/** The `chat` namespace. */
export interface ChatApi {
  /**
   * Register a context provider for the agent input's `#` popover. It lives
   * until the returned Disposable is disposed (extensions normally push it onto
   * `context.subscriptions`).
   */
  registerChatContextProvider(provider: ChatContextProvider): Disposable
}
