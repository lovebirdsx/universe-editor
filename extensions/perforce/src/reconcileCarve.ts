/**
 * Carve reconcile filespecs around excluded subtrees.
 *
 * `perforce.reconcile.excludeFolders` removes local directories from reconcile
 * discovery. `isUnderAny` alone only answers "is this path excluded?" — this
 * module answers the reverse question and turns it into a spec list: given a
 * directory the caller has already proven is NOT itself excluded, walk it and
 * emit filespecs covering everything except the excluded subtrees. The level
 * itself always gets `<dir>/*`, clean subdirectories get recursive `<sub>/...`,
 * and subdirectories containing excluded descendants are re-carved recursively.
 *
 * Red line: NO failure or degradation branch may ever fall back to `<dir>/...`
 * — that would pull the excluded subtrees back into p4's traversal and break
 * the exclusion promise. Failures return `undefined` (readdir failure / abort /
 * directory budget) and the caller decides whether to skip or surface them.
 */
import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { buildLevelFilespec, buildScopeFilespec } from './p4Filespec.js'
import type { SyncScopeTarget } from './p4Filespec.js'
import { containsAny, isUnderAny } from './pathUtil.js'
import { RECONCILE_SCAN_MAX_COUNTED_DIRECTORIES } from './reconcileScanBudget.js'

export async function carveReconcileFilespecs(
  dir: string,
  excludeDirs: readonly string[],
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  const specs: string[] = []
  let directoriesVisited = 0
  const stack: string[] = [dir]
  while (stack.length > 0) {
    if (signal?.aborted) return undefined
    if (directoriesVisited >= RECONCILE_SCAN_MAX_COUNTED_DIRECTORIES) return undefined
    const current = stack.pop()!
    directoriesVisited += 1
    // The level always gets `<dir>/*`, and this is a correctness requirement,
    // not an optimization: locally deleted files are absent from readdir, so
    // enumerating readdir entries as explicit file specs would make
    // `p4 reconcile -d` blind to deletions on this level.
    specs.push(buildLevelFilespec(current))
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return undefined
    }
    for (const entry of entries) {
      // Plain files need no spec of their own: the level's `/*` covers them.
      if (!entry.isDirectory()) continue
      const child = join(current, entry.name)
      if (isUnderAny(child, excludeDirs)) continue
      const nested = containsAny(child, excludeDirs)
      if (entry.isSymbolicLink()) {
        // Symlinks and Windows junctions (directory + reparse point): never
        // descend ourselves (cycle guard, same criterion as
        // `countLocalFilesUpTo` — a junction pointing at an ancestor would walk
        // forever). A recursive `<child>/...` keeps today's coverage and lets p4
        // decide whether to follow; but when an exclude sits under the link,
        // exclusion wins and the subtree is dropped — we cannot carve a tree we
        // refuse to walk, and widening is the one outcome this module forbids.
        if (!nested) specs.push(buildScopeFilespec(child, true))
        continue
      }
      if (nested) stack.push(child)
      else specs.push(buildScopeFilespec(child, true))
    }
  }
  return specs
}

export interface CarvedReconcileSpecs {
  readonly specs: string[]
  readonly unreadableDirs: string[]
}

export async function carveReconcileTargets(
  targets: readonly SyncScopeTarget[],
  excludeDirs: readonly string[],
  signal?: AbortSignal,
): Promise<CarvedReconcileSpecs> {
  const specs: string[] = []
  const unreadableDirs: string[] = []
  for (const target of targets) {
    if (!target.path) continue
    if (isUnderAny(target.path, excludeDirs)) continue
    if (!target.isDirectory) {
      specs.push(buildScopeFilespec(target.path, false))
      continue
    }
    if (containsAny(target.path, excludeDirs)) {
      const carved = await carveReconcileFilespecs(target.path, excludeDirs, signal)
      if (carved === undefined) {
        unreadableDirs.push(target.path)
      } else {
        specs.push(...carved)
      }
    } else {
      specs.push(buildScopeFilespec(target.path, true))
    }
  }
  return { specs, unreadableDirs }
}
