/**
 * Perforce blame ("annotate") data source. Two passes, then assembled into the
 * `BlameResultDto` shape the renderer's inline-blame annotations consume:
 *
 *  1. `p4 -ztag annotate -c -q <file>` — one tagged record per source line,
 *     carrying the changelist that last touched it (`lower`). `-q` drops the
 *     file-header noise. Tagged (not `-Mj`) output is required: some servers
 *     collapse `-Mj annotate` into a single opaque `data` blob without the
 *     structured fields.
 *  2. `p4 -ztag describe -s <cl>` per unique changelist — for the description's
 *     first line (the blame "summary") plus the author (`user`) and commit
 *     `time` (Unix seconds); the annotate pass carries neither cleanly.
 *
 * Perforce has no per-line email, so `authorEmail` is left blank and `hash`
 * carries the changelist number (the renderer only uses it as an opaque commit
 * key + for the "open commit" affordance, which Perforce leaves unimplemented).
 *
 * The parsing here is pure so the quirky annotate record layout is unit-testable;
 * the p4 I/O + describe batching lives in client.ts.
 */

/** One source line's annotation: which changelist/user/time last changed it. */
export interface AnnotatedLine {
  /** 1-based line number in the current file. */
  readonly line: number
  /** Changelist that last modified the line, or undefined when not annotated. */
  readonly changelist: string | undefined
  readonly user: string | undefined
  /** Commit time in Unix milliseconds, or undefined when absent. */
  readonly time: number | undefined
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/**
 * Parse `p4 -ztag annotate -c -q` records into per-line annotations. Each line
 * record carries a `lower` changelist (the one that introduced the current
 * content); `user`/`time` are absent here (sourced from `describe` instead).
 * Records without `data` (the initial header record) don't consume a line.
 */
export function parseAnnotate(records: readonly Record<string, unknown>[]): AnnotatedLine[] {
  const out: AnnotatedLine[] = []
  let line = 0
  for (const record of records) {
    // A per-line record is one that carries line content (`data`). The initial
    // header record (only `depotFile`) has no `data` and must not consume a line.
    if (!('data' in record)) continue
    line++
    const changelist = asString(record['lower']) ?? asString(record['upper'])
    const user = asString(record['user'])
    const timeSec = asString(record['time'])
    out.push({
      line,
      changelist,
      user,
      ...(timeSec ? { time: Number(timeSec) * 1000 } : { time: undefined }),
    })
  }
  return out
}

/** The unique changelist ids referenced by a set of annotated lines. */
export function annotatedChangelists(lines: readonly AnnotatedLine[]): string[] {
  const seen = new Set<string>()
  for (const l of lines) if (l.changelist) seen.add(l.changelist)
  return [...seen]
}

/** BlameResultDto (re-declared locally so this bundled extension doesn't pull in
 *  @universe-editor/extensions-common + its platform dep). */
export interface P4BlameInfo {
  hash: string
  authorName: string
  authorEmail: string
  authorDate: number
  summary: string
  ranges: { startLine: number; endLine: number }[]
}

export interface P4BlameResult {
  commits: P4BlameInfo[]
  uncommittedLines: number[]
}

/**
 * Fold per-line annotations + a changelist→description map into the blame DTO:
 * one commit entry per changelist, with the contiguous line ranges it owns.
 * Lines whose changelist is unknown are reported as uncommitted (Perforce has no
 * "not committed yet" concept, but a locally open-for-add file annotates empty).
 */
export function buildBlameResult(
  lines: readonly AnnotatedLine[],
  summaries: ReadonlyMap<string, { summary: string; user?: string; time?: number }>,
): P4BlameResult {
  const byCl = new Map<string, P4BlameInfo>()
  const uncommitted: number[] = []

  for (const l of lines) {
    if (!l.changelist) {
      uncommitted.push(l.line)
      continue
    }
    let info = byCl.get(l.changelist)
    if (!info) {
      const meta = summaries.get(l.changelist)
      info = {
        hash: l.changelist,
        authorName: l.user ?? meta?.user ?? '',
        authorEmail: '',
        authorDate: l.time ?? meta?.time ?? 0,
        summary: meta?.summary ?? '',
        ranges: [],
      }
      byCl.set(l.changelist, info)
    }
    const last = info.ranges.at(-1)
    if (last && last.endLine === l.line - 1) {
      last.endLine = l.line
    } else {
      info.ranges.push({ startLine: l.line, endLine: l.line })
    }
  }

  return { commits: [...byCl.values()], uncommittedLines: uncommitted }
}
