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
