/**
 * The graph's local sync ledger: what this editor has itself pulled, per scope.
 *
 * The graph used to learn "where has this workspace got to?" only by asking p4
 * (`p4 changes <scope>#have`), whose cost is the SIZE of the scope — tens of
 * seconds over a wide workspace, re-paid on every load and scope switch. The
 * editor already knows the answer for every get it runs, so it records it here
 * instead and the graph answers from the ledger with zero p4 calls. Only an
 * explicit query (`perforce-graph.getHaveChange`) touches the server again, and
 * its answer overwrites the ledger — truth beats bookkeeping.
 *
 * Storage lives under the extension's `globalStoragePath`, NOT in the p4
 * workspace: it is editor state (and must be shared by every window of the same
 * install), not something a colleague should see in their sync.
 *
 * Coordinates: every record and every lookup is a list of HOST paths plus
 * directory-ness — the shape the call sites already have (`scopePaths` from the
 * graph, the clicked target from the Explorer, a file from the timeline). The
 * graph's own scopes fold into the same space (the opened folder, or the client
 * root for the whole-repo toggle). Filespec strings are deliberately NOT stored:
 * they are post-escaping, post-`<dir>/...`-expansion artifacts that cannot be
 * compared for containment, and mixing them with host paths is how a scope
 * comparison silently goes wrong.
 *
 * All I/O is best-effort, like `P4CacheDisk`: a missing/corrupt file starts
 * empty and a failed write only costs the next session's head start.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { scopeKey } from './pathUtil.js'
import type { SyncScopeTarget } from './p4Filespec.js'

const FILE_NAME = 'graphSyncLedger.json'

/**
 * Upper bound on records. One get writes one record per scope, so a long session
 * over a big tree could otherwise grow this without bound. Oldest `at` loses;
 * the cap is far above any realistic number of distinct scopes a user works in.
 */
const MAX_RECORDS = 200

/**
 * The {@link SyncLedgerRecord.floor} of an operation that cannot leave a file at
 * an older revision than it found it: a get to head only carries files forward
 * (there is nothing newer to fetch), and a read-only query moves nothing at all.
 * Larger than any changelist p4 can hand out, so it outranks every claim a
 * record can make.
 */
export const NO_REGRESSION = Number.MAX_SAFE_INTEGER

/** Where a recorded sync point came from. Slice-compatible with the wire
 *  contract's `P4GraphSyncPointSource`. */
export type SyncLedgerSource = 'sync' | 'query'

/**
 * The changelist of a record that says "a query asked, and this scope has
 * nothing synced" — an empty have list, which is a real answer (a workspace
 * reverted or synced to an older changelist can end up with none).
 *
 * It is recorded rather than deleted so that it can outrank an older, WIDER
 * record: a query that answered "nothing here" must not have the badge silently
 * restored to the wide record's changelist on the next load. (Writing it also
 * retires that wide record outright — see {@link contradictedBy}: the two claims
 * cannot both be true.) `lookupSyncPoint` reports such a winner as "no answer",
 * so the graph falls back to its unknown marker (and, for a scoped history, to
 * the cached empty query).
 */
export const EMPTY_SYNC_POINT = ''

/** One "this scope is synced up to this changelist" fact. */
export interface SyncLedgerRecord {
  /** Client root the scope belongs to. A record never answers for another
   *  client: two workspaces can hold the same host path prefix and mean
   *  different depots. */
  readonly clientRoot: string
  /** The scope exactly as the call site named it (host paths + directory-ness). */
  readonly paths: readonly SyncScopeTarget[]
  /** The changelist this scope is known to be synced to, or
   *  {@link EMPTY_SYNC_POINT} for a queried "nothing synced". */
  readonly change: string
  /** Whether a get recorded this or a query answered it. The graph's tooltip
   *  must say which: a recorded answer says nothing about a sync run outside the
   *  editor since, while a query is the truth as of {@link at}. */
  readonly source: SyncLedgerSource
  /** Epoch ms the answer was established: a get's completion, or when a query
   *  was DISPATCHED (not when it returned — see the write site). */
  readonly at: number
  /**
   * False when the get that produced this record did not land every file at the
   * target revision (p4 refused some, kept an opened file, or needs a resolve).
   * The scope is then only known to be synced AT LEAST this far, so the value is
   * an upper bound and the badge must say so instead of claiming precision.
   */
  readonly complete: boolean
  /**
   * The OLDEST changelist this operation can have left a file at, i.e. how far
   * back it was able to push one.
   *
   * A get to `@CL` cannot move a file past CL, so it carries the CL; a get to
   * head carries {@link NO_REGRESSION}. Absent is read as `0` — "anything could
   * have moved" — because a floor that claims too little only costs one query,
   * while one that claims too much leaves a stale over-report answering the
   * badge.
   *
   * Only {@link contradictedBy} reads it, and it is what keeps two scopes that
   * legitimately disagree from cancelling each other. A narrower scope's
   * changelist is NATURALLY lower than that of the wider scope covering it — the
   * wide sync point need never have touched that folder, and `#have` names the
   * newest changelist that did — so a lower number is not by itself evidence of
   * anything. Only an operation that could have carried a file BELOW what an
   * older record claims is evidence against it.
   */
  readonly floor?: number
}

