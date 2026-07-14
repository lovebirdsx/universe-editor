/**
 * Parse the records produced by `p4 reconcile -n -a -e -d` (dry-run) into a list
 * of files whose on-disk state has drifted from what the server knows: locally
 * edited but not opened, newly created, or deleted on disk. Pure — the p4Service
 * runs the command, this shapes the records, and the client turns them into the
 * "changes to reconcile" group.
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
import { clientToLocalPath, norm } from './pathUtil.js'

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

/**
 * Merge a fresh incremental `reconcile -n` result into the previously known
 * reconcile list, given the exact set of paths that were just re-scanned.
 *
 * The file watcher only re-scans the files that changed on disk; the rest of the
 * "changes to reconcile" group must be carried over untouched. So the merge is:
 * keep every prior entry whose path was NOT in this scan, then add whatever the
 * scan freshly reported. A file that was in `scanned` but is absent from `fresh`
 * has become clean (edited back / collected / deleted-then-restored) and drops
 * out. Dedupe by normalized `clientFile` so a path can't double-list.
 *
 * `scanned` and `fresh` carry absolute local paths (the same ones passed to
 * `p4 reconcile -n`); comparison is via {@link norm}. Pure — no p4 I/O.
 */
export function mergeReconcile(
  prev: readonly ReconcileFile[],
  scanned: readonly string[],
  fresh: readonly ReconcileFile[],
): ReconcileFile[] {
  const scannedKeys = new Set(scanned.map(norm))
  const seen = new Set<string>()
  const out: ReconcileFile[] = []
  const push = (f: ReconcileFile): void => {
    const key = f.clientFile ? norm(f.clientFile) : f.depotFile
    if (seen.has(key)) return
    seen.add(key)
    out.push(f)
  }
  // Fresh results win for any re-scanned path, so add them first.
  for (const f of fresh) push(f)
  for (const f of prev) {
    if (f.clientFile && scannedKeys.has(norm(f.clientFile))) continue
    push(f)
  }
  return out
}

/**
 * Drop reconcile entries the user has permanently dismissed ("move out of the
 * list"). `dismissed` holds normalized local paths ({@link norm}); a file is
 * removed when its `clientFile` matches. Entries without a local path are always
 * kept (they can't be keyed by dismissal). Pure — no p4 I/O.
 */
export function filterDismissed(
  files: readonly ReconcileFile[],
  dismissed: ReadonlySet<string>,
): ReconcileFile[] {
  if (dismissed.size === 0) return [...files]
  return files.filter((f) => !f.clientFile || !dismissed.has(norm(f.clientFile)))
}

/**
 * Expand a dismiss target selection into the concrete local paths to add to the
 * dismissed set. A file target contributes itself; a directory target (folder
 * row / group) contributes every currently-listed reconcile file whose path sits
 * under it. Directories aren't real reconcile entries, so they're matched as a
 * normalized path prefix against the live list. Returns normalized local paths.
 */
export function expandDismissPaths(
  targets: readonly string[],
  files: readonly ReconcileFile[],
): string[] {
  const out = new Set<string>()
  const listed = files
    .map((f) => f.clientFile)
    .filter((p): p is string => p !== undefined)
    .map(norm)
  const listedSet = new Set(listed)
  for (const raw of targets) {
    const key = norm(raw)
    if (listedSet.has(key)) {
      out.add(key)
      continue
    }
    // Not an exact listed file → treat as a directory prefix and pull in every
    // listed file under it.
    const prefix = `${key}/`
    for (const p of listed) if (p.startsWith(prefix)) out.add(p)
  }
  return [...out]
}
