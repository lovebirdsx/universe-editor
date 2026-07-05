/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpChatViewStateCache — in-memory store for the ACP ChatScroll view state
 *  (scroll position, bottom-stick flag, focused timeline item), keyed by session
 *  id. Mirrors EditorViewStateCache but scoped per session so switching editor
 *  tabs or sessions and coming back restores the scroll + selection instead of
 *  resetting to the bottom.
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

class AcpChatViewStateCacheImpl {
  private readonly _map = new Map<string, AcpChatViewState>()

  save(sessionId: string, state: AcpChatViewState): void {
    this._map.set(sessionId, state)
  }

  load(sessionId: string): AcpChatViewState | undefined {
    return this._map.get(sessionId)
  }

  clear(sessionId: string): void {
    this._map.delete(sessionId)
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const AcpChatViewStateCache = new AcpChatViewStateCacheImpl()
