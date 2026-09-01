/**
 * Parse the records produced by `p4 reconcile -n -a -e -d` (dry-run) into a list
 * of files whose on-disk state has drifted from what the server knows: locally
 * edited but not opened, newly created, or deleted on disk. Pure — the p4Service
 * runs the command, this shapes the records, and the client turns them into the
 * Explorer working-tree hints (`checkWorkingTree`).
 *
 * `p4 reconcile -n` reports each candidate with the same `depotFile` /
 * `clientFile` / `action` / `rev` fields as `p4 opened`, so the field-reading is
 * deliberately close to openedParser. The dry-run `-n` never mutates server
 * state; actually collecting a file is a separate real `p4 reconcile` call.
 *
 * Only files NOT already opened surface here (an opened file's disk edits are
 * already tracked). The client filters those out defensively against its
 * `opened` list, so a race where the same file appears in both never
 * double-lists it.
 */
import type { P4Action } from './changelist.js'
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

/** A file the working tree has diverged on, as reported by `reconcile -n`. */
export interface ReconcileFile {
  /** Depot path, e.g. `//depot/main/foo.txt`. */
  readonly depotFile: string
  /** Local filesystem path (absolute), when known (from `clientFile`). */
  readonly clientFile: string | undefined
  /** The reconcile action p4 would take: edit / add / delete / move/*. */
  readonly action: P4Action
  /** Have/head revision number, when reported (absent for adds). */
  readonly rev: string | undefined
}

/** Parse one `reconcile -n` JSON record into a ReconcileFile, or undefined if it
 *  carries no depot path (informational / non-file record).
 *
 *  Like `p4 opened`, `reconcile -n` reports `clientFile` in *client syntax*
 *  (`//clientName/rel`), not a local OS path — `clientRoot` translates it so the
 *  row's diff/open works; omit it (tests) to keep the value verbatim. */
export function parseReconcileRecord(
  record: Record<string, unknown>,
  clientRoot?: string,
): ReconcileFile | undefined {
  const depotFile = asString(record['depotFile'])
  if (!depotFile) return undefined
  const rawClientFile = asString(record['clientFile'])
  const clientFile =
    rawClientFile && clientRoot ? clientToLocalPath(rawClientFile, clientRoot) : rawClientFile
  return {
    depotFile,
    clientFile,
    action: normalizeAction(asString(record['action'])),
    rev: asString(record['rev']),
  }
}

export function parseReconcile(
  records: readonly Record<string, unknown>[],
  clientRoot?: string,
): ReconcileFile[] {
  const out: ReconcileFile[] = []
  for (const r of records) {
    const file = parseReconcileRecord(r, clientRoot)
    if (file) out.push(file)
  }
  return out
}
