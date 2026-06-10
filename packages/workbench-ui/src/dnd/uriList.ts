/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-boundary DnD payload via the standard `text/uri-list` MIME type, the
 *  same wire format VSCode uses. Pure string handling — no Electron/DOM-host
 *  dependency beyond the passed-in DataTransfer — so internal drags can be
 *  received by other panels, external apps, and the OS alike.
 *--------------------------------------------------------------------------------------------*/

const URI_LIST_MIME = 'text/uri-list'

/**
 * Write `uris` as a `text/uri-list` payload (CRLF-separated per RFC 2483) plus
 * a `text/plain` mirror (newline-joined) so drops onto plain-text targets
 * (terminal, external editors) still receive the paths.
 */
export function writeUriList(dataTransfer: DataTransfer, uris: readonly string[]): void {
  if (uris.length === 0) return
  dataTransfer.setData(URI_LIST_MIME, uris.join('\r\n'))
  dataTransfer.setData('text/plain', uris.join('\n'))
}

/**
 * Parse a `text/uri-list` payload into individual URI strings, skipping blank
 * lines and `#` comment lines (RFC 2483).
 */
export function parseUriList(text: string): string[] {
  if (!text) return []
  return text
    .split(/\r?\n/)
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
