/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Single point of URI translation for the remote tunnel. `remote-ssh://<authority>/<path>`
 *  resources are turned into plain `file:` URIs on the way to the server and back;
 *  the server never sees the remote scheme. Never read `.fsPath` on a remote-ssh
 *  URI here or anywhere else — the path is the server host's, not this machine's.
 *--------------------------------------------------------------------------------------------*/

import { REMOTE_SCHEME, URI } from '@universe-editor/platform'

/** remote-ssh → file. The server resolves the path on its own host. */
export function toWire(resource: URI): URI {
  if (resource.scheme !== REMOTE_SCHEME) {
    throw new Error(`remoteUri.toWire: expected ${REMOTE_SCHEME}, got ${resource.scheme}`)
  }
  return URI.from({ scheme: 'file', path: resource.path })
}

/** file → remote-ssh. Reattaches the authority the path came from. */
export function fromWire(wire: URI, authority: string): URI {
  if (wire.scheme !== 'file') {
    throw new Error(`remoteUri.fromWire: expected file, got ${wire.scheme}`)
  }
  return URI.from({ scheme: REMOTE_SCHEME, authority, path: wire.path })
}

/**
 * A server-side filesystem path string (e.g. a watcher event's `path`) → remote-ssh URI.
 * Normalizes backslashes to forward slashes and guarantees a leading slash so the
 * path round-trips through {@link toWire} (Windows `C:\x` becomes `/C:/x`).
 */
export function remoteFsPathToUri(fsPath: string, authority: string): URI {
  let path = fsPath.replace(/\\/g, '/')
  if (!path.startsWith('/')) path = `/${path}`
  return URI.from({ scheme: REMOTE_SCHEME, authority, path })
}
