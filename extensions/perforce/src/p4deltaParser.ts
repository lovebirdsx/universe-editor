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
