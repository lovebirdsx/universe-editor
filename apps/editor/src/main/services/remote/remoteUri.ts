/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Thin re-export — the helpers now live in platform so the renderer can reuse
 *  them without reaching into the main process.
 *--------------------------------------------------------------------------------------------*/

import { REMOTE_SCHEME, URI, normalizeRemoteAuthority } from '@universe-editor/platform'

export { remoteFsPathToUri, remotePathFromUri } from '@universe-editor/platform'

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
