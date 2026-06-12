/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownPreviewViewStateCache — in-memory store for a markdown preview's scroll
 *  position, keyed by source document URI. The preview editor is fully unmounted
 *  when its tab is switched away (EditorGroupView renders only the active editor),
 *  so without this the scroll position resets to the top on every return. Mirrors
 *  AcpChatViewStateCache.
 *--------------------------------------------------------------------------------------------*/

export interface MarkdownPreviewViewState {
  scrollTop: number
}

class MarkdownPreviewViewStateCacheImpl {
  private readonly _map = new Map<string, MarkdownPreviewViewState>()

  save(key: string, state: MarkdownPreviewViewState): void {
    this._map.set(key, state)
  }

  load(key: string): MarkdownPreviewViewState | undefined {
    return this._map.get(key)
  }

  clear(key: string): void {
    this._map.delete(key)
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const MarkdownPreviewViewStateCache = new MarkdownPreviewViewStateCacheImpl()