/** Identity of a scope, independent of path order and case policy. */
export function scopeIdentity(paths: readonly SyncScopeTarget[]): string {
  return paths
    .map((p) => `${p.isDirectory ? 'd' : 'f'}:${scopeKey(p.path)}`)
    .sort()
    .join('\n')
}

/** A scope's host paths, for log lines only. */
function describeScope(paths: readonly SyncScopeTarget[]): string {
  return paths.map((p) => `${p.path}${p.isDirectory ? '/' : ''}`).join(', ')
}

function coversPath(outer: SyncScopeTarget, inner: SyncScopeTarget): boolean {
  const o = scopeKey(outer.path)
  // An empty path is not a scope: treating it as a directory would make it cover
  // every absolute path there is (`'' + '/'`). Records carrying one are rejected
  // on read, and nothing may ever be built from one.
  if (o === '') return false
  const i = scopeKey(inner.path)
  // A file covers only itself (and only when the inner side is that same file:
  // a scope naming `X/a.txt` says nothing about a directory `X/a.txt`, which
  // cannot exist anyway).
  if (!outer.isDirectory) return o === i && !inner.isDirectory
  return i === o || i.startsWith(`${o}/`)
}

/**
 * Whether `outer` covers every path of `inner` — i.e. a get over `outer` also
 * moved (at least) everything `inner` names. Pure.
 */
export function scopeCovers(
  outer: readonly SyncScopeTarget[],
  inner: readonly SyncScopeTarget[],
): boolean {
  if (inner.length === 0) return true
  return inner.every((i) => outer.some((o) => coversPath(o, i)))
}

/** Whether the two scopes share a path — same path, or one containing the other.
 *  Pure. */
function scopesMeet(a: readonly SyncScopeTarget[], b: readonly SyncScopeTarget[]): boolean {
  return a.some((x) => b.some((y) => coversPath(x, y) || coversPath(y, x)))
}

/**
 * Whether a NEWER record makes `record`'s claim no longer trustworthy.
 *
 * A record says "everything in this scope is at this changelist", and a later
 * operation over a scope INSIDE it — one it does not cover in turn — is evidence
 * about part of that area without re-establishing the whole of it. Two things
 * have to hold before that evidence counts against the wider claim:
 *
 * 1. The operation could have carried a file BACKWARD, past what `record` claims
 *    (`newer.floor`). Only a get to an older changelist can: a get to head moves
 *    files forward or not at all, and a query moves nothing. Two scopes
 *    answering with different changelists is otherwise NORMAL — a narrower
 *    scope's `#have` reads lower than the sync point covering it whenever that
 *    sync point never touched the folder (the wide get still left the folder's
 *    files at the wide revision; it just never changed them) — so a lower number
 *    on its own is not evidence of anything.
 * 2. It did not re-cover the whole of `record`'s scope. A record fully
 *    re-covered by the newer one is kept — it can never be consulted again (the
 *    newer one wins every lookup it could have answered), so there is nothing to
 *    invalidate.
 *
 * With both, the wider claim is stale and cannot be told apart from the truth
 * from here — deciding properly needs per-file have revisions, i.e. the query
 * this whole mechanism exists to avoid paying for — so the honest answer is "not
 * known" (the graph's `click to query`).
 *
 * A tombstone (`EMPTY_SYNC_POINT`) is the one thing still retired on argument
 * rather than on a floor: "this whole scope has nothing synced" cannot coexist
 * with a wider record saying those files are at a changelist. p4 cannot tell an
 * empty folder apart from an unmapped one, so the wider scope goes back to
 * "click to query" — the safe direction, and one query restores it. Pure.
 */
export function contradictedBy(
  record: SyncLedgerRecord,
  newer: {
    readonly paths: readonly SyncScopeTarget[]
    readonly at: number
    readonly floor?: number
  },
): boolean {
  if (record.at > newer.at) return false
  if (!scopesMeet(record.paths, newer.paths)) return false
  if (scopeCovers(newer.paths, record.paths)) return false
  // A changelist number, or 0 for a tombstone — which is exactly right: "nothing
  // in this scope is synced" sits below every changelist there is.
  const claimed = Number(record.change)
  return Number.isFinite(claimed) && claimed > (newer.floor ?? 0)
}

