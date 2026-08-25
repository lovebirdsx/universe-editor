/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Filesystem-backed scheme classification. `file:` and `remote-ssh://...` are
 *  both served by IFileService and must be treated identically by features that
 *  open or track real files (quick open, recent files, …); virtual editor
 *  schemes (universe:, markdown-preview:…) have no on-disk content and must
 *  still be rejected — a resolver fallback would render them as empty text
 *  tabs labelled by a raw guid. Also owns the display form of a
 *  filesystem-backed resource's path (resourceDisplayPath).
 *--------------------------------------------------------------------------------------------*/

import { REMOTE_SCHEME, toDisplayPath, type URI } from '@universe-editor/platform'

export function isFileSystemScheme(scheme: string): boolean {
  return scheme === 'file' || scheme === REMOTE_SCHEME
}

export function isFileSystemUri(uri: URI): boolean {
  return isFileSystemScheme(uri.scheme)
}

/** Display form of a filesystem resource's path: the native path for local
 *  files; a Windows remote's `/E:/…` canonical path renders as `E:\…`
 *  (POSIX paths unchanged). */
export function resourceDisplayPath(uri: URI): string {
  return uri.scheme === 'file' ? uri.fsPath : toDisplayPath(uri.path)
}
