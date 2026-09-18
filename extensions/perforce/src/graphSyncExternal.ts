/**
 * Sync points recorded by tools OUTSIDE this editor.
 *
 * The graph's ledger (`graphSyncLedger.ts`) only knows the gets this editor ran,
 * so a workspace pulled with one of the tools people actually use — the
 * `editor_savior` helper or UGS — reads as "never synced" until someone pays for
 * an explicit `#have` query. Both tools leave a record of what they pulled, and
 * this module turns those files into ledger-shaped records so the very same
 * lookup answers from them, for free:
 *
 * - `<home>/.editor_savior/sync_config.json`: keyed by depot path, one entry per
 *   (stream, client) with `ClientRoot` + `ChangeNum` + `Timestamp`.
 * - `<clientRoot>/.ugs/state.json`: one object with `CurrentChangeNumber` and
 *   `LastSyncTime`, written into the workspace itself.
 *
 * Read-only, always: these files belong to those tools. Nothing here is ever
 * persisted, merged into `_records`, or allowed to retire a ledger record —
 * external records are passed to the lookup as a separate input list, so a
 * corrupt or hand-edited file can never damage what the editor recorded itself.
 *
 * Matching is by CLIENT ROOT, not by the depot path (the savior file's key) nor
 * by `ClientName`: a record's scope here is always the whole client root the
 * tool synced, which is exactly what the ledger's coordinates are made of, and
 * a client root is what the graph resolves a workspace to. A record whose
 * `ClientRoot` is not the client being asked about simply never answers.
 *
 * Every record is stamped `at = the tool's own timestamp`, which is what makes
 * "the external record wins when it is newer" fall out of the ledger's existing
 * newest-wins rule instead of needing a merge of its own.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stampOf, type SyncLedgerRecord } from './graphSyncLedger.js'

const SAVIOR_FILE = join('.editor_savior', 'sync_config.json')
const UGS_FILE = join('.ugs', 'state.json')

/** Overrides the savior file's location. Exists for tests: on a developer's own
 *  machine the real file is there, and an e2e run must not read it. */
export const SAVIOR_CONFIG_ENV = 'UNIVERSE_P4_SAVIOR_CONFIG'

/** Where the savior tool keeps its sync records — under the user's home, NOT in
 *  any workspace. Pure. */
export function saviorConfigPath(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  return env[SAVIOR_CONFIG_ENV] || join(home, SAVIOR_FILE)
}

/** Where UGS keeps its state for `clientRoot`. Unlike the savior file this one
 *  lives INSIDE the workspace, which is also why no match step is needed: being
 *  in that root is the match. Pure. */
export function ugsStatePath(clientRoot: string): string {
  return join(clientRoot, UGS_FILE)
}

/**
 * The one record an external tool can produce: "this whole workspace was synced
 * to `change` at `at`".
 *
 * `at` is clamped to `nowMs` because nothing else guards these records: a
 * timestamp in the future (a skewing clock, a hand-edited file) would outrank
 * every get and every query from here on, and the user's own "Query Sync Point"
 * could not correct the badge any more. What the clamp buys is that everything
 * written AFTER this read still wins, a query the user runs later included. What
 * it costs is the other direction: a skewed stamp lands on the read instant and
 * therefore outranks whatever the ledger wrote before it. Re-clamped on every
 * re-read, i.e. once per rewrite of the file.
 *
 * `floor` is deliberately absent — only `record()` reads it, and external
 * records never go through `record()`.
 */
function externalRecord(
  clientRoot: string,
  change: number,
  at: number,
  nowMs: number,
): SyncLedgerRecord {
  return {
    clientRoot,
    // The whole client root: both tools sync the workspace as a whole, and the
    // ledger's coordinates are host paths plus directory-ness.
    paths: [{ path: clientRoot, isDirectory: true }],
    change: String(change),
    source: 'external',
    at: Math.min(at, nowMs),
    complete: true,
  }
}

/** Positive integer, from a JSON number only — `"4521"` is another tool's bug,
 *  not a changelist to report. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** Positive finite epoch **milliseconds** — the unit both tools write. A stamp
 *  in seconds would pass `> 0` and land in 1970, which loses every comparison
 *  and so reads as "no answer" while still counting as one; nothing else here
 *  can tell the difference, so the contract is spelled out instead. */
function positiveTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Every usable record in an `editor_savior` sync file. Pure.
 *
 * The outer keys are depot paths and are ignored outright: they name the stream
 * rather than anything this editor can compare a workspace against (the ledger
 * has no depot coordinates), and a client root can legitimately appear under
 * several of them — the newest entry then wins the lookup, which is the same
 * rule the tool itself applies when it picks between its own sources.
 *
 * One malformed entry is dropped on its own; it never costs its siblings.
 */