/** The record that answers for `scope`, plus whether it came from a wider one. */
export interface SyncLedgerAnswer {
  readonly record: SyncLedgerRecord
  /**
   * The answering record's scope is wider than the one asked about, so its
   * changelist is an UPPER BOUND: a wider get also covered changes to files
   * outside `scope`, and the newest of those need not touch `scope` at all.
   * This is the same over-report the whole-repo probe avoids by not narrowing
   * to the client root — it must be labelled, never presented as exact.
   */
  readonly widerScope: boolean
}

/**
 * Pick the record answering for `scope`: among every record whose scope COVERS
 * it (the scope itself plus wider ancestors — never a narrower descendant), the
 * one with the newest timestamp. An {@link EMPTY_SYNC_POINT} winner answers
 * "nothing synced" — reported as "no answer", which is how it stops an older,
 * wider record from putting a changelist back on the badge.
 *
 * By timestamp, not by depth. "Most specific" reads as more precise and is
 * wrong: after `sync A/B@4520` then `sync A@4560`, the answer for `A/B/C` is
 * 4560 from `A`, while the most-specific rule would report 4520 and UNDER-report
 * what is on disk. Pure.
 */
export function lookupSyncPoint(
  records: readonly SyncLedgerRecord[],
  clientRoot: string,
  scope: readonly SyncScopeTarget[],
): SyncLedgerAnswer | undefined {
  // No scope, no question: an empty list is covered by everything (see
  // `scopeCovers`), so without this an empty selection would answer with the
  // newest record of the whole client.
  if (scope.length === 0) return undefined
  const rootKey = scopeKey(clientRoot)
  let best: SyncLedgerRecord | undefined
  for (const record of records) {
    if (scopeKey(record.clientRoot) !== rootKey) continue
    if (!scopeCovers(record.paths, scope)) continue
    if (best === undefined || record.at > best.at) best = record
  }
  if (best === undefined || best.change === EMPTY_SYNC_POINT) return undefined
  // "Wider" is the same containment question read the other way: among the
  // records that answer at all, this one is wider exactly when the asked-about
  // scope does NOT cover every path the record was built from. Comparing
  // identities instead would call a nested selection's exact answer an upper
  // bound — e.g. a record for `[dir]` answering `[dir, dir/f.txt]`, where the
  // get also moved `dir/f.txt` and the changelist is therefore precise.
  return { record: best, widerScope: !scopeCovers(scope, best.paths) }
}

interface LedgerFile {
  version: number
  records: SyncLedgerRecord[]
}

function parseLedger(raw: string): SyncLedgerRecord[] {
  try {
    const parsed = JSON.parse(raw) as Partial<LedgerFile>
    if (!Array.isArray(parsed.records)) return []
    return parsed.records.filter(isRecord)
  } catch {
    return []
  }
}

/** A record must name a real scope: an empty path list (or an empty path inside
 *  one) would cover every scope of the client, so one malformed line could
 *  answer anything. Rejected rather than trusted — the ledger is a plain file in
 *  a directory other tools can reach. */
function isRecord(value: unknown): value is SyncLedgerRecord {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  const paths = r['paths']
  return (
    typeof r['clientRoot'] === 'string' &&
    typeof r['change'] === 'string' &&
    (r['source'] === 'sync' || r['source'] === 'query') &&
    typeof r['at'] === 'number' &&
    typeof r['complete'] === 'boolean' &&
    (r['floor'] === undefined || typeof r['floor'] === 'number') &&
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.every(
      (p) =>
        p !== null &&
        typeof p === 'object' &&
        typeof (p as Record<string, unknown>)['path'] === 'string' &&
        ((p as Record<string, unknown>)['path'] as string).length > 0 &&
        typeof (p as Record<string, unknown>)['isDirectory'] === 'boolean',
    )
  )
}

export class GraphSyncLedger {
  /** mtime+size of the file the in-memory copy came from, so `lookup` can tell
   *  that another window wrote since (see {@link _reloadIfChanged}). */
  private _stamp: string | undefined

  private constructor(
    private readonly _file: string,
    private _records: SyncLedgerRecord[],
    private readonly _log?: (msg: string) => void,
  ) {
    this._stamp = stampOf(_file)
  }

  /**
   * Open (or create) the ledger under `root` — the extension's
   * `globalStoragePath`. Returns undefined when there is no storage configured
   * or the directory cannot be created, so callers degrade to "never records"
   * and the graph falls back to querying.
   */
  static open(root: string, log?: (msg: string) => void): GraphSyncLedger | undefined {
    if (!root) return undefined
    try {
      mkdirSync(root, { recursive: true })
    } catch {
      return undefined
    }
    const file = join(root, FILE_NAME)
    return new GraphSyncLedger(file, readRecords(file), log)
  }

