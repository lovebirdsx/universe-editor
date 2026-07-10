/**
 * Pure parsers for the Perforce Graph data source. The client runs the p4
 * commands and feeds the raw records in; these shape them into the graph domain
 * model. No p4 I/O here, so the quirky parallel-key / field-name layout is
 * unit-testable against fixtures (mirrors shelveParser / blameSource).
 *
 * All three inputs are `-Mj` JSON records:
 *  - `changes -s submitted -l`  → one record per change (change/user/client/time/desc)
 *  - `describe -s <n>`          → one record with parallel `depotFile#`/`action#`/`rev#`
 *  - `where <depotFile…>`       → one record per file (depotFile + local `path`)
 *
 * `describe -s` keeps its structured parallel keys under `-Mj` (only the
 * *diff-carrying* describe collapses to a `data` blob — see the p4 skill), so
 * `-Mj` is safe here.
 */
import { descriptionFirstLine } from './changelist.js'

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/** Read a parallel-key field (`depotFile0`, `depotFile1`, …) into an ordered
 *  array. `p4 -Mj` emits repeated fields as separate keys, not a JSON array. */
function numberedValues(record: Record<string, unknown>, base: string): string[] {
  const out: string[] = []
  for (let i = 0; ; i++) {
    const v = record[`${base}${i}`]
    if (typeof v !== 'string') break
    out.push(v)
  }
  return out
}

/** One submitted change from `p4 changes`. */
export interface GraphChangeMeta {
  readonly id: string
  readonly author: string
  readonly client: string
  readonly date: number
  /** Description first line. */
  readonly message: string
}

/** Parse `p4 -Mj changes -s submitted -l` records, newest-first (p4's order). */
export function parseChangesList(records: readonly Record<string, unknown>[]): GraphChangeMeta[] {
  const out: GraphChangeMeta[] = []
  for (const record of records) {
    const id = asString(record['change'])
    if (!id) continue
    out.push({
      id,
      author: asString(record['user']) ?? '',
      client: asString(record['client']) ?? '',
      date: Number(asString(record['time']) ?? 0),
      message: descriptionFirstLine(asString(record['desc']) ?? ''),
    })
  }
  return out
}

/** One file entry inside a change's `describe`. */
export interface GraphDescribeFile {
  readonly depotFile: string
  readonly action: string
  readonly rev: string
}

/** Full detail of one change parsed from `p4 -Mj describe -s <n>`. */
export interface GraphDescribe {
  readonly id: string
  readonly author: string
  readonly client: string
  readonly date: number
  readonly body: string
  readonly files: GraphDescribeFile[]
}

/**
 * Parse the single `describe -s` JSON record into a change detail. The
 * `depotFile`/`action`/`rev` parallel keys align by index. Returns undefined when
 * the record carries no change id.
 */
export function parseChangeDescribe(record: Record<string, unknown>): GraphDescribe | undefined {
  const id = asString(record['change'])
  if (!id) return undefined
  const depotFiles = numberedValues(record, 'depotFile')
  const actions = numberedValues(record, 'action')
  const revs = numberedValues(record, 'rev')
  const files: GraphDescribeFile[] = []
  for (let i = 0; i < depotFiles.length; i++) {
    files.push({
      depotFile: depotFiles[i]!,
      action: actions[i] ?? 'edit',
      rev: revs[i] ?? '',
    })
  }
  return {
    id,
    author: asString(record['user']) ?? '',
    client: asString(record['client']) ?? '',
    date: Number(asString(record['time']) ?? 0),
    body: asString(record['desc'])?.replace(/\n+$/, '') ?? '',
    files,
  }
}

/**
 * Map a p4 action to the single-letter status the renderer's file tree colours
 * (A/M/D/R, mirroring git's name-status letters).
 */
export function statusFromAction(action: string): string {
  switch (action) {
    case 'add':
    case 'branch':
    case 'import':
      return 'A'
    case 'move/add':
      return 'R'
    case 'delete':
    case 'move/delete':
    case 'purge':
      return 'D'
    default:
      return 'M'
  }
}

/**
 * The revision specs to diff for one submitted file, given the status letter and
 * the revision the change created. `left`/`right` are `depotFile#rev` specs; a
 * null side means that revision doesn't exist (added file has no base, deleted
 * file has no target).
 */
export function fileDiffRevs(
  depotFile: string,
  status: string,
  rev: string,
): { left: string | null; right: string | null } {
  const revNum = Number(rev)
  const prev = Number.isFinite(revNum) && revNum > 1 ? `${depotFile}#${revNum - 1}` : null
  const cur = rev ? `${depotFile}#${rev}` : null
  if (status === 'A') return { left: null, right: cur }
  if (status === 'D') return { left: prev, right: null }
  return { left: prev, right: cur }
}

/**
 * Parse `p4 -Mj where <depotFile…>` records into a depotFile → local path map.
 * Success records carry `depotFile` + `path` (the local filesystem path);
 * error records (file not in client view) carry no `path` and are skipped.
 */
export function parseWhereLocalPaths(
  records: readonly Record<string, unknown>[],
): Map<string, string> {
  const out = new Map<string, string>()
  for (const record of records) {
    const depotFile = asString(record['depotFile'])
    const path = asString(record['path'])
    if (depotFile && path) out.set(depotFile, path)
  }
  return out
}

/** Depot path without the leading `//`, for display in the file tree. */
export function displayPath(depotFile: string): string {
  return depotFile.replace(/^\/\//, '')
}
