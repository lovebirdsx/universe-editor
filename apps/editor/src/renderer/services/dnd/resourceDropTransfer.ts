/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reads resources out of a drop event regardless of origin: OS-external files
 *  (mapped via `webUtils.getPathForFile`, exposed on `window.ipc`) and our own
 *  cross-panel drags (the `text/uri-list` payload written by `useDragHandle`).
 *  Pure helpers shared by every drop target (Explorer / Editor / Terminal /
 *  Session), so the per-target wiring only decides what to *do* with the URIs.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'
import { parseUriList } from '@universe-editor/workbench-ui'

/**
 * Extract the dropped resources as URIs. OS-external files take priority (they
 * also expose a `text/uri-list`, but the file handles give us a real fs path);
 * otherwise we fall back to our own `text/uri-list` payload. Deduped by URI.
 */
export function readDroppedResources(e: { dataTransfer: DataTransfer | null }): URI[] {
  const dt = e.dataTransfer
  if (!dt) return []

  const out: URI[] = []
  const seen = new Set<string>()
  const push = (uri: URI): void => {
    const key = uri.toString()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(uri)
    }
  }

  if (dt.files.length > 0) {
    for (const file of Array.from(dt.files)) {
      const fsPath = window.ipc.getPathForFile(file)
      if (fsPath) push(URI.file(fsPath))
    }
  }

  if (out.length === 0) {
    for (const line of parseUriList(dt.getData('text/uri-list'))) {
      try {
        push(URI.parse(line))
      } catch {
        // skip malformed entries
      }
    }
  }

  return out
}

/**
 * Quote a path for safe insertion at a terminal prompt: wrap in double quotes
 * when it contains whitespace, preserving the platform-native separators
 * (Windows backslashes are kept as-is).
 */
export function formatPathForTerminal(fsPath: string): string {
  return /\s/.test(fsPath) ? `"${fsPath}"` : fsPath
}

/**
 * Resolve the `@`-mention name + resource URI for a dropped file. Files inside
 * the workspace use their forward-slash relative path (matching
 * `mentionFileSearch`); anything else falls back to the absolute path so the
 * agent can locate files outside the current workspace.
 */
export function toMentionName(uri: URI, workspaceRoot?: URI): { uri: string; name: string } {
  const resource = uri.toString()
  if (workspaceRoot && uri.scheme === workspaceRoot.scheme) {
    const rel = relativeUnder(workspaceRoot, uri)
    if (rel) return { uri: resource, name: rel }
  }
  return { uri: resource, name: uri.fsPath }
}

function relativeUnder(root: URI, uri: URI): string | undefined {
  const base = root.path.endsWith('/') ? root.path : root.path + '/'
  // Path comparison is case-insensitive on Windows; the length is identical
  // either way, so we can slice by the original prefix length.
  if (uri.path.toLowerCase().startsWith(base.toLowerCase()) && uri.path.length > base.length) {
    return uri.path.slice(base.length)
  }
  return undefined
}
