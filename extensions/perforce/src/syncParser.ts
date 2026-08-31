/**
 * Parsers for `p4 sync` / `p4 resolve` output. Pure — the p4Service runs the
 * commands, these shape the text, and the client turns the summaries into user
 * feedback. `p4 sync -n` (dry-run preview) reports structured records; a real
 * `p4 sync` prints one plain-text line per file, and `p4 resolve -am` prints
 * merge transcripts that mix landed and skipped files even when it exits 0 —
 * hence the two counters in {@link ResolveRunSummary}.
 *
 * Verified against P4D 2024.2 (see `e2e/fixtures/PROBE-FINDINGS.md`).
 */

import { clientToLocalPath } from './pathUtil.js'

/**
 * One file `p4 sync -n` (dry-run) would touch.
 *
 * Unlike `p4 opened` / `p4 reconcile -n`, sync's `clientFile` is already a
 * **local** path (`E:\ws\a.cpp`) — measured, not assumed. `clientRoot` is still
 * threaded through {@link clientToLocalPath}, which passes non-`//` values back
 * verbatim, so the field is correct either way and a future server that switches
 * to client syntax doesn't reintroduce the phantom-delete class of bug.
 */
export interface SyncPreviewFile {
  /** Depot path, e.g. `//depot/branch_x/a.cpp`. */
  readonly depotFile: string
  /** Local filesystem path, when known (from `clientFile`). */
  readonly clientFile: string | undefined
  /** What the sync would do: updated / added / deleted / refreshing. */
  readonly action: string
  /** Target revision, when reported. */
  readonly rev: string
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** Parse one `sync -n` JSON record, or undefined when it carries no depot path. */
export function parseSyncPreviewRecord(
  record: Record<string, unknown>,
  clientRoot?: string,
): SyncPreviewFile | undefined {
  const depotFile = asString(record['depotFile'])
  if (!depotFile) return undefined
  const rawClientFile = asString(record['clientFile'])
  const clientFile =
    rawClientFile && clientRoot ? clientToLocalPath(rawClientFile, clientRoot) : rawClientFile
  return {
    depotFile,
    clientFile,
    action: asString(record['action']) ?? '',
    rev: asString(record['rev']) ?? '',
  }
}

export function parseSyncPreview(
  records: readonly Record<string, unknown>[],
  clientRoot?: string,
): SyncPreviewFile[] {
  const out: SyncPreviewFile[] = []
  for (const r of records) {
    const file = parseSyncPreviewRecord(r, clientRoot)
    if (file) out.push(file)
  }
  return out
}

/**
 * The untruncated total of files a `sync -n` would act on, from the
 * `totalFileCount` key — or undefined on servers that don't emit it.
 *
 * Measured on P4D 2024.2: the key appears in the FIRST file record only, as
 * ONE grand total across every filespec (two-scope probe under `-m 501`:
 * 463 truncated records, a single `totalFileCount 1941` line). It counts
 * every file the sync would touch or refuse — the structured records PLUS
 * the plain `- can't update modified file` / `- added as` lines (measured
 * 297 = 259 records + 38 plain lines) — and `-m` truncates the records,
 * never this total. Last value wins defensively; the measured shape has
 * exactly one.
 */
export function parseSyncPreviewTotal(
  records: readonly Record<string, unknown>[],
): number | undefined {
  let total: number | undefined
  for (const r of records) {
    const v = asString(r['totalFileCount'])
    if (v === undefined) continue
    const n = Number(v)
    if (Number.isInteger(n) && n >= 0) total = n
  }
  return total
}

/**
 * Tally of a real `p4 sync` run, split so the caller can show what actually
 * happened instead of a bare "done".
 */
export interface SyncRunSummary {
  /** Files successfully updated on disk (updated/added/deleted/refreshing). */
  readonly applied: number
  /** Files p4 skipped because they are open (`is opened and can't be replaced`). */
  readonly keptOpen: number
  /** Files p4 reported as needing a resolve first (`must resolve`). */
  readonly mustResolve: number
  /**
   * True when p4 reported `file(s) up-to-date.`. Measured on P4D 2024.2: this
   * arrives on **stderr with exit 0** — nothing to do, not a failure.
   */
  readonly upToDate: boolean
  /** stdout had content but no line was recognized — the caller must log it. */
  readonly unrecognized: boolean
}

// `refreshed`/`updating` are older-server spellings of the same disk-applied
// outcome as `refreshing`/`updated`. NOTE: a clobber refusal prints the same
// `- updating <local>` line before failing (PROBE-FINDINGS §11.8), so that line
// is counted as applied even though nothing landed — accepted because the error
// path (`classifySyncError`) never reads this summary; the count is log-only
// inflation there.
const APPLIED_LINE = / - (updated|added|deleted|refreshing|refreshed|updating)( as)? /i
const KEPT_OPEN_LINE = /is opened and (can't be replaced|not being changed)/i
const MUST_RESOLVE_LINE = / must resolve /i
const UP_TO_DATE_LINE = /file\(s\) up-to-date/i

export function parseSyncOutput(stdout: string, stderr: string): SyncRunSummary {
  let applied = 0
  let keptOpen = 0
  let mustResolve = 0
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (APPLIED_LINE.test(line)) applied++
    else if (KEPT_OPEN_LINE.test(line)) keptOpen++
    else if (MUST_RESOLVE_LINE.test(line)) mustResolve++
  }
  const upToDate = UP_TO_DATE_LINE.test(`${stdout}\n${stderr}`)
  const unrecognized =
    stdout.trim() !== '' && applied === 0 && keptOpen === 0 && mustResolve === 0 && !upToDate
  return { applied, keptOpen, mustResolve, upToDate, unrecognized }
}

/**
 * Tally of a `p4 resolve -am` run. `-am` exits 0 even when some files are left
 * unresolved — a silent-failure trap — so landed and skipped files are counted
 * separately for the caller to surface.
 */
export interface ResolveRunSummary {
  /** Files that landed automatically (`- copy from` / `- merged` / `- merge
   *  from` / `- ignored`). */
  readonly merged: number
  /** Files still left to resolve (`resolve skipped`). */
  readonly remaining: number
  /** stdout had content but no line was recognized — the caller must log it. */
  readonly unrecognized: boolean
}

// Measured on P4D 2024.2 (PROBE-FINDINGS §11.4): `-am` reports a landed file
// with `- copy from` (accept-theirs/`-at`) or `- merge from` (real auto-merge),
// and `- ignored` when the incoming change is already in the local content —
// all three mean "this file is resolved".
const LANDED_LINE = / - (copy from|merged|merge from|ignored) /i
const SKIPPED_LINE = /resolve skipped/i
// Lines every real transcript carries but that are not an outcome: the per-file
// `<local> - merging <depot>` header and the merge-statistics line. Recognizing
// them keeps `unrecognized` honest — it must fire only for output nothing can
// account for, and a successful -am transcript contains both.
const NOISE_LINE = / - merging\b|^Diff chunks: /i

export function parseResolveOutput(stdout: string): ResolveRunSummary {
  let merged = 0
  let remaining = 0
  let recognized = false
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (LANDED_LINE.test(line)) {
      merged++
      recognized = true
    } else if (SKIPPED_LINE.test(line)) {
      remaining++
      recognized = true
    } else if (NOISE_LINE.test(line)) {
      recognized = true
    }
  }
  const unrecognized = stdout.trim() !== '' && !recognized
  return { merged, remaining, unrecognized }
}
