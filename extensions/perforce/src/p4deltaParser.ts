/**
 * Pure readers for the records a `p4delta --json` run emits. No I/O: the service
 * spawns and streams the lines, this module shapes them into the models the rest
 * of the extension already consumes. The contract is
 * `p4delta/docs/json-contract.md` — the single source of truth for every field
 * read here.
 *
 * The rule that must survive any refactor: a record stream without a
 * `kind:"summary"` record has NO conclusion. {@link summarizeRun} returns
 * undefined for such a stream, and every caller reads that as "no answer — ask
 * the other engine", never as "nothing to report".
 */
import type { P4Action } from './changelist.js'
import type { P4deltaRecord, P4deltaRunResult } from './p4deltaService.js'
import { clientToLocalPath } from './pathUtil.js'
import type { ReconcileFile } from './reconcileParser.js'
import {
  parseSyncOverwriteRefused,
  parseSyncRefused,
  type SyncPreviewFile,
  type SyncRunSummary,
} from './syncParser.js'

/** The three actions δ's `open` mode shares with `p4 reconcile -a -e -d`. */
type ReconcileAction = Extract<P4Action, 'add' | 'edit' | 'delete'>

function isReconcileAction(action: string): action is ReconcileAction {
  return action === 'add' || action === 'edit' || action === 'delete'
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * The drift rows of an `open`-mode run, in the shape the Explorer hints and the
 * "Changes" group already consume — the same {@link ReconcileFile} the native
 * `reconcile -n` parser produces, so both engines feed one comparison path.
 *
 * Only `add` / `edit` / `delete` become rows. δ's open mode also reports the
 * `revert_*` groups (`p4 revert -a` semantics, not part of `reconcile -a -e -d`),
 * the `reopen_*` re-opens and `handoff` records for files it passed to native
 * p4; dropping them is what keeps this list equal to the native engine's, and
 * counting a revert as an edit would invent a change the depot does not have.
 */
export function toReconcileFiles(
  records: readonly P4deltaRecord[],
  clientRoot: string,
): ReconcileFile[] {
  const files: ReconcileFile[] = []
  let skipped = 0
  for (const record of records) {
    if (record['kind'] !== 'file' || record['mode'] !== 'open') continue
    const action = asString(record['action'])
    if (action === undefined || !isReconcileAction(action)) {
      skipped += 1
      continue
    }
    const depotFile = asString(record['depotFile'])
    // The contract guarantees depotFile on every file record; one without it is
    // malformed and has nothing a row could show.
    if (depotFile === undefined) continue
    const clientFile = asString(record['clientFile'])
    files.push({
      depotFile,
      // `clientFile` is client syntax by contract; when δ has no client root it
      // degrades to a local path instead, and clientToLocalPath passes any value
      // that does not start with `//` through untouched — exactly the fallback.
      clientFile: clientFile === undefined ? undefined : clientToLocalPath(clientFile, clientRoot),
      action,
      rev: asString(record['rev']),
    })
  }
  if (skipped > 0) {
    console.error(
      `[perforce] p4delta: dropped ${skipped} file record(s) that are not add/edit/delete`,
    )
  }
  return files
}

/** The conclusion of a run, as the summary record states it. */
export interface P4deltaSummary {
  /** Whether the run has a conclusion. Only an explicit `ok:true` counts. */
  readonly ok: boolean
  /**
   * The mode the run answered in — `open` / `clean` / `sync` by contract.
   * Undefined when the record did not state one; every reader compares it
   * against the mode it asked for, because a summary for another mode answers a
   * question nobody asked.
   */
  readonly mode: string | undefined
  /**
   * Whether the run APPLIED its answer or only previewed it (the contract ties
   * this to `-a`). A write must see `true`: a preview-shaped stream read as
   * success would mark paths handled while nothing on disk or server changed.
   */
  readonly applied: boolean
  /**
   * Whether the run was the FORCE repair that shares this mode. The two are
   * distinguishable only by this boolean — the records and the counts look the
   * same — and a force repair read as {@link toSyncOutcome}'s normal sync would
   * report overwritten local work as an ordinary get.
   */
  readonly force: boolean
  /** `class` → count. Only non-zero classes are emitted; an absent class is 0. */
  readonly counts: Record<string, number>
  readonly total: number
  readonly unmatched: number
  /** `null` on success, `"no-entry-matched"` when every scope entry came up
   *  empty, `"error"` for any other failure. */
  readonly reason: string | null
}

/**
 * The run's conclusion, or undefined when it never reached one. Undefined is the
 * load-bearing answer: a stream without a summary is a run that was killed,
 * crashed or cancelled (contract hard rule 1), so the caller must fall back to
 * the native engine instead of reading the partial records as a complete — or
 * worse, empty — answer.
 */
export function summarizeRun(result: P4deltaRunResult): P4deltaSummary | undefined {
  // Last one wins: a run emits exactly one, and if a buggy build emits two the
  // later one is the newer ledger.
  for (let i = result.records.length - 1; i >= 0; i--) {
    const record = result.records[i]
    if (record === undefined || record['kind'] !== 'summary') continue
    return {
      // `ok` must be exactly true: the contract makes ok:false a partial stream,
      // and a missing ok must not be optimistically read as success.
      ok: record['ok'] === true,
      mode: asString(record['mode']),
      // Same rule as `ok`: only an explicit true proves the run applied.
      applied: record['applied'] === true,
      force: record['force'] === true,
      counts: readCounts(record['counts']),
      total: asNumber(record['total']),
      unmatched: asNumber(record['unmatched']),
      reason: asString(record['reason']) ?? null,
    }
  }
  return undefined
}

function readCounts(raw: unknown): Record<string, number> {
  const counts: Record<string, number> = {}
  if (raw === null || typeof raw !== 'object') return counts
  for (const [klass, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) counts[klass] = value
  }
  return counts
}

/** A δ normal-sync run's answer, in the shapes the get pipeline already reads. */
export interface P4deltaSyncOutcome {
  /** The tally in {@link SyncRunSummary}'s own terms — the caller shows it to the
   *  user verbatim, so the mapping cannot be lossy in either direction. */
  readonly summary: SyncRunSummary
  /** Files the run rewrote, as {@link SyncPreviewFile} rows — the drift rows the
   *  caller may subtract afterwards. `class:"resolve"` records are NOT here: an
   *  opened file's content was not touched. */
  readonly appliedFiles: readonly SyncPreviewFile[]
  readonly refusedFiles: readonly SyncPreviewFile[]
  readonly refusedOverwriteFiles: readonly SyncPreviewFile[]
  /** Nothing was behind: this run had no work to do. Refusals outrank it — a
   *  run that only refused files is not "up to date" (same rule as the native
   *  parser's). */
  readonly upToDate: boolean
}

/** Sync classes that mean content landed on disk. `resolve` is the fourth — an
 *  opened file whose have moved to the target, with its content untouched. */
const APPLIED_SYNC_CLASSES = new Set(['add', 'update', 'delete'])

/** What one sync run's file records say, before any conclusion is drawn. */
interface SyncRecordTally {
  /** Files whose content the run rewrote, in stream order. */
  readonly applied: SyncPreviewFile[]
  /** `class:"resolve"` records: opened files whose have moved to the target. */
  readonly resolve: number
  /** A record outside this mode's class set — the force-repair classes
   *  (`revert`/`restore`), a `handoff`, or something a future build invented.
   *  The stream is then answering a different question than the one asked. */
  readonly foreign: boolean
}

function tallySyncRecords(records: readonly P4deltaRecord[], clientRoot: string): SyncRecordTally {
  const applied: SyncPreviewFile[] = []
  let resolve = 0
  for (const record of records) {
    if (record['kind'] !== 'file' || record['mode'] !== 'sync') continue
    const klass = asString(record['class'])
    if (klass === undefined) return { applied, resolve, foreign: true }
    if (klass === 'resolve') {
      resolve += 1
      continue
    }
    if (!APPLIED_SYNC_CLASSES.has(klass)) return { applied, resolve, foreign: true }
    const row = syncFileRow(record, clientRoot)
    if (row !== undefined) applied.push(row)
  }
  return { applied, resolve, foreign: false }
}

/**
 * The files a δ sync run rewrote, from the records that arrived — for a run
 * that was CANCELLED (no summary, so {@link toSyncOutcome} has no conclusion to
 * give) but whose stream already named what landed. Whatever p4 reported as
 * applied is on disk matching its have revision, so those drift rows are stale
 * exactly as they are after a clean exit.
 *
 * Only `stage:"apply"` records count, and the check is deliberate rather than
 * assumed: the contract says an `-a` run emits apply-segment records only, but
 * this is the one reader whose mistake HIDES local work — a preview record read
 * as applied drops the drift row of a file nothing wrote — so a build that
 * reported its plan on the way in costs a stale row here, not a silent one.
 */
export function appliedSyncFiles(
  records: readonly P4deltaRecord[],
  clientRoot: string,
): SyncPreviewFile[] {
  return tallySyncRecords(
    records.filter((record) => record['stage'] === 'apply'),
    clientRoot,
  ).applied
}

/**
 * Read a δ normal-sync run (`--sync`, no `--force`), or undefined when the
 * stream has no conclusion. Undefined is load-bearing and means the same thing
 * it does for {@link summarizeRun}: the caller must not read partial records as
 * an answer.
 *
 * `applied` is the run the caller ASKED for: true for a real get (`-a`), false
 * for a preview. A summary that does not match it (a build that ignored `-a`, or
 * an answer for the other direction) is not an answer to this question — a
 * preview-shaped stream read as a write would drop drift rows while nothing on
 * disk changed. Same for `force`: this editor never asks δ for a force repair
 * (that spec has no δ form), so one coming back is an answer to another question,
 * and the one question it must never be read as is "your local work is safe".
 *
 * Refusals never reach the records: p4 reports them as per-file messages on
 * stderr (which the engine passes through verbatim under `--json`), so they are
 * read back with the native parser's own regexes. That is what keeps the
 * collect/force remedies identical across the two engines.
 */
export function toSyncOutcome(
  result: P4deltaRunResult,
  clientRoot: string,
  applied: boolean,
): P4deltaSyncOutcome | undefined {
  const summary = summarizeRun(result)
  if (summary === undefined || !summary.ok) return undefined
  if (summary.mode !== 'sync' || summary.applied !== applied || summary.force) return undefined
  const tally = tallySyncRecords(result.records, clientRoot)
  if (tally.foreign) return undefined

  const logText = result.log.join('\n')
  const refusedFiles = parseSyncRefused(logText, clientRoot)
  const refusedOverwriteFiles = parseSyncOverwriteRefused(logText, clientRoot)
  // An opened file whose have moved makes p4 print BOTH "is opened and not being
  // changed" (a skip) and "must resolve #N before submitting" (work left). The
  // engine collapses that pair into one `resolve` record, so it feeds both
  // counters — otherwise a get that needs a resolve stops offering the button
  // for it.
  const keptOpen = tally.resolve
  const mustResolve = tally.resolve
  const refusedModified = refusedFiles.length
  const refusedOverwrite = refusedOverwriteFiles.length
  // `total` is the run's own ledger — in an applied run it counts exactly the
  // records above — so a zero total is the engine saying "no files to sync".
  // Refusals outrank it, same rule as the native parser's.
  const upToDate =
    summary.total === 0 &&
    tally.applied.length === 0 &&
    keptOpen === 0 &&
    refusedModified === 0 &&
    refusedOverwrite === 0
  return {
    summary: {
      applied: tally.applied.length,
      keptOpen,
      mustResolve,
      refusedModified,
      refusedOverwrite,
      upToDate,
      // The ledger claimed work and nothing at all accounts for it — the caller
      // must log that rather than show "0 applied" as a finished get. A refusal
      // IS an account (the file was named, on the other channel), so it keeps
      // this off exactly as it keeps `upToDate` off.
      unrecognized:
        !upToDate &&
        tally.applied.length === 0 &&
        tally.resolve === 0 &&
        refusedModified === 0 &&
        refusedOverwrite === 0,
    },
    appliedFiles: tally.applied,
    refusedFiles,
    refusedOverwriteFiles,
    upToDate,
  }
}

/**
 * One `file` record as a {@link SyncPreviewFile}. `nativeAction` (the verb p4
 * itself printed) is preferred over `action` (the class-derived one) so the
 * preview reads exactly like the native engine's rows; a `resolve` record has
 * neither — it is never a row, see {@link toSyncOutcome}.
 */
function syncFileRow(record: P4deltaRecord, clientRoot: string): SyncPreviewFile | undefined {
  const depotFile = asString(record['depotFile'])
  if (depotFile === undefined) return undefined
  const clientFile = asString(record['clientFile'])
  return {
    depotFile,
    // Client syntax by contract; `clientToLocalPath` passes non-`//` values
    // through, which is exactly the degraded spelling the contract allows.
    clientFile: clientFile === undefined ? undefined : clientToLocalPath(clientFile, clientRoot),
    action: asString(record['nativeAction']) ?? asString(record['action']) ?? '',
    rev: asString(record['rev']) ?? '',
  }
}
