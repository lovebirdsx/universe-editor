/**
 * Budget prediction for the background reconcile scan: decide whether a
 * directory would outlast its `reconcile -n` batch budget BEFORE the batch is
 * spawned, so the scan enqueues the subdirectories instead of running a parent
 * batch that is known to be doomed (the pre-emptive half of the convergence
 * design; the post-hoc slow/timeout split in `runReconcileScan` stays as the
 * backstop).
 *
 * Two priors, used in precedence order:
 *  - Warm: the previous scan's measured elapsed ms for the same directory,
 *    persisted on its result checkpoint. A measurement, not a guess — it wins
 *    in both directions (a measured-fast directory is never split on a size
 *    estimate, a measured-slow one is split without a second thought).
 *  - Cold: a local, p4-free file count with early exit
 *    ({@link countLocalFilesUpTo}). Coarse; only consulted when the directory
 *    has never produced a result checkpoint. Deliberately conservative — see
 *    {@link RECONCILE_SCAN_PRESPLIT_FILE_COUNT_THRESHOLD}.
 */
import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { isUnderAny } from './pathUtil.js'

/**
 * Cold-prior pre-split threshold: a never-scanned directory whose local file
 * count exceeds this is split into its subdirectories instead of batched.
 *
 * Deliberately large. The two error directions are not symmetric:
 *  - A false split of a huge-but-CLEAN directory makes every child batch
 *    re-pay the parent's traversal work for zero new drift information — the
 *    same amplification `runReconcileScan` avoids by not splitting
 *    slow-but-clean batches — and the cold prior has no drift signal at all
 *    to justify it.
 *  - A missed split costs one slow batch (or one watchdog timeout) exactly
 *    once: the measured elapsed ms lands on the checkpoint, the warm prior
 *    takes over from the next session, and the existing slow/timeout split
 *    backstops the current one.
 * Measured anchor: a 63k-file focus batch ran ~29s against the default 10s
 * ceiling, so this sits far enough above "one ceiling's worth of files" that
 * only directories clearly over budget pre-split on a cold start.
 */
export const RECONCILE_SCAN_PRESPLIT_FILE_COUNT_THRESHOLD = 100_000

/**
 * Directory budget for one cold-prior walk ({@link countLocalFilesUpTo}):
 * after visiting this many directories without crossing the file threshold
 * the walk gives up and degrades to a normal scan. Directory-heavy,
 * file-light trees (empty asset hierarchies, vendored module folders) never
 * reach the file threshold but would cost one readdir round-trip per
 * directory — minutes on a network share — while p4 wouldn't strain on them
 * either (its batch cost scales with files, not directories). So giving up
 * is the right answer for them, not just a safety valve; a tree that IS over
 * budget reaches the file threshold far before this budget unless it
 * averages under ten files per directory — and such a tree pays at most one
 * slow batch before the warm prior takes over.
 */
export const RECONCILE_SCAN_MAX_COUNTED_DIRECTORIES = 10_000

/** The priors fed to {@link predictReconcileScanBatch}. The caller supplies at
 *  most one kind: a measurement supersedes an estimate. */
export interface ReconcileScanPriors {
  /** Warm prior: the previous scan's elapsed ms for this directory. */
  readonly elapsedMs?: number
  /** Cold prior: local file count under this directory. */
  readonly fileCount?: number
}

export type ReconcileScanPrediction =
  | { readonly action: 'scan' }
  | {
      readonly action: 'split'
      /** Which prior produced the decision — for the log line. */
      readonly reason: 'elapsedMs' | 'fileCount'
      /** The observed prior value (elapsed ms or file count) — for the log line. */
      readonly value: number
    }

/** The split half of {@link ReconcileScanPrediction}, for log helpers that
 *  only ever run on a split decision. */
export type ReconcileScanSplitPrediction = Extract<ReconcileScanPrediction, { action: 'split' }>

const SCAN: ReconcileScanPrediction = { action: 'scan' }

