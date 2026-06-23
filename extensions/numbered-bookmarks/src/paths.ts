import type { UriComponents } from '@universe-editor/extension-api'

/**
 * Internal identity for a document: its URI path with forward slashes. The
 * editor already hands us forward-slashed paths (`/D:/a/b.ts` on Windows,
 * `/home/x/b.ts` on POSIX), so this is stable across the API surface.
 */
export function uriToKey(uri: UriComponents): string {
  return (uri.path ?? '').replace(/\\/g, '/')
}

/** Drop the leading slash that precedes a Windows drive letter (`/D:/a` → `D:/a`). */
export function keyToFsPath(key: string): string {
  return /^\/[A-Za-z]:/.test(key) ? key.slice(1) : key
}
