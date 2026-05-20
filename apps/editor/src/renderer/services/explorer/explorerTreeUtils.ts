/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  explorerTreeUtils — pure URI helpers used by ExplorerTreeService.
 *
 *  Kept separate so the service file focuses on tree state + IFileService /
 *  IFileWatcherService orchestration. These helpers compare URIs by their
 *  string form on purpose: the renderer receives URIs across an IPC boundary,
 *  so reference equality cannot be relied on.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'

export function parentOf(resource: URI): URI | null {
  const path = resource.path
  const slash = path.lastIndexOf('/')
  if (slash <= 0) return null
  const parentPath = path.slice(0, slash)
  return URI.from({
    scheme: resource.scheme,
    authority: resource.authority,
    path: parentPath,
  })
}

export function isDescendant(root: URI, target: URI): boolean {
  if (root.scheme !== target.scheme) return false
  if (root.authority !== target.authority) return false
  const rootPath = root.path.endsWith('/') ? root.path : root.path + '/'
  const targetPath = target.path
  return targetPath === root.path || targetPath.startsWith(rootPath)
}

export function dedupe(resources: readonly URI[]): URI[] {
  const seen = new Set<string>()
  const out: URI[] = []
  for (const r of resources) {
    const k = r.toString()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

export function sameUri(a: URI | null, b: URI | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.toString() === b.toString()
}

export function sameUriList(a: readonly URI[], b: readonly URI[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.toString() !== b[i]!.toString()) return false
  }
  return true
}
