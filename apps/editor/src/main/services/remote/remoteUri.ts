/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Thin re-export — the helpers now live in platform so the renderer can reuse
 *  them without reaching into the main process.
 *--------------------------------------------------------------------------------------------*/

import {
  canonicalizeFileUri,
  REMOTE_SCHEME,
  URI,
  normalizeRemoteAuthority,
} from '@universe-editor/platform'

export { remoteFsPathToUri, remotePathFromUri } from '@universe-editor/platform'

/**
 * Canonical form of a workspace folder URI. Every producer of a folder identity
 * — Open Folder, a deep link, session restore, the recent list — runs through
 * this before deriving anything from the string (workspace storage bucket,
 * window lookup, tree-state key), so one folder can never fork into two.
 *
 * Two folds today:
 *  - remote-ssh authority case (WSL distro names are case-insensitive), so a
 *    mixed-case `wsl+<Distro>` recent entry collapses onto the authority the
 *    connection manager keys connections by and does not open a second one;
 *  - the Windows drive letter, so a local folder picked by dialog, restored
 *    from a session or typed by hand has a single spelling.
 *
 * A remote Windows host's drive letter is deliberately left alone: the fold
 * would have to travel through the per-connection codec to the server, and the
 * two producers disagree there already (`remoteFsPathToUri` keeps the case it
 * is handed, `absolutePathToWorkspaceUri` folds). Fixing that belongs with the
 * codec, not here.
 */
export function canonicalizeWorkspaceFolderUri(uri: URI): URI {
  return canonicalizeFileUri(
    uri.scheme === REMOTE_SCHEME
      ? uri.with({ authority: normalizeRemoteAuthority(uri.authority) })
      : uri,
  )
}