/**
 * Decide scan vs pre-split for a directory about to be batched. Pure.
 *
 * Decision table (ceiling = `perforce.reconcileScan.maxBatchDurationMs`,
 * threshold = {@link RECONCILE_SCAN_PRESPLIT_FILE_COUNT_THRESHOLD}):
 *
 * | elapsedMs | fileCount           | decision                    |
 * | --------- | ------------------- | --------------------------- |
 * | > ceiling | (ignored)           | split — measured slow       |
 * | ≤ ceiling | (ignored)           | scan — measured fits        |
 * | absent    | > threshold         | split — cold size estimate  |
 * | absent    | ≤ threshold/absent  | scan                        |
 *
 * Both comparisons are strictly greater-than, mirroring the post-hoc split
 * (`elapsed > ceiling`) so a batch that lands exactly on the budget stays a
 * normal single batch.
 */
export function predictReconcileScanBatch(
  priors: ReconcileScanPriors,
  maxBatchDurationMs: number,
): ReconcileScanPrediction {
  if (priors.elapsedMs !== undefined) {
    return priors.elapsedMs > maxBatchDurationMs
      ? { action: 'split', reason: 'elapsedMs', value: priors.elapsedMs }
      : SCAN
  }
  if (
    priors.fileCount !== undefined &&
    priors.fileCount > RECONCILE_SCAN_PRESPLIT_FILE_COUNT_THRESHOLD
  ) {
    return { action: 'split', reason: 'fileCount', value: priors.fileCount }
  }
  return SCAN
}

/**
 * Count files under `rootDir` recursively, stopping the walk the moment the
 * count exceeds `ceiling` (the returned value is then exactly `ceiling + 1`).
 * The count is only ever used to cross {@link predictReconcileScanBatch}'s
 * threshold, so an exact total above it is worthless — and the walk itself
 * can be slow (network drives, huge trees), so the prediction must never
 * become its own hang point. Three bounds enforce that:
 *  - the file ceiling above (early exit mid-listing);
 *  - {@link RECONCILE_SCAN_MAX_COUNTED_DIRECTORIES}: a directory-heavy,
 *    file-light tree can't reach the file ceiling yet would otherwise cost
 *    one readdir per directory;
 *  - the scan's abort `signal`: a cancel during the walk degrades like any
 *    other interruption instead of leaving the busy spinner spinning.
 *
 * Directories under `excludeDirs` (when given) are never descended and their
 * files never counted: an excluded subtree is outside the reconcile scope, so
 * its size must not inflate the budget estimate.
 *
 * Symlinked directories and Windows junctions are counted as files, never
 * descended: following them would double-count their targets and, on a
 * junction pointing at an ancestor, walk the cycle forever. Anything readdir
 * can't prove is a plain directory stays on the file side of the ledger —
 * the safe direction for a size estimate.
 *
 * Any readdir failure (root or mid-walk) returns undefined = "cannot judge",
 * which the caller degrades to a normal scan — the same fail-open tolerance
 * `_listSubdirs` applies. One cost stays uncapped by design: a single
 * `readdir` enumerates its whole directory before returning, so a
 * pathological flat directory pays that one listing in full (bounded by the
 * workspace's total file count, and paid once per cold directory).
 */
export async function countLocalFilesUpTo(
  rootDir: string,
  ceiling: number,
  signal?: AbortSignal,
  excludeDirs?: readonly string[],
): Promise<number | undefined> {
  let count = 0
  let directoriesVisited = 0
  const stack: string[] = [rootDir]
  while (stack.length > 0) {
    if (signal?.aborted) return undefined
    if (directoriesVisited >= RECONCILE_SCAN_MAX_COUNTED_DIRECTORIES) return undefined
    const dir = stack.pop()!
    directoriesVisited += 1
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return undefined
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const child = join(dir, entry.name)
        if (excludeDirs && excludeDirs.length > 0 && isUnderAny(child, excludeDirs)) continue
        stack.push(child)
      } else {
        count += 1
        if (count > ceiling) return count
      }
    }
  }
  return count
}
