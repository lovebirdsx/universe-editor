/**
 * Parse `p4 -Mj fstat <file>` records. `fstat` reports per-file metadata: whether
 * a file is under depot control (`depotFile` present), the have revision
 * (`haveRev`), the head revision (`headRev`), the open action, and resolve state.
 * Used to decide controlled-ness and to key the diff baseline (depotPath#haveRev).
 * Pure; the p4Service produces records, this shapes them.
 */

export interface FstatInfo {
  readonly depotFile: string
  readonly clientFile: string | undefined
  /** The revision currently synced to disk (`#have`), when known. */
  readonly haveRev: string | undefined
  /** The latest revision in the depot (`#head`), when known. */
  readonly headRev: string | undefined
  /** Open action if the file is currently open, else undefined. */
  readonly action: string | undefined
  /**
   * True when the file has a pending resolve. `fstat` reports this as a bare
   * `unresolved` key (empty value under both `-Mj` and `-ztag`) and omits it
   * otherwise — `p4 opened` never carries it on real servers
   * (PROBE-FINDINGS §11.5), so this is the authoritative signal.
   */
  readonly unresolved: boolean
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export function parseFstatRecord(record: Record<string, unknown>): FstatInfo | undefined {
  const depotFile = asString(record['depotFile'])
  if (!depotFile) return undefined
  return {
    depotFile,
    clientFile: asString(record['clientFile']),
    haveRev: asString(record['haveRev']),
    headRev: asString(record['headRev']),
    action: asString(record['action']),
    unresolved: record['unresolved'] !== undefined,
  }
}

export function parseFstat(records: readonly Record<string, unknown>[]): FstatInfo[] {
  const out: FstatInfo[] = []
  for (const r of records) {
    const info = parseFstatRecord(r)
    if (info) out.push(info)
  }
  return out
}

/** True when fstat reports the file exists under depot control. */
export function isControlled(records: readonly Record<string, unknown>[]): boolean {
  return records.some((r) => typeof r['depotFile'] === 'string')
}

/** A revision string p4 reported, as a number — `'none'` (open-for-add has no
 *  have revision) and anything else non-integer yield undefined rather than NaN. */
export function asRev(v: string | undefined): number | undefined {
  if (!v || v === 'none') return undefined
  const n = Number(v)
  return Number.isInteger(n) ? n : undefined
}

/** Judge whether fstat says this file is behind the depot head.
 *  Returns `{ behind, headRev }`; excludes open-for-add (`action === 'add'` or
 *  `haveRev === 'none'`) — a new file has no have revision to be behind. */
export function fstatBehind(info: FstatInfo): { behind: boolean; headRev?: string } {
  if (info.action === 'add' || info.haveRev === 'none') return { behind: false }
  const have = asRev(info.haveRev)
  const head = asRev(info.headRev)
  if (have === undefined || head === undefined) return { behind: false }
  if (have < head) return { behind: true, headRev: String(head) }
  return { behind: false }
}
