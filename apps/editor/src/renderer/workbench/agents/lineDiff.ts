/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  lineDiff — line-level diff via Myers' O(ND) algorithm (the same family git and
 *  VSCode use). Cost scales with the edit distance D, not the file size, so a
 *  large document diffed against a near-identical revision (e.g. its git HEAD for
 *  dirty-diff marks) is effectively O(n) regardless of where the edits sit —
 *  switching back to a big, lightly-edited file no longer stalls. A common
 *  prefix/suffix is trimmed first as an O(n) fast path (a byte-identical pair
 *  returns immediately), and a divergence guard falls back to a coarse
 *  whole-block replace rather than letting a near-total rewrite run unbounded.
 *--------------------------------------------------------------------------------------------*/

export type DiffLineKind = 'add' | 'del' | 'ctx'

export interface DiffLine {
  readonly kind: DiffLineKind
  readonly text: string
}

// Edit-distance ceiling for the Myers search over the changed middle. Real edits
// against HEAD sit far below this; only a near-total rewrite of a huge file would
// reach it, where coarse "delete all / add all" marks beat an unbounded search.
const MAX_EDIT_DISTANCE = 2_000

// Wall-clock ceiling for one Myers search. VSCode bounds its (worker-side) quick
// diff the same way (DiffComputer maxComputationTime); ours runs on the renderer
// main thread, so the budget stays well under the jank threshold. On timeout the
// caller falls back to the coarse whole-block replace.
const MAX_DIFF_BUDGET_MS = 100

function splitLines(s: string): string[] {
  if (s.length === 0) return []
  const lines = s.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Myers diff of the changed middle. Returns the edit sequence, or `null` when the
 * edit distance exceeds {@link MAX_EDIT_DISTANCE} or the search overruns
 * `deadline` (caller falls back to a coarse replace). `trace` only grows to the
 * actual edit distance, so a small real diff stays cheap even when the inputs
 * themselves are large.
 */
function myersMiddle(
  a: readonly string[],
  b: readonly string[],
  deadline: number,
): DiffLine[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  const maxD = Math.min(max, MAX_EDIT_DISTANCE)
  // Diagonals only ever reach k ∈ [-maxD, maxD], so V is sized by the edit
  // distance ceiling, NOT by n+m: a huge file with a large diff must not copy a
  // megabytes-wide V into `trace` on every round (measured 4s per dirty-diff on
  // a 340K-line file before this bound — pure memcpy + the GC it feeds).
  const offset = maxD
  const v = new Int32Array(2 * maxD + 1)
  const trace: Int32Array[] = []

  let foundD = -1
  for (let d = 0; d <= maxD; d++) {
    if (performance.now() > deadline) return null
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]! // move down: an insertion from b
      } else {
        x = v[offset + k - 1]! + 1 // move right: a deletion from a
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        foundD = d
        break
      }
    }
    if (foundD !== -1) break
  }
  if (foundD === -1) return null

  // Backtrack through the saved per-round V snapshots, emitting in reverse.
  const rev: DiffLine[] = []
  let x = n
  let y = m
  for (let d = foundD; d > 0; d--) {
    const vPrev = trace[d]!
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && vPrev[offset + k - 1]! < vPrev[offset + k + 1]!)) {
      prevK = k + 1 // came from a down move (insertion)
    } else {
      prevK = k - 1 // came from a right move (deletion)
    }
    const prevX = vPrev[offset + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      rev.push({ kind: 'ctx', text: a[x - 1]! })
      x--
      y--
    }
    if (x === prevX) {
      rev.push({ kind: 'add', text: b[y - 1]! })
    } else {
      rev.push({ kind: 'del', text: a[x - 1]! })
    }
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    rev.push({ kind: 'ctx', text: a[x - 1]! })
    x--
    y--
  }
  rev.reverse()
  return normalizeHunkOrder(rev)
}

/**
 * Within each contiguous run of changes, emit all deletions before all
 * insertions (matching git's `-` before `+` and the previous LCS output), so a
 * replaced line reads as del-then-add and region classification is stable.
 */
function normalizeHunkOrder(lines: readonly DiffLine[]): DiffLine[] {
  const out: DiffLine[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i]!.kind === 'ctx') {
      out.push(lines[i]!)
      i++
      continue
    }
    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    while (i < lines.length && lines[i]!.kind !== 'ctx') {
      if (lines[i]!.kind === 'del') dels.push(lines[i]!)
      else adds.push(lines[i]!)
      i++
    }
    out.push(...dels, ...adds)
  }
  return out
}

/** Diff of the already-trimmed changed region, appended onto `out`. */
function appendMiddleDiff(
  out: DiffLine[],
  a: readonly string[],
  b: readonly string[],
  deadline: number,
): void {
  const m = a.length
  const n = b.length
  if (m === 0 && n === 0) return
  if (m === 0) {
    for (const t of b) out.push({ kind: 'add', text: t })
    return
  }
  if (n === 0) {
    for (const t of a) out.push({ kind: 'del', text: t })
    return
  }
  const script = myersMiddle(a, b, deadline)
  if (script === null) {
    // Too divergent (or over budget) to diff cheaply — coarse whole-block replace.
    for (const t of a) out.push({ kind: 'del', text: t })
    for (const t of b) out.push({ kind: 'add', text: t })
    return
  }
  for (const line of script) out.push(line)
}

export function computeLineDiff(oldText: string, newText: string): readonly DiffLine[] {
  return computeLineDiffFromLines(splitLines(oldText), splitLines(newText))
}

/**
 * Lines-based entry point for callers that already hold line arrays (dirty-diff
 * feeds Monaco's `getLinesContent` plus a cached HEAD split here), skipping the
 * full-text concat / EOL-normalize / split round-trip a huge document would
 * otherwise pay on every recompute. `budgetMs` bounds the Myers search's wall
 * time (tests pin it; production callers use the default).
 */
export function computeLineDiffFromLines(
  a: readonly string[],
  b: readonly string[],
  budgetMs: number = MAX_DIFF_BUDGET_MS,
): readonly DiffLine[] {
  const m = a.length
  const n = b.length

  // A common prefix/suffix is necessarily shared, so emitting it as context and
  // diffing only the middle is an O(n) fast path — a byte-identical pair (the
  // common case when switching back to an unedited file) never reaches Myers.
  let prefix = 0
  while (prefix < m && prefix < n && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < m - prefix && suffix < n - prefix && a[m - 1 - suffix] === b[n - 1 - suffix]) {
    suffix++
  }

  const out: DiffLine[] = []
  for (let k = 0; k < prefix; k++) out.push({ kind: 'ctx', text: a[k]! })
  appendMiddleDiff(
    out,
    a.slice(prefix, m - suffix),
    b.slice(prefix, n - suffix),
    performance.now() + budgetMs,
  )
  for (let k = m - suffix; k < m; k++) out.push({ kind: 'ctx', text: a[k]! })
  return out
}
