/**
 * Partial staging helper. `git diff -U0` emits one hunk per contiguous change
 * run — the same granularity as a dirty-diff region — so staging a single hunk
 * is: take the diff, keep the file header plus the one hunk whose modified-side
 * range overlaps the clicked region, and feed that patch to
 * `git apply --cached --unidiff-zero`. No diff is recomputed and the hunk bodies
 * (including `\ No newline at end of file` markers) are preserved verbatim.
 */

interface Hunk {
  /** The `@@ … @@` line plus its body lines, each newline-terminated. */
  readonly text: string
  /** 1-based start line on the modified (working-tree) side. */
  readonly modifiedStart: number
  /** Line count on the modified side (0 for a pure deletion). */
  readonly modifiedCount: number
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

/**
 * Split a `git diff` output into its file header (everything before the first
 * `@@`) and the individual hunks. Returns undefined when there is no hunk. Every
 * returned text fragment is newline-terminated.
 */
function parseDiff(diff: string): { header: string; hunks: Hunk[] } | undefined {
  const lines = diff.split('\n')
  // `split` leaves a trailing '' for the final newline; drop it so it doesn't
  // become a spurious extra line when we re-join.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const firstHunk = lines.findIndex((l) => l.startsWith('@@'))
  if (firstHunk === -1) return undefined

  const term = (chunk: readonly string[]): string =>
    chunk.length === 0 ? '' : chunk.join('\n') + '\n'

  const header = term(lines.slice(0, firstHunk))
  const hunks: Hunk[] = []
  let i = firstHunk
  while (i < lines.length) {
    if (!lines[i]!.startsWith('@@')) {
      i++
      continue
    }
    const m = HUNK_HEADER.exec(lines[i]!)
    const start = i
    i++
    while (i < lines.length && !lines[i]!.startsWith('@@')) i++
    if (!m) continue
    hunks.push({
      text: term(lines.slice(start, i)),
      modifiedStart: Number(m[1]),
      modifiedCount: m[2] === undefined ? 1 : Number(m[2]),
    })
  }
  return { header, hunks }
}

/**
 * Build a patch staging only the hunk overlapping the current-document line range
 * [startLine, endLine] (1-based, inclusive). Returns undefined when no hunk
 * matches. A pure deletion (`modifiedCount === 0`) is anchored after its start
 * line, so it matches when the region touches that line or the next.
 */
export function selectHunkPatch(
  diff: string,
  startLine: number,
  endLine: number,
): string | undefined {
  const parsed = parseDiff(diff)
  if (!parsed) return undefined

  const selected = parsed.hunks.filter((h) => {
    const covStart = h.modifiedStart
    const covEnd =
      h.modifiedCount === 0 ? h.modifiedStart + 1 : h.modifiedStart + h.modifiedCount - 1
    return covStart <= endLine && covEnd >= startLine
  })
  if (selected.length === 0) return undefined

  return parsed.header + selected.map((h) => h.text).join('')
}
