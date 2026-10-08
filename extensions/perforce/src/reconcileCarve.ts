/**
 * Carve reconcile filespecs around excluded subtrees.
 *
 * The daily scope's exclusions remove local directories from reconcile
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
 * What this module CANNOT express is an excluded FILE at a level it covers: the
 * level spec is `<dir>/*` (kept as the comment at its push explains) and `*`
 * matches that file too. δ always reports the config file itself as an excluded
 * file, so a config-bearing scope always has one; the guard against running a
 * destructive native call over it lives at the caller
 * (`PerforceClient._nativeFileExcludeReject`, asked by the write path's own
 * admission check `_mutateWrite` → `_nativeCarveReject`) — not here, because a
 * read-only walk (the scan) reaches such a file harmlessly and filters its rows
 * anyway.
 *
 * {@link p4deltaReconcileTargetSpecs} is the δ engine's counterpart: the same
 * targets, nothing carved, because δ takes the exclusions as plain argv in the
 * same call. It is another engine's shape, never a degradation of this one —
 * the red line below still governs every carve path. Which of the two a call
 * site may use is {@link canHandTargetsToP4delta}'s verdict, asked inside
 * {@link PerforceClient._mutateWrite} — on the same reading of the state as the
 * carve it replaces, so an engine that goes away in between cannot hand δ's
 * uncarved targets to p4.
 */
import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { buildLevelFilespec, buildScopeFilespec } from './p4Filespec.js'
import type { SyncScopeTarget } from './p4Filespec.js'
import { containsAny, isUnderAny } from './pathUtil.js'
import { hostPathStyle, isAbsoluteLocalPath } from './scope.js'
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
      // `p4Filespec` follows.
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
 * δ applies the exclusions inside the write call itself (they travel as their
 * own `--exclude-dir` / `--exclude-file` argv), so there is no subtree to carve
 * around, and a carved `<dir>/*` fragment is not a target its grammar reads. The
 * exclusion filter is not optional here: a target the user excluded outright
 * must not be collected or cleaned by either engine — an excluded SUBTREE is the
 * engine's business, the whole entry is not.
 *
 * The result is the ESCAPED spelling, and it is only ever used as the call's
 * `paths` (cache invalidation, labels): the raw targets travel separately as
 * positional argv, so δ escapes at the p4 boundary while the caller's spellings
 * stay unchanged. It is never handed to p4 — a call that does not reach δ takes
 * the carve below instead, built from the same raw targets at the same instant.
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
 * Whether these RAW targets can go to δ without carving.
 *
 * δ reads each positional argv as a literal LOCAL path and escapes it once, at
 * the p4 boundary, so the only shape it cannot take is one that is not a local
 * path at all — a depot spelling (`//depot/...`), which the client routes
 * native. A name containing `@`, `#` or `%` is handed over verbatim: the escape
 * happens at the boundary, which is why a special character no longer forces the
 * operation onto the native carve.
 *
 * Asked inside {@link PerforceClient._mutateWrite}, on the same reading of the
 * state as the branch it selects: a caller CANNOT pre-judge it (an engine that
 * goes away between the caller's read and the write would receive δ's uncarved
 * targets natively, i.e. run straight through the user's exclusions). The write
 * path therefore derives both shapes from one answer — δ's target argv when this
 * is true, the carve when it is not.
 */
export function canHandTargetsToP4delta(targets: readonly SyncScopeTarget[]): boolean {
  const style = hostPathStyle()
  return targets.every((target) => isAbsoluteLocalPath(target.path, style))
}
