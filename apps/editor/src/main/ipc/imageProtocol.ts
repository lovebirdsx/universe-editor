/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Custom `ue-file:` protocol — lets the renderer load local images by URL.
 *
 *  The renderer page is served over http (dev) / file (prod) and its CSP forbids
 *  loading arbitrary `file://` resources into <img>. Rather than base64-inline
 *  every image (costly for large pictures), we expose a privileged custom scheme
 *  that maps 1:1 back onto the on-disk file and let Electron's `net.fetch` stream
 *  it with proper mime-type and HTTP range support. This mirrors VSCode's
 *  `vscode-file://vscode-app/...` bridge.
 *
 *  Security: the renderer can already read any file via IFileService.readFile, so
 *  this adds no new capability — it only offers a cheaper transport for bytes the
 *  renderer is already entitled to.
 *--------------------------------------------------------------------------------------------*/

import { net, protocol } from 'electron'
import { IMAGE_PROTOCOL_SCHEME, imageRequestUrlToFileUrl } from '../../shared/imageResource.js'

export { IMAGE_PROTOCOL_SCHEME }

/**
 * Register the custom scheme as privileged. MUST run before `app.whenReady()`
 * (Electron requirement for `registerSchemesAsPrivileged`).
 */
export function registerImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: IMAGE_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false,
      },
    },
  ])
}

/**
 * Wire up the protocol handler. MUST run after `app.whenReady()`.
 */
export function installImageProtocol(): void {
  protocol.handle(IMAGE_PROTOCOL_SCHEME, (request) =>
    net.fetch(imageRequestUrlToFileUrl(request.url)),
  )
}
