/**
 * Parse shelved-file listings for a changelist. Shelved files live on the server
 * separately from opened files; `p4 -Mj describe -S -s <n>` reports them under
 * numbered `depotFile0/1/…` + `action0/1/…` parallel keys in a single JSON
 * record. Pure — the client runs the command, this shapes the record so the
 * quirky parallel-key layout is unit-tested in isolation.
 */
import type { P4Action } from './changelist.js'

/** A file shelved in a changelist (server-side; not on the local filesystem). */
export interface ShelvedFile {
  readonly depotFile: string
  readonly rev: string | undefined
  readonly action: P4Action
}

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

function normalizeAction(raw: unknown): P4Action {
  return typeof raw === 'string' && KNOWN_ACTIONS.has(raw) ? (raw as P4Action) : 'edit'
}

/** Read a parallel-key field (`depotFile0`, `depotFile1`, …) into an ordered
 *  array. `p4 -Mj` emits these as separate keys, not a JSON array. */
function numberedValues(record: Record<string, unknown>, base: string): string[] {
  const out: string[] = []
  for (let i = 0; ; i++) {
    const v = record[`${base}${i}`]
    if (typeof v !== 'string') break
    out.push(v)
  }
  return out
}

/**
 * Parse the single `describe -S` JSON record into shelved files. The `depotFile`
 * parallel keys carry the paths; `rev` and `action` parallel keys align by
 * index. A record with no shelved paths yields an empty list.
 */
export function parseShelved(records: readonly Record<string, unknown>[]): ShelvedFile[] {
  const out: ShelvedFile[] = []
  for (const record of records) {
    const paths = numberedValues(record, 'depotFile')
    const revs = numberedValues(record, 'rev')
    const actions = numberedValues(record, 'action')
    for (let i = 0; i < paths.length; i++) {
      out.push({
        depotFile: paths[i]!,
        rev: revs[i],
        action: normalizeAction(actions[i]),
      })
    }
  }
  return out
}
