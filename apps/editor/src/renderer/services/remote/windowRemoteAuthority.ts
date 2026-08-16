/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Window-level remote authority derivation — the renderer mirror of the main
 *  process' deriveWindowRemoteAuthority(). `currentRemoteAuthority` is the single
 *  entry point answering "which remote-ssh authority is this window scoped to":
 *  the current workspace folder when remote, otherwise the window's argv authority
 *  (an empty remote window created via "New Window" carries it), otherwise
 *  undefined. A local workspace is always a local window — it never falls back to
 *  the argv authority.
 *--------------------------------------------------------------------------------------------*/

import { REMOTE_SCHEME, normalizeRemoteAuthority, type URI } from '@universe-editor/platform'

/** remote-ssh authority carried by the window's argv (empty remote window); undefined in e2e/tests where `window.ipc` is absent. */
export function windowArgvRemoteAuthority(): string | undefined {
  const authority = typeof window !== 'undefined' ? window.ipc?.remoteAuthority : undefined
  return authority ? normalizeRemoteAuthority(authority) : undefined
}

/** remote-ssh authority of the given workspace folder, or undefined for a local folder / no folder. */
export function remoteAuthorityFromWorkspace(
  current: { folder: URI } | null | undefined,
): string | undefined {
  if (!current) return undefined
  const folder = current.folder
  if (folder.scheme !== REMOTE_SCHEME) return undefined
  return folder.authority ? normalizeRemoteAuthority(folder.authority) : undefined
}

/**
 * The window's current remote-ssh authority. A non-null workspace wins (its
 * folder is self-describing); only an empty window falls back to the argv
 * authority so a remote window's "New Window" keeps its remote context.
 */
export function currentRemoteAuthority(
  current: { folder: URI } | null | undefined,
): string | undefined {
  if (current === null || current === undefined) return windowArgvRemoteAuthority()
  return remoteAuthorityFromWorkspace(current)
}
