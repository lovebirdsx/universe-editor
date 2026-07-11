/**
 * Parse the records produced by `p4 -Mj opened` and `p4 -Mj changes -s pending`
 * into the changelist domain model. Pure — the p4Service produces the raw
 * records, this shapes them, and changelist.ts groups them. Kept separate so the
 * field-name quirks of p4's output are unit-tested in isolation.
 *
 * `p4 opened` JSON fields of interest: `depotFile`, `clientFile`, `change`
 * ('default' or a number), `action`, `rev`, and `unresolved` (present when the
 * file needs resolving). Field presence varies by server version, so every read
 * is defensive.
 */
import type { OpenedFile, P4Action, PendingChangelist } from './changelist.js'
import { clientToLocalPath } from './pathUtil.js'

const KNOWN_ACTIONS: ReadonlySet<string> = new Set([
  'edit',
  'add',
  'delete',
  'branch',
  'integrate',
  'move/add',
  'move/delete',
  'import',
  'archive',
  'purge',
])

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function normalizeAction(raw: string | undefined): P4Action {
  if (raw && KNOWN_ACTIONS.has(raw)) return raw as P4Action
  return 'edit'
}

/** Parse one `p4 opened` JSON record into an OpenedFile, or undefined if it
 *  carries no depot path (not an opened-file record).
 *
 *  `p4 opened` reports `clientFile` in *client syntax* (`//clientName/rel`), NOT a
 *  local OS path — only `fstat` reports a local `clientFile`. Passing `clientRoot`
 *  translates it to the on-disk path so downstream readFile / file: URIs work; when
 *  omitted (tests feeding local paths directly) the value is kept verbatim. */
export function parseOpenedRecord(
  record: Record<string, unknown>,
  clientRoot?: string,
): OpenedFile | undefined {
  const depotFile = asString(record['depotFile'])
  if (!depotFile) return undefined
  const change = asString(record['change']) ?? 'default'
  const rawClientFile = asString(record['clientFile'])
  const clientFile =
    rawClientFile && clientRoot ? clientToLocalPath(rawClientFile, clientRoot) : rawClientFile
  return {
    depotFile,
    clientFile,
    changelist: change === 'default' ? 'default' : change,
    action: normalizeAction(asString(record['action'])),
    rev: asString(record['rev']),
    // p4 reports unresolved either as an `unresolved` field or an `ourLock`/
    // resolve marker; the plain `unresolved` field is the portable signal.
    unresolved: record['unresolved'] !== undefined,
  }
}

export function parseOpened(
  records: readonly Record<string, unknown>[],
  clientRoot?: string,
): OpenedFile[] {
  const out: OpenedFile[] = []
  for (const r of records) {
    const file = parseOpenedRecord(r, clientRoot)
    if (file) out.push(file)
  }
  return out
}

/** Parse one `p4 changes -s pending` JSON record into a PendingChangelist. */
export function parsePendingRecord(record: Record<string, unknown>): PendingChangelist | undefined {
  const id = asString(record['change'])
  if (!id) return undefined
  return { id, description: asString(record['desc']) ?? '' }
}

export function parsePending(records: readonly Record<string, unknown>[]): PendingChangelist[] {
  const out: PendingChangelist[] = []
  for (const r of records) {
    const c = parsePendingRecord(r)
    if (c) out.push(c)
  }
  return out
}
