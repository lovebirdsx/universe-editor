/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpChatViewStateCache — in-memory store for the ACP ChatScroll view state
 *  (scroll position, bottom-stick flag, focused timeline item), keyed by session
 *  id. Mirrors EditorViewStateCache but scoped per session so switching editor
 *  tabs or sessions and coming back restores the scroll + selection instead of
 *  resetting to the bottom.
 *
 *  Also remembers which *surface* inside the chat last held keyboard focus
 *  (prompt input vs. timeline) — separately from the scroll view state, which
 *  persist() replaces wholesale on every scroll: an editor-tab round trip
 *  remounts the chat, and the focus restore needs the value the moment the new
 *  instance renders, before the outgoing instance's unmount flush runs.
 *--------------------------------------------------------------------------------------------*/

export type CollapseMode = 'default' | 'collapsed' | 'expanded'

export interface AcpChatCollapseState {
  /** Baseline cycled by Ctrl+Alt+F. */
  mode: CollapseMode
  /** Per-item explicit overrides (Alt+F / chevron click); serialized Map. */
  overrides: ReadonlyArray<readonly [string, boolean]>
}

/**
 * Logical scroll anchor: the slot at the top of the viewport plus the pixel
 * offset into it. Survives a coordinate-system change (estimated → measured
 * heights) that a raw `scrollTop` cannot — on restore we resolve the slot's
 * current offset and re-add `offset`, landing on the same message rather than
 * the same pixel.
 */
export interface AcpChatAnchor {
  key: string
  offset: number
}

/**
 * Per-slot measured row heights (keyed by slotKey, the virtualizer's item key),
 * captured before unmount and fed back as `initialMeasurementsCache` so the
 * remounted virtualizer reconstructs the exact same total size / row offsets
 * instead of falling back to coarse estimates. This is what stops the scrollbar
 * from jumping and the "scrolled to bottom → switch away → switch back lands in
 * the middle" regression for already-visited sessions.
 */
export interface AcpChatMeasurement {
  key: string
  size: number
}

export interface AcpChatViewState {
  scrollTop: number
  stuck: boolean
  focusedKey: string | null
  collapse?: AcpChatCollapseState
  anchor?: AcpChatAnchor
  measurements?: ReadonlyArray<AcpChatMeasurement>
  /**
   * Keys whose *inner* content the user expanded — a long user message past its
   * max-height clamp, an execute tool call's terminal output. Distinct from
   * `collapse.overrides` (the outer per-slot fold); persisted so the expansion
   * survives an unmount → remount cycle instead of snapping back to the clamp.
   */
  contentExpandedKeys?: readonly string[]
}

/**
 * Sessions whose scroll state is kept. A state carries the virtualizer's per-slot
 * measurement array, which grows with the timeline, so an entry is not free even though
 * the value looks like UI trivia.
 */
const MAX_VIEW_STATES = 16

/**
 * Which surface inside the chat holds keyboard focus. `'prompt'` is the session
 * input; everything else inside the chat (message cards, the scroll container
 * Alt+J/K navigate, card buttons) counts as `'timeline'` — the surface a
 * focus restore falls back to when the input isn't where the user left off.
 */
export type AcpFocusSurface = 'prompt' | 'timeline'

/** Insert into a bounded LRU map, refreshing the entry's recency on every write. */
function lruSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_VIEW_STATES) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}

class AcpChatViewStateCacheImpl {
  private readonly _map = new Map<string, AcpChatViewState>()
  private readonly _focusSurfaces = new Map<string, AcpFocusSurface>()

  save(sessionId: string, state: AcpChatViewState): void {
    lruSet(this._map, sessionId, state)
  }

  load(sessionId: string): AcpChatViewState | undefined {
    return this._map.get(sessionId)
  }

  loadFocusSurface(sessionId: string): AcpFocusSurface | undefined {
    return this._focusSurfaces.get(sessionId)
  }

  setFocusSurface(sessionId: string, surface: AcpFocusSurface): void {
    // Written even when the surface is unchanged: every focus event inside a
    // chat is a use of that session, so it must refresh the LRU (a session whose
    // surface stays 'timeline' would otherwise be the first one evicted).
    lruSet(this._focusSurfaces, sessionId, surface)
  }

  clear(sessionId: string): void {
    this._map.delete(sessionId)
    this._focusSurfaces.delete(sessionId)
  }

  _resetForTests(): void {
    this._map.clear()
    this._focusSurfaces.clear()
  }
}

export const AcpChatViewStateCache = new AcpChatViewStateCacheImpl()
