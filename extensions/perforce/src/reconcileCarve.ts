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
 *
 * {@link p4deltaReconcileTargetSpecs} is the δ engine's counterpart: the same
 * targets, nothing carved, because δ takes the exclusions as scope entries in
 * the same call. It is another engine's shape, never a degradation of this one
 * — the red line below still governs every carve path. Which of the two a call
 * site may use is {@link canHandTargetsToP4delta}'s verdict, and it has to be
 * asked at the call site: the raw paths exist nowhere else.
 */
import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
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
      // Join with `/`, never `node:path.join`: join normalizes the WHOLE string,
      // so on Windows it would flip the caller's forward slashes to backslashes
      // and the level spec (`<dir>/*`, spelled as handed in) and this child spec
      // would leave the same call in two spellings. A path on its way back to p4
      // as a filespec is only ever appended to, never re-spelled — the same rule
      // `p4deltaScopeEntry` and `p4Filespec` follow.
      const child = `${current.replace(/[/\\]+$/, '')}/${entry.name}`
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

/**
 * The δ counterpart of {@link carveReconcileTargets}: the same targets turned
 * into the same recursive / bare filespecs, with the same excluded entries
 * dropped — but NOTHING carved.
 *
 * δ applies the exclusions inside the write call itself (they travel as
 * `-`-prefixed scope entries alongside the specs), so there is no subtree to
 * carve around, and a carved `<dir>/*` fragment is not an entry its scope
 * grammar reads. The exclusion filter is not optional here: a target the user
 * excluded outright must not be collected or cleaned by either engine — an
 * excluded SUBTREE is the engine's business, the whole entry is not.
 */
export function p4deltaReconcileTargetSpecs(
  targets: readonly SyncScopeTarget[],
  excludeDirs: readonly string[],
): string[] {
  const specs: string[] = []
  for (const target of targets) {
    if (!target.path) continue
    if (isUnderAny(target.path, excludeDirs)) continue
    specs.push(buildScopeFilespec(target.path, target.isDirectory))
  }
  return specs
}

/**
 * p4 filespec metacharacters, as one verdict for "this RAW path spells
 * differently on the two engines". δ reads its scope entries literally (the
 * contract makes deciding that the consumer's rule) while native p4
 * re-interprets these, so the δ spelling of such a path is not a spec the other
 * engine reads as the same path. Also the client's routing/reject criterion, so
 * the two layers cannot drift apart.
 */
export const P4DELTA_SCOPE_METACHARS = /[@#*%;]/

/**
 * Whether the command layer may hand these targets to δ WITHOUT carving.
 *
 * δ applies the exclusions inside the same call — which is why the δ branch is
 * uncarved at all — but "uncarved" is only safe while δ is the engine that
 * actually runs. The client keeps a degrade-to-native guard for specs δ cannot
 * read (`_p4deltaWriteSpecReject`), and that guard carries no way back to the
 * raw paths: it sees the escaped spec list, so it can neither carve nor
 * re-derive the exclusions. Hand it a metacharacter-bearing target's δ spelling
 * and the call lands on native p4 with the exclusions applied by nobody — under
 * `p4 clean` that deletes inside a directory the user explicitly excluded,
 * irreversibly.
 *
 * The raw paths exist only at the carve fork, so this is the one place the
 * decision can be made: metachar-free targets go over uncarved, everything else
 * takes the carve path (whose products are native-only shapes by construction —
 * `<dir>/*` and escaped names — so the guard routes them where they belong).
 */
export function canHandTargetsToP4delta(targets: readonly SyncScopeTarget[]): boolean {
  return targets.every((target) => !P4DELTA_SCOPE_METACHARS.test(target.path))
}