export function parseSaviorSyncConfig(raw: string, nowMs: number): readonly SyncLedgerRecord[] {
  const parsed = parseJsonObject(raw)
  if (!parsed) return []
  const records: SyncLedgerRecord[] = []
  for (const entries of Object.values(parsed)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      const fields = entry as Record<string, unknown>
      const clientRoot = fields['ClientRoot']
      const change = positiveInt(fields['ChangeNum'])
      const at = positiveTime(fields['Timestamp'])
      if (typeof clientRoot !== 'string' || clientRoot === '') continue
      if (change === undefined || at === undefined) continue
      records.push(externalRecord(clientRoot, change, at, nowMs))
    }
  }
  return records
}

/**
 * The record in a UGS state file, if it holds a usable one. Pure.
 *
 * `clientRoot` is the caller's (what p4 reports for this workspace) rather than
 * anything read out of the file: the file's own location IS the workspace, so
 * its `ClientName` is decoration — a client recreated under a new name leaves
 * the files, and the changelist that describes them, exactly where they are.
 *
 * `LastSyncTime` is an ISO string and is the real stamp; a numeric `Timestamp`
 * is only a fallback for a file that does not carry one.
 */
export function parseUgsState(
  raw: string,
  clientRoot: string,
  nowMs: number,
): readonly SyncLedgerRecord[] {
  const parsed = parseJsonObject(raw)
  if (!parsed) return []
  const change = positiveInt(parsed['CurrentChangeNumber'])
  const at = isoTime(parsed['LastSyncTime']) ?? positiveTime(parsed['Timestamp'])
  if (change === undefined || at === undefined) return []
  return [externalRecord(clientRoot, change, at, nowMs)]
}

function isoTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Reads both files, keeping only what changed since the last call — the graph
 * asks for a sync point on every load and every scope switch, and it must stay
 * free of work that the answer does not depend on (the ledger's own
 * `_reloadIfChanged` is the same idea).
 *
 * A missing or unreadable file is simply no records; like the ledger, a broken
 * file must never break the graph, and the only trace is one line per file that
 * may have changed — carrying the path and the count, never the contents (the
 * records name local paths, and nothing here needs them).
 */
export class ExternalSyncPoints {
  private _saviorStamp: string | undefined
  private _saviorRecords: readonly SyncLedgerRecord[] = []
  /** UGS state per client root, keyed by the file path. One entry is all any
   *  real session needs (a window works in one workspace), the map just keeps a
   *  multi-client setup from re-reading on every switch. */
  private readonly _ugs = new Map<
    string,
    { stamp: string | undefined; records: readonly SyncLedgerRecord[] }
  >()

  private constructor(
    readonly saviorFile: string,
    private readonly _log?: (msg: string) => void,
  ) {
    this._saviorRecords = this._parseSavior()
    this._saviorStamp = stampOf(this.saviorFile)
    // Reported here and not only on change: a file that is present but holds
    // nothing usable (fields renamed, changelist written as a string) is the one
    // case worth a line, and on this path it would otherwise never get one — the
    // file simply sits there unchanged for the rest of the session.
    this._report(this.saviorFile, this._saviorRecords.length, this._saviorStamp !== undefined)
  }

  static open(saviorFile: string, log?: (msg: string) => void): ExternalSyncPoints {
    return new ExternalSyncPoints(saviorFile, log)
  }

  /** Every external record for `clientRoot`. Which of them may answer is the
   *  ledger's decision (it owns the client and containment tests), so this does
   *  not pre-filter by root. */
  read(clientRoot: string): readonly SyncLedgerRecord[] {
    const savior = this._readSavior()
    const ugs = this._readUgs(clientRoot)
    if (ugs.length === 0) return savior
    if (savior.length === 0) return ugs
    return [...savior, ...ugs]
  }

  private _readSavior(): readonly SyncLedgerRecord[] {
    const stamp = stampOf(this.saviorFile)
    if (stamp !== this._saviorStamp) {
      this._saviorRecords = this._parseSavior()
      this._saviorStamp = stamp
      this._report(this.saviorFile, this._saviorRecords.length, stamp !== undefined)
    }
    return this._saviorRecords
  }

  private _parseSavior(): readonly SyncLedgerRecord[] {
    return parseSaviorSyncConfig(readText(this.saviorFile), Date.now())
  }

  private _readUgs(clientRoot: string): readonly SyncLedgerRecord[] {
    const file = ugsStatePath(clientRoot)
    const stamp = stampOf(file)
    const cached = this._ugs.get(file)
    if (cached !== undefined && cached.stamp === stamp) return cached.records
    const records = parseUgsState(readText(file), clientRoot, Date.now())
    this._ugs.set(file, { stamp, records })
    this._report(file, records.length, stamp !== undefined)
    return records
  }

  private _report(file: string, count: number, present: boolean): void {
    if (count > 0) {
      this._log?.(`[perforce] sync point: ${count} record(s) from ${file}`)
    } else if (present) {
      // Present but unusable (corrupt, or nothing to read a changelist from) —
      // the case worth a line, because the file looks like an answer and is not.
      this._log?.(`[perforce] sync point: no usable record in ${file}`)
    }
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    // Missing or unreadable — no records, never an error.
    return ''
  }
}
