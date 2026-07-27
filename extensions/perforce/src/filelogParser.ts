/**
 * Pure parser for `p4 filelog` records — the per-file revision history behind
 * the Timeline provider. No p4 I/O here: `P4Service.execRecords` feeds records
 * in, this shapes them. Two record shapes arrive depending on the server:
 *
 *  - Numbered parallel keys (the normal shape): ONE record for the file with
 *    `depotFile` + `rev0/change0/action0/time0/user0/client0/desc0`, `rev1/…` —
 *    the same parallel-key layout as `describe -s` (see p4GraphParser). Native
 *    `-Mj` output and the `parseZtagAsMarshal` fallback both produce it.
 *  - Single-valued keys (defensive): one record per revision carrying
 *    `rev`/`change`/… directly. Not observed, but cheap to support.
 *
 * `rev` values may carry a `#` prefix in tagged output — stripped here.
 */
import { descriptionFirstLine } from './changelist.js'

/** One revision in a file's history, newest-first (p4's order). */
export interface FilelogRevision {
  /** Revision number, without any `#` prefix. */
  readonly rev: string
  /** The changelist that created this revision. */
  readonly change: string
  readonly action: string
  /** Submit time, epoch seconds. */
  readonly time: number
  readonly user: string
  readonly client: string
  /** Full change description (may be multi-line). */
  readonly desc: string
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function cleanRev(v: string | undefined): string | undefined {
  return v?.replace(/^#/, '') || undefined
}

/** Read a parallel-key field (`rev0`, `rev1`, …) into an ordered array. */
function numberedValues(record: Record<string, unknown>, base: string): string[] {
  const out: string[] = []
  for (let i = 0; ; i++) {
    const v = record[`${base}${i}`]
    if (typeof v !== 'string') break
    out.push(v)
  }
  return out
}

function revisionAt(get: (base: string) => string | undefined): FilelogRevision | undefined {
  const rev = cleanRev(get('rev'))
  if (!rev) return undefined
  return {
    rev,
    change: get('change') ?? '',
    action: get('action') ?? '',
    time: Number(get('time') ?? 0),
    user: get('user') ?? '',
    client: get('client') ?? '',
    desc: get('desc') ?? '',
  }
}

/** Parse `p4 filelog` records into the file's revisions (newest-first). */
export function parseFilelog(records: readonly Record<string, unknown>[]): FilelogRevision[] {
  const out: FilelogRevision[] = []
  for (const record of records) {
    if (asString(record['rev0']) !== undefined) {
      const revs = numberedValues(record, 'rev')
      for (let i = 0; i < revs.length; i++) {
        const r = revisionAt((base) => asString(record[`${base}${i}`]))
        if (r) out.push(r)
      }
    } else {
      const r = revisionAt((base) => asString(record[base]))
      if (r) out.push(r)
    }
  }
  return out
}

/** First line of a revision's description, for the timeline row label. */
export function filelogLabel(revision: FilelogRevision): string {
  return descriptionFirstLine(revision.desc)
}
