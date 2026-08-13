/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Workspace-folder display labels, scheme-aware. A `file:` folder displays as its
 *  local fsPath; a `remote-ssh` folder must NOT leak its `.fsPath` (the server-side
 *  path) as if it were a local path — it renders as the full scheme-qualified URI
 *  (for recent menus) or as its authority (for the window title's parent segment).
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '@universe-editor/platform'

/** Parent segment for the native window title — authority for remote folders. */
export function workspaceParentLabel(uri: URI): string {
  if (uri.scheme === 'file') {
    const parentPath = uri.path.replace(/\/[^/]+\/?$/, '')
    return uri.with({ path: parentPath }).fsPath
  }
  return uri.authority
}

/** Full display path for recent menus/descriptions (scheme-qualified for remote). */
export function workspaceFullLabel(uri: URI): string {
  if (uri.scheme === 'file') return uri.fsPath
  return uri.toString()
}
