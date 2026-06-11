/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorViewStateCache — in-memory store for Monaco editor view states (cursor,
 *  selection, scroll), keyed by `${groupId}:${resourceUri}`. Mirrors VSCode's
 *  IEditorMemento pattern but as a plain singleton for the renderer process.
 *
 *  Lifecycle:
 *   - FileEditor writes on cursor/scroll change and on effect cleanup.
 *   - EditorGroupsService.toJSON() reads via snapshotGroup() for persistence.
 *   - EditorGroupsService.restore() writes via restoreGroup() on session load.
 *--------------------------------------------------------------------------------------------*/

class EditorViewStateCacheImpl {
  private readonly _map = new Map<string, unknown>()

  private _key(groupId: number, uri: string): string {
    return `${groupId}:${uri}`
  }

  private _cursorKey(groupId: number, uri: string): string {
    return `${groupId}:cursor:${uri}`
  }

  save(groupId: number, uri: string, state: unknown): void {
    this._map.set(this._key(groupId, uri), state)
  }

  load(groupId: number, uri: string): unknown | undefined {
    return this._map.get(this._key(groupId, uri))
  }

  /**
   * Last-known cursor position keyed by the *real* file URI, shared across
   * editor types (FileEditor and the DiffEditor's modified side). Lets a switch
   * between a plain editor and a diff editor for the same file carry the cursor
   * over, since their viewState entries live under different keys and have
   * incompatible shapes.
   */
  saveCursor(groupId: number, uri: string, pos: { lineNumber: number; column: number }): void {
    this._map.set(this._cursorKey(groupId, uri), pos)
  }

  loadCursor(groupId: number, uri: string): { lineNumber: number; column: number } | undefined {
    return this._map.get(this._cursorKey(groupId, uri)) as
      | { lineNumber: number; column: number }
      | undefined
  }

  /** Bulk-load states for one group from persisted data (restore phase). */
  restoreGroup(groupId: number, states: Readonly<Record<string, unknown>>): void {
    for (const [uri, state] of Object.entries(states)) {
      this._map.set(this._key(groupId, uri), state)
    }
  }

  /** Return a snapshot of states for the given URIs in a group (toJSON phase). */
  snapshotGroup(groupId: number, uris: readonly string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const uri of uris) {
      const state = this._map.get(this._key(groupId, uri))
      if (state !== undefined) out[uri] = state
    }
    return out
  }

  /** Remove all cached states for a group (e.g. when a group is removed). */
  clearGroup(groupId: number): void {
    const prefix = `${groupId}:`
    for (const key of this._map.keys()) {
      if (key.startsWith(prefix)) this._map.delete(key)
    }
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const EditorViewStateCache = new EditorViewStateCacheImpl()
