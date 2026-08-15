/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Remote resource path helpers. With the v2 protocol the server performs URI
 *  translation inside its IPC codec (remote-ssh <-> file), so the client sends
 *  `remote-ssh://<authority>/<path>` resources verbatim and receives remote-ssh
 *  URIs back — there is no toWire/fromWire on the client anymore.
 *--------------------------------------------------------------------------------------------*/

import { REMOTE_SCHEME, URI, normalizeRemoteAuthority } from '@universe-editor/platform'

/**
 * Canonicalize a remote-ssh URI's authority (WSL distro case-insensitivity). A
 * mixed-case `wsl+<Distro>` recent / deep link collapses onto the same authority
 * the connection manager keys entries by, so re-opening an old workspace does
 * not fork a second connection. Non-remote URIs are returned unchanged.
 */
export function normalizeRemoteUri(uri: URI): URI {
  if (uri.scheme !== REMOTE_SCHEME) return uri
  const authority = normalizeRemoteAuthority(uri.authority)
  return authority === uri.authority ? uri : uri.with({ authority })
}

/**
 * A server-side filesystem path string → remote-ssh URI. This is the ONE
 * documented exception to "paths travel as URIs": watcher event paths are server
 * fsPath strings by design (they never go through the codec's URI transformer),
 * so the client reattaches the authority here.
 * Normalizes backslashes to forward slashes and guarantees a leading slash.
 */
export function remoteFsPathToUri(fsPath: string, authority: string): URI {
  let path = fsPath.replace(/\\/g, '/')
  if (!path.startsWith('/')) path = `/${path}`
  return URI.from({ scheme: REMOTE_SCHEME, authority, path })
}

/**
 * The server-local filesystem path string for a remote resource. A remote-ssh
 * URI encodes a Windows drive letter with a leading slash (`/C:/...`); `URI.fsPath`
 * strips that leading slash (and is a no-op for POSIX paths), so it yields the
 * server host's native path for both POSIX targets and Windows direct-mode. This
 * string is only consumed by services that take bare paths (the watcher subscribe
 * `dir`); every other surface goes through the codec's URI transformer.
 */
export function remotePathFromUri(uri: URI): string {
  if (uri.scheme !== REMOTE_SCHEME) {
    throw new Error(`remoteUri.remotePathFromUri: expected ${REMOTE_SCHEME}, got ${uri.scheme}`)
  }
  return uri.fsPath
}
