/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ScrollStateCache — in-memory store for a scroll container's `scrollTop`, keyed
 *  by a caller-chosen string. Sidebar views (Explorer / Scm / Search / Outline /
 *  Extensions) unmount when their container is switched away, dropping the DOM
 *  scroll position; this cache lets a view save it on unmount and restore it on
 *  the next mount. In-memory only — a window reload starts fresh, mirroring the
 *  other view-state caches (AcpChatViewStateCache / EditorViewStateCache).
 *--------------------------------------------------------------------------------------------*/

class ScrollStateCacheImpl {
  private readonly _map = new Map<string, number>()

  save(key: string, scrollTop: number): void {
    this._map.set(key, scrollTop)
  }

  load(key: string): number | undefined {
    return this._map.get(key)
  }

  clear(key: string): void {
    this._map.delete(key)
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const ScrollStateCache = new ScrollStateCacheImpl()
