/**
 * Webview resource addressing — the wire-level constants + pure transform that
 * map a local file path to a URL a sandboxed webview iframe can load. Shared by
 * all three processes so they agree byte-for-byte:
 *   - the extension host computes `webview.asWebviewUri` locally (it must return
 *     synchronously, so no RPC round-trip is possible);
 *   - the renderer's webview host injects the CSP `default-src`/`img-src` origin;
 *   - the main process serves the URL via the `universe-app://` protocol handler.
 *
 * KEEP IN SYNC with `apps/editor/src/main/ipc/resourceProtocol.ts`
 * (`APP_PROTOCOL_SCHEME` / `RESOURCE_PATH_PREFIX`) and the renderer's
 * `workbench/markdown/resourceUri.ts` — same scheme, authority and prefix.
 */

/** The privileged app scheme that serves both the shell and local resources. */
export const WEBVIEW_PROTOCOL_SCHEME = 'universe-app'
/** Single origin shared by shell + resources (a secure scheme isolates by authority). */
export const WEBVIEW_ORIGIN = `${WEBVIEW_PROTOCOL_SCHEME}://root`
/** Path prefix under the origin that addresses an arbitrary allow-listed local file. */
export const WEBVIEW_RESOURCE_PREFIX = '_resource_'

/**
 * Path of the blank bootstrap document a webview iframe navigates to before its
 * HTML is written in. It MUST be a real navigable URL (not `about:blank`): a
 * local-scheme document inherits its creator's CSP, so an `about:blank` iframe
 * would be pinned to the app shell's strict `script-src 'self'` CSP and the
 * extension's own `<meta>` CSP could not loosen it (CSP only tightens). Loading
 * a real same-origin document that ships NO CSP lets the extension's injected
 * CSP take effect after `document.write`.
 *
 * KEEP IN SYNC with `apps/editor/src/main/ipc/resourceProtocol.ts`.
 */
export const WEBVIEW_BLANK_PATH = '_webview_blank_'

/** Full URL of the blank bootstrap document (see {@link WEBVIEW_BLANK_PATH}). */
export const WEBVIEW_BLANK_URL = `${WEBVIEW_ORIGIN}/${WEBVIEW_BLANK_PATH}`

/**
 * Marker on the `postMessage` the renderer's webview host sends into the blank
 * bootstrap document to hand it the extension HTML. The renderer cannot
 * `document.write` the iframe directly: in dev the app shell is served from
 * `http://localhost` while the iframe lives on `universe-app://root`, so the two
 * are cross-origin ("Can only call open() on same-origin documents"). Instead the
 * blank doc ships a tiny loader that receives this message and does the
 * same-origin write itself.
 *
 * KEEP IN SYNC with the loader embedded in
 * `apps/editor/src/main/ipc/resourceProtocol.ts`.
 */
export const WEBVIEW_SETUP_MARKER = '__universe_webview_setup__'

/** The value a webview should put in its CSP so `asWebviewUri` resources load. */
export const WEBVIEW_CSP_SOURCE = WEBVIEW_ORIGIN

/**
 * Percent-encode an absolute fs path into a
 * `universe-app://root/_resource_/<path>` URL. Mirrors `toResourceUrl` in the
 * renderer's `resourceUri.ts`: back-slashes are normalized, each segment is
 * `encodeURIComponent`-escaped, and a leading slash is ensured.
 */
export function fsPathToWebviewUrl(fsPath: string): string {
  const forward = fsPath.replace(/\\/g, '/')
  const encoded = forward
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  const leading = encoded.startsWith('/') ? '' : '/'
  return `${WEBVIEW_ORIGIN}/${WEBVIEW_RESOURCE_PREFIX}${leading}${encoded}`
}
