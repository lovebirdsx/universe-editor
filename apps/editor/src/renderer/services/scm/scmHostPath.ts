/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  scmHostPath — "does this resource live on the host the SCM providers run on,
 *  and if so, what is its path there?"
 *
 *  The SCM wire contract carries bare host fs-path strings (the extension host
 *  only knows its own host's paths), so every SCM lookup keys on a host path, not
 *  a URI. Resolving a resource to that key therefore has to be host-scoped, not
 *  scheme-scoped: a remote window can also hold local `file:` editors, and a
 *  Windows remote's `C:\repo\a.ts` is a different file from the client's own
 *  `C:\repo\a.ts` — matching on the path alone would paint one host's git state
 *  onto the other's files. This is the inverse of platform's fsPathToWorkspaceUri.
 *--------------------------------------------------------------------------------------------*/

import { REMOTE_SCHEME, normalizeRemoteAuthority, type URI } from '@universe-editor/platform'

/**
 * The host-native path of `resource` when it lives on the window's SCM host,
 * otherwise undefined. `remoteAuthority` is the window's current remote-ssh
 * authority (undefined for a local window), e.g. from `useRemoteAuthority()` or
 * `currentRemoteAuthority(workspace.current)`.
 *
 * `URI.fsPath` is scheme-agnostic apart from stripping a drive letter's leading
 * slash, so it yields the server host's native path for both POSIX remotes
 * (`/home/u/repo/a.ts`) and Windows remotes (`/C:/repo` → `C:/repo`) — exactly
 * the path space the remote extension host reports.
 */
export function scmHostPath(
  resource: URI,
  remoteAuthority: string | undefined,
): string | undefined {
  if (remoteAuthority === undefined) {
    return resource.scheme === 'file' ? resource.fsPath : undefined
  }
  if (resource.scheme !== REMOTE_SCHEME || !resource.authority) return undefined
  // Both sides are normalized: WSL distro names are case-insensitive, and an
  // un-normalized authority once made the same host look like two connections.
  const onHost =
    normalizeRemoteAuthority(resource.authority) === normalizeRemoteAuthority(remoteAuthority)
  return onHost ? resource.fsPath : undefined
}
