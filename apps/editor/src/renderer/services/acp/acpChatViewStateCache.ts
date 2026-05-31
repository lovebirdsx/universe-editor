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

export interface AcpChatViewState {
  scrollTop: number
  stuck: boolean
  focusedKey: string | null
  collapse?: AcpChatCollapseState
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
