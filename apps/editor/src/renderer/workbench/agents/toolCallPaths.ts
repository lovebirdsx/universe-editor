/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Path → URI resolution for tool-call cards. One implementation for the diff
 *  body, the card header's read affordance, the context menu's Open Preview /
 *  Open File, and the `data-uri` stamped on path-bearing buttons — so a path
 *  can never resolve one way in the card and another way in the menu.
 *--------------------------------------------------------------------------------------------*/

import { URI, absolutePathToWorkspaceUri } from '@universe-editor/platform'

/**
 * A path reported by an agent is either already a URI (`scheme://…`, remote
 * agents do this) or a path relative to / absolute within the workspace folder.
 * Non-file folders (a remote workspace) re-root absolute paths onto their own
 * scheme — see {@link absolutePathToWorkspaceUri}.
 */
export function toolCallPathUri(path: string, folder: URI | undefined): URI {
  return path.includes('://') ? URI.parse(path) : absolutePathToWorkspaceUri(path, folder)
}

/** Same resolution, as a string for `data-uri` attributes; `undefined` when the
 *  path is unusable, so the attribute is simply left off. */
export function toolCallPathUriString(path: string, folder: URI | undefined): string | undefined {
  try {
    return toolCallPathUri(path, folder).toString()
  } catch {
    // Malformed agent output — a card without a copyable path beats a crash.
    return undefined
  }
}
