/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Workspace-folder display labels, scheme-aware. A `file:` folder displays as its
 *  local fsPath; a `remote-ssh` folder must NOT leak its `.fsPath` (the server-side
 *  path) as if it were a local path:
 *  - workspaceFullLabel  → full display path for recent menus/descriptions
 *    (scheme-qualified for remote, so equal host paths stay disambiguated);
 *  - workspaceTitleLabel → the title bar / window title's right segment (clean
 *    path only — the remote identity is carried by the window title's "⇄"
 *    marker, not by this segment);
 *  - workspaceParentLabel → the window title's parent segment (server-side parent
 *    path for remote — the remote identity is already expressed by the "⇄"
 *    marker, so the parent segment must not repeat the authority).
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '@universe-editor/platform'

/** Parent segment for the native window title — server-side parent path for remote folders. */
export function workspaceParentLabel(uri: URI): string {
  const parentPath = uri.path.replace(/\/[^/]+\/?$/, '')
  if (uri.scheme === 'file') {
    return uri.with({ path: parentPath }).fsPath
  }
  return parentPath || '/'
}

/** Full display path for recent menus/descriptions (scheme-qualified for remote). */
export function workspaceFullLabel(uri: URI): string {
  if (uri.scheme === 'file') return uri.fsPath
  return uri.toString()
}

/**
 * Right segment of the title bar / window title: the clean path without any
 * scheme prefix — the remote identity is carried by the "⇄" window-title marker.
 */
export function workspaceTitleLabel(uri: URI): string {
  if (uri.scheme === 'file') return uri.fsPath
  return uri.path
}