  /** Records the answer for one scope, replacing any earlier record for the same
   *  scope and retiring the ones this answer contradicts
   *  ({@link contradictedBy}). Sync events have no order worth keeping — only the
   *  newest state of each scope is a fact about the workspace. */
  record(record: SyncLedgerRecord): void {
    // Re-read before mutating: another window may have written since we loaded.
    // Entries are tiny and gets are rare, so read-modify-write is cheaper than
    // the bookkeeping a real merge would need. A lost update costs one extra
    // query later, never a wrong answer.
    const merged = readRecords(this._file)
    const id = recordIdentity(record)
    const retired: SyncLedgerRecord[] = []
    const next = merged.filter((r) => {
      if (recordIdentity(r) === id) return false
      if (!contradictedBy(r, record)) return true
      retired.push(r)
      return false
    })
    next.push(record)
    next.sort((a, b) => a.at - b.at)
    while (next.length > MAX_RECORDS) next.shift()
    this._records = next
    this._flush()
    // A retirement clears the badge of a scope the user is usually not looking at
    // (the wider one), and its absence is what the next load there reads as
    // "never asked" — so without this line the ledger keeps no trace of the one
    // change that explains a sync point vanishing from another tab.
    if (retired.length > 0) {
      const gone = retired.map((r) => `#${r.change || '(nothing)'} over ${describeScope(r.paths)}`)
      this._log?.(
        `[perforce] sync ledger: #${record.change || '(nothing)'} over ${describeScope(
          record.paths,
        )} retired ${gone.join(', ')}`,
      )
    }
  }

  /** The answer for `scope`, or undefined when nothing recorded covers it (or
   *  the newest such record says "nothing synced"). Zero p4 calls. */
  lookup(clientRoot: string, scope: readonly SyncScopeTarget[]): SyncLedgerAnswer | undefined {
    this._reloadIfChanged()
    return lookupSyncPoint(this._records, clientRoot, scope)
  }

  /**
   * Record that `scope` has nothing synced — an empty have list, whether a query
   * answered it or a get's read-back did. Outranks an older, WIDER record (which
   * it also retires, see {@link contradictedBy}), so the answer the user just got
   * is not silently undone on the next load. Written as a record rather than a
   * delete so it also outranks records written later but answering from further
   * out.
   */
  recordEmpty(
    clientRoot: string,
    scope: readonly SyncScopeTarget[],
    at: number,
    source: SyncLedgerSource,
  ): void {
    this.record({
      clientRoot,
      paths: scope,
      change: EMPTY_SYNC_POINT,
      source,
      at,
      complete: true,
      // Below every changelist there is, which is what "nothing here is synced"
      // means — and why writing this retires a wider record it touches.
      floor: 0,
    })
  }

  /**
   * Take another window's writes into account. Every window of this install runs
   * its own extension host with its own copy of this object, and the whole point
   * of the file's location is that they share one ledger — a copy loaded at
   * activate would answer another window's get with "nothing recorded" (or with
   * a stale value) for as long as it lives.
   */
  private _reloadIfChanged(): void {
    const stamp = stampOf(this._file)
    if (stamp === this._stamp) return
    this._records = readRecords(this._file)
    this._stamp = stamp
  }

  private _flush(): void {
    const payload: LedgerFile = { version: 1, records: this._records }
    // Per-process temp name: two windows writing at the same moment would
    // otherwise share one `.tmp`, and whoever renames second would either
    // publish the other's bytes under its own stamp or fail outright.
    const tmp = `${this._file}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this._file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      renameSync(tmp, this._file)
      this._stamp = stampOf(this._file)
    } catch (err) {
      this._log?.(`[perforce] sync ledger write failed: ${(err as Error).message}`)
    }
  }
}

/** Cheap change detector for the ledger file: mtime + size. */
function stampOf(file: string): string | undefined {
  try {
    const s = statSync(file)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return undefined
  }
}

function recordIdentity(record: {
  readonly clientRoot: string
  readonly paths: readonly SyncScopeTarget[]
}): string {
  // JSON framing, not a separator character: a host path may contain any
  // separator a naive join would pick, and two different (root, scope) pairs
  // colliding here would answer one scope with another's changelist.
  return JSON.stringify([scopeKey(record.clientRoot), scopeIdentity(record.paths)])
}

function readRecords(file: string): SyncLedgerRecord[] {
  if (!existsSync(file)) return []
  try {
    return parseLedger(readFileSync(file, 'utf8'))
  } catch {
    // Unreadable — start empty. The next record rewrites the file.
    return []
  }
}
