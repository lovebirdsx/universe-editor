/**
 * Parse `p4 -ztag cstat <filespec>@<low>,#head` records into a changelist id →
 * sync status map. `cstat` answers which submitted changelists this client
 * already has (`have`), still needs (`need`), or only partially has
 * (`partial`); `P4Service.execTagged` runs the command and `parseZtag` flattens
 * the `-ztag` output into the `Record<string, unknown>[]` records consumed
 * here (each carries a `change` and `status` key).
 *
 * An unknown `status` is dropped rather than guessed: misclassifying a
 * changelist as `need` would surface a sync the client already has, so the
 * caller is left to treat the change as unclassified.
 */
export type CstatStatus = 'have' | 'need' | 'partial'

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/** Parse `p4 -ztag cstat` records into changelist id → sync status. */
export function parseCstat(records: readonly Record<string, unknown>[]): Map<string, CstatStatus> {
  const out = new Map<string, CstatStatus>()
  for (const record of records) {
    const change = asString(record['change'])
    if (!change) continue
    const status = asString(record['status'])?.trim().toLowerCase()
    if (status !== 'have' && status !== 'need' && status !== 'partial') continue
    // Last record wins: real cstat emits each change once, but overwriting keeps
    // the map self-consistent if a duplicate ever appears.
    out.set(change, status)
  }
  return out
}
