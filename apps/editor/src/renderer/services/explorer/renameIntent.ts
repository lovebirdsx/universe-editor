/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  renameIntent — short-lived registry of paths a user-initiated rename/move is
 *  currently rewriting. The file watcher can only report a rename as
 *  "old deleted + new added", so a deletion arriving while the corresponding
 *  rename is in flight must not be mistaken for the file disappearing.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from '@universe-editor/platform'
import type { URI } from '@universe-editor/platform'
import { isDescendant } from './explorerTreeUtils.js'

const _sources: URI[] = []

/** Mark `source` (a file or directory) as being renamed until disposal. */
export function beginRenameIntent(source: URI): IDisposable {
  _sources.push(source)
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      const index = _sources.indexOf(source)
      if (index !== -1) _sources.splice(index, 1)
    },
  }
}

/**
 * True when `deleted` is the source of an in-flight rename, or lies inside a
 * directory being renamed.
 */
export function isRenameIntentSource(deleted: URI): boolean {
  return _sources.some((source) => isDescendant(source, deleted))
}

export function _resetRenameIntentsForTests(): void {
  _sources.length = 0
}
