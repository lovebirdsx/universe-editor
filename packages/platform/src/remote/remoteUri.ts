/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Remote resource path helpers. With the v2 protocol the server performs URI
 *  translation inside its IPC codec (remote-ssh <-> file), so the client sends
 *  `remote-ssh://<authority>/<path>` resources verbatim and receives remote-ssh
 *  URIs back — there is no toWire/fromWire on the client anymore.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../base/uri.js'
import { REMOTE_SCHEME } from './remoteProtocol.js'

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
