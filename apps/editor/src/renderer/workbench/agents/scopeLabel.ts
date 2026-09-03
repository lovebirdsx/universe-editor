/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure label helpers shared by the session-list scope chip and the chat's
 *  working-directory pill. No DI, no React — just string folding.
 *--------------------------------------------------------------------------------------------*/

/** Collapse a deep relative path to `head/…/tail` so scope labels stay compact. */
export function shortenScopeLabel(rel: string): string {
  const parts = rel.split(/[\\/]+/).filter((s) => s.length > 0)
  if (parts.length <= 1) return rel
  const head = parts[0]!
  const tail = parts[parts.length - 1]!
  return parts.length === 2 ? `${head}/${tail}` : `${head}/…/${tail}`
}

/** Last path segment of an absolute fs path, for a compact directory fallback label. */
export function pathTail(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1]! : p
}
