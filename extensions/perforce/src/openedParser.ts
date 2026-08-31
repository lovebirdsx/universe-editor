/**
 * Parse the records produced by `p4 -Mj opened` and `p4 -Mj changes -s pending`
 * into the changelist domain model. Pure — the p4Service produces the raw
 * records, this shapes them, and changelist.ts groups them. Kept separate so the
 * field-name quirks of p4's output are unit-tested in isolation.
 *
 * `p4 opened` JSON fields of interest: `depotFile`, `clientFile`, `change`
 * ('default' or a number), `action`, `rev`, and `unresolved`. NOTE: measured on
 * P4D 2024.2, `p4 opened` NEVER carries `unresolved` — the authoritative signal
 * lives in `p4 fstat -Ru` (see fstatParser / PROBE-FINDINGS §11.5); the read
 * below is kept as defense for other server versions and is OR'd with the fstat
 * probe by the client. `p4 changes -s pending` adds `change`, `desc` and a bare
 * `shelved` key (present only when the changelist has shelved files). Field
 * presence varies by server version, so every read is defensive.
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
  const openedByUser = asString(record['user'])
  const openedByClient = asString(record['client'])
  return {
    depotFile,
    clientFile,
    changelist: change === 'default' ? 'default' : change,
    action: normalizeAction(asString(record['action'])),
    rev: asString(record['rev']),
    // Kept even though P4D 2024.2 never emits this key (see the module
    // comment): other server versions may, and the client ORs it with the
    // fstat -Ru probe before deciding what needs resolving.
    unresolved: record['unresolved'] !== undefined,
    // `user`/`client` only appear in `p4 opened -a` output; a plain `opened`
    // record reads undefined here on purpose, so the fields don't drift.
    ...(openedByUser !== undefined ? { openedByUser } : {}),
    ...(openedByClient !== undefined ? { openedByClient } : {}),
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

/**
 * Keep only the files someone *else* has open. `myClientName` is this client's
 * name as `p4 info` reports it.
 *
 * Compared by **client**, not by user: the same person working from two
 * workspaces still blocks themselves in the other one, and for a binary game
 * asset that is exactly the collision worth warning about.
 *
 * Records with no `openedByClient` (a plain `p4 opened` without `-a`) are
 * dropped rather than assumed to be someone else's — a missing field is not
 * evidence of a conflict.
 */
export function filterOpenedByOthers(
  files: readonly OpenedFile[],
  myClientName: string,
): OpenedFile[] {
  if (!myClientName) return []
  const mine = myClientName.toLowerCase()
  return files.filter((f) => {
    const owner = f.openedByClient
    return owner !== undefined && owner.toLowerCase() !== mine
  })
}

/** Parse one `p4 changes -s pending` JSON record into a PendingChangelist.
 *
 *  The `shelved` key is reported *bare* (`... shelved` in `-ztag`, i.e. an empty
 *  string value) for changelists that have shelved files and is omitted entirely
 *  for those that don't — verified against P4D 2024.2. So presence, not value, is
 *  the signal; an empty string is truthy-as-present here. Callers use it to avoid
 *  fanning out one `describe -S -s` per pending changelist (a GB-scale, minutes-
 *  long command on huge changelists). */
export function parsePendingRecord(record: Record<string, unknown>): PendingChangelist | undefined {
  const id = asString(record['change'])
  if (!id) return undefined
  return {
    id,
    description: asString(record['desc']) ?? '',
    shelved: record['shelved'] !== undefined,
  }
}

export function parsePending(records: readonly Record<string, unknown>[]): PendingChangelist[] {
  const out: PendingChangelist[] = []
  for (const r of records) {
    const c = parsePendingRecord(r)
    if (c) out.push(c)
  }
  return out
}
