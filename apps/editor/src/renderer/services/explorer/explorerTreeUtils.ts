/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  explorerTreeUtils — pure URI helpers used by ExplorerTreeService.
 *
 *  Kept separate so the service file focuses on tree state + IFileService /
 *  IFileWatcherService orchestration. These helpers compare URIs by their
 *  string form on purpose: the renderer receives URIs across an IPC boundary,
 *  so reference equality cannot be relied on. That only works while there is
 *  one canonical spelling per resource, which is what `normalizeUri` is for.
 *--------------------------------------------------------------------------------------------*/

import { URI, canonicalizeFileUri } from '@universe-editor/platform'

/**
 * Canonical form of a resource URI for every comparison this module makes — see
 * {@link canonicalizeFileUri}, which folds the Windows drive letter the same way
 * a workspace folder URI is folded. Tree URIs therefore share one spelling with
 * the folder they live under, so an effort that derives a file's identity from
 * the root (the Ctrl+P listing does) agrees with the one the Explorer opens.
 */
export function normalizeUri(uri: URI): URI {
  return canonicalizeFileUri(uri)
}

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
  const rootPath = normalizeUri(root).path
  const rootPrefix = rootPath.endsWith('/') ? rootPath : rootPath + '/'
  const targetPath = normalizeUri(target).path
  return targetPath === rootPath || targetPath.startsWith(rootPrefix)
}

/**
 * Workspace-relative, forward-slash path of `child` under `root` (no leading
 * slash). Returns '' when child === root and the unchanged path when `child`
 * lies outside `root`.
 */
export function relativeTo(root: URI, child: URI): string {
  const rootPath = normalizeUri(root).path
  const rootPrefix = rootPath.endsWith('/') ? rootPath : rootPath + '/'
  const cp = normalizeUri(child).path
  if (cp === rootPath) return ''
  if (cp.startsWith(rootPrefix)) return cp.slice(rootPrefix.length)
  return child.path
}

export function dedupe(resources: readonly URI[]): URI[] {
  const seen = new Set<string>()
  const out: URI[] = []
  for (const r of resources) {
    const k = normalizeUri(r).toString()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

export function sameUri(a: URI | null, b: URI | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return normalizeUri(a).toString() === normalizeUri(b).toString()
}

export function sameUriList(a: readonly URI[], b: readonly URI[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (normalizeUri(a[i]!).toString() !== normalizeUri(b[i]!).toString()) return false
  }
  return true
}
