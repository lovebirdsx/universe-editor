/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  scmFocusState — session-scoped, per-repository memory of which sub-target the
 *  SCM view last focused (commit box vs. changes tree) and of the last focused
 *  file row.
 *
 *  ScmProviderView unmounts on a container / repository switch, taking its
 *  TreeModel (and treeModel.focused) with it. This module outlives those
 *  remounts, so returning to Source Control restores the user's context instead
 *  of always grabbing the commit box. Not persisted: a window reload starts
 *  fresh, matching the original default.
 *--------------------------------------------------------------------------------------------*/

export type ScmFocusRegion = 'input' | 'tree'

interface ScmFocusMemoryEntry {
  region: ScmFocusRegion
  /** Host path (resourceUri) of the last focused file row. */
  focusedPath?: string
}

const memory = new Map<string, ScmFocusMemoryEntry>()
// Global rather than per-repo: only one provider is mounted at a time, and a
// request already consumed by one instance must not replay after a remount.
let handledRevealTick = 0

export function getScmFocusRegion(repoKey: string): ScmFocusRegion {
  return memory.get(repoKey)?.region ?? 'input'
}

export function rememberScmFocusRegion(repoKey: string, region: ScmFocusRegion): void {
  const entry = memory.get(repoKey)
  if (entry?.region === region) return
  memory.set(repoKey, {
    region,
    ...(entry?.focusedPath !== undefined ? { focusedPath: entry.focusedPath } : {}),
  })
}

export function getScmFocusedPath(repoKey: string): string | undefined {
  return memory.get(repoKey)?.focusedPath
}

export function rememberScmFocusedPath(repoKey: string, focusedPath: string): void {
  const entry = memory.get(repoKey)
  if (entry?.focusedPath === focusedPath) return
  memory.set(repoKey, { region: entry?.region ?? 'input', focusedPath })
}

export function getHandledScmRevealTick(): number {
  return handledRevealTick
}

export function markScmRevealHandled(tick: number): void {
  if (tick > handledRevealTick) handledRevealTick = tick
}

export function _resetScmFocusStateForTests(): void {
  memory.clear()
  handledRevealTick = 0
}
