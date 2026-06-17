/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-boundary DnD payload via the standard `text/uri-list` MIME type, the
 *  same wire format VSCode uses. Pure string handling — no Electron/DOM-host
 *  dependency beyond the passed-in DataTransfer — so internal drags can be
 *  received by other panels, external apps, and the OS alike.
 *--------------------------------------------------------------------------------------------*/

const URI_LIST_MIME = 'text/uri-list'

// In-app drags also publish this private MIME. Some platforms map the standard
// `text/uri-list` to a single-URL native clipboard format (e.g. Windows
// CFSTR_INETURL); a multi-entry list then arrives on the drop side glued into a
// single line (`file:///a…file:///b…`), and there is no reliable way to split
// same-scheme URIs back apart lexically. A private type is opaque to the OS and
// round-trips verbatim, so internal multi-resource drags survive intact. The
// standard type is still written for external apps / the OS.
const INTERNAL_URI_LIST_MIME = 'application/vnd.universe-editor.uri-list'

/**
 * Write `uris` as a `text/uri-list` payload (CRLF-separated per RFC 2483) plus a
 * private mirror that survives the OS clipboard round-trip and a `text/plain`
 * mirror (newline-joined) so drops onto plain-text targets (terminal, external
 * editors) still receive the paths.
 */
export function writeUriList(dataTransfer: DataTransfer, uris: readonly string[]): void {
  if (uris.length === 0) return
  dataTransfer.setData(URI_LIST_MIME, uris.join('\r\n'))
  dataTransfer.setData(INTERNAL_URI_LIST_MIME, uris.join('\n'))
  dataTransfer.setData('text/plain', uris.join('\n'))
}

/**
 * Read the dropped URIs, preferring our private type (which round-trips intact)
 * and falling back to the standard `text/uri-list` for external / OS sources.
 */
export function readUriList(dataTransfer: DataTransfer): string[] {
  const internal = dataTransfer.getData(INTERNAL_URI_LIST_MIME)
  if (internal) return parseUriList(internal)
  return parseUriList(dataTransfer.getData(URI_LIST_MIME))
}

/**
 * Parse a `text/uri-list` payload into individual URI strings, skipping blank
 * lines and `#` comment lines (RFC 2483). Splits on any CR / LF combination:
 * RFC 2483 mandates CRLF, but Chromium's OS-file `text/uri-list` can arrive
 * CR-separated, and `/\r?\n/` would collapse every entry into one.
 */
export function parseUriList(text: string): string[] {
  if (!text) return []
  return text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/**
 * Whether a drag carries droppable resources. During `dragover` browsers
 * forbid reading the data itself, so we can only inspect the type list — `Files`
 * for OS-external drags, `text/uri-list` for our internal cross-panel drags.
 */
export function dragContainsResources(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  const types = Array.from(dataTransfer.types)
  return types.includes('Files') || types.includes(URI_LIST_MIME)
}
