/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Bridge a `file:` resource URI to a `ue-file:` URL usable as an <img> src.
 *  Shared across processes so the renderer and any tests agree on the mapping.
 *  See main/ipc/imageProtocol.ts for the handler that resolves it back to disk.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'

export const IMAGE_PROTOCOL_SCHEME = 'ue-file'

/**
 * Convert a `file:` URI into a `ue-file://local/...` URL. The path (and its
 * percent-encoding for spaces / unicode / etc.) is carried through verbatim, so
 * `file:///D:/my pics/图.png` becomes `ue-file://local/D:/my%20pics/%E5%9B%BE.png`,
 * which the main-side handler maps straight back to the original file URL.
 */
export function fileUriToImageUrl(resource: URI): string {
  return URI.from({
    scheme: IMAGE_PROTOCOL_SCHEME,
    authority: 'local',
    path: resource.path,
    query: resource.query,
  }).toString()
}

/**
 * Inverse of {@link fileUriToImageUrl}: translate a `ue-file://local/<path>`
 * request URL back into the `file://` URL of the underlying resource. The main
 * protocol handler feeds this straight to `net.fetch`. Percent-escapes are
 * preserved (both URLs share the same encoding), so no decode round-trip runs.
 */
export function imageRequestUrlToFileUrl(requestUrl: string): string {
  const { pathname, search } = new URL(requestUrl)
  return `file://${pathname}${search}`
}
