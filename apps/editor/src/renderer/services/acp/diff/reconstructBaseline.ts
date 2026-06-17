/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  reconstructBaseline — rebuild the pre-session content of a file from its
 *  current on-disk content plus the ordered sequence of structuredPatch hunks
 *  the agent produced during this session.
 *
 *  The agent (claude subprocess) writes files directly and only reports diffs
 *  *after* the write, so the renderer can never read the true pre-edit content
 *  off disk. Instead we replay the edits in reverse: starting from `current`,
 *  each batch of hunks is un-applied newest-first, walking the file back to the
 *  state it had before this session's first edit.
 *
 *  Each hunk carries line numbers (`newStart`) and the literal `+`/`-`/context
 *  lines, so we locate the post-edit block by line number first and verify it
 *  against the hunk's "after" text; on mismatch we fall back to a text search so
 *  edits that shifted line numbers still align. If a hunk can't be located at
 *  all (e.g. the user hand-edited the file between sessions), we mark the result
 *  `degraded` rather than emit a wrong baseline.
 *--------------------------------------------------------------------------------------------*/

/** One hunk of a `structuredPatch`, mirroring the agent fork's shape. */
export interface DiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  /** Unified-diff lines, each prefixed with ' ' (context), '+' (added), or '-' (removed). */
  readonly lines: readonly string[]
}

/** One Edit/Write tool call's worth of hunks against a single file. */
export interface DiffBatch {
  /** The originating tool call id, used by the tracker to dedupe re-delivered updates. */
  readonly toolCallId?: string
  readonly hunks: readonly DiffHunk[]
  /**
   * True when this batch came from a Write that created the file (SDK
   * `type: 'create'` / `originalFile: null`). The tracker uses it to force an
   * `added` status with an empty baseline even when the hunks are empty (an
   * empty-content Write reports zero hunks).
   */
  readonly created?: boolean
}

export interface ReconstructResult {
  readonly baseline: string
  /** True when at least one hunk could not be located; baseline may be partial. */
  readonly degraded: boolean
}

const NL = '\n'

/** Split into lines without dropping a trailing-newline distinction. */
function toLines(text: string): string[] {
  return text.split(NL)
}

function fromLines(lines: readonly string[]): string {
  return lines.join(NL)
}

/** The "after" (post-edit) lines a hunk expects to find: context + added. */
function afterLines(hunk: DiffHunk): string[] {
  const out: string[] = []
  for (const line of hunk.lines) {
    const tag = line[0]
    if (tag === '+' || tag === ' ') out.push(line.slice(1))
  }
  return out
}

/** The "before" (pre-edit) lines a hunk replaces with: context + removed. */
function beforeLines(hunk: DiffHunk): string[] {
  const out: string[] = []
  for (const line of hunk.lines) {
    const tag = line[0]
    if (tag === '-' || tag === ' ') out.push(line.slice(1))
  }
  return out
}

/** Does `block` appear in `lines` starting exactly at `start` (0-based)? */
function matchesAt(lines: readonly string[], start: number, block: readonly string[]): boolean {
  if (start < 0 || start + block.length > lines.length) return false
  for (let i = 0; i < block.length; i++) {
    if (lines[start + i] !== block[i]) return false
  }
  return true
}

/** Find the first index where `block` occurs in `lines`, or -1. */
function indexOfBlock(lines: readonly string[], block: readonly string[]): number {
  if (block.length === 0) return -1
  const last = lines.length - block.length
  for (let start = 0; start <= last; start++) {
    if (matchesAt(lines, start, block)) return start
  }
  return -1
}

/**
 * Un-apply a single hunk: locate its "after" block in `lines` and splice in the
 * "before" block. Returns the new lines, or null if the block can't be found.
 */
function unapplyHunk(lines: readonly string[], hunk: DiffHunk): string[] | null {
  const after = afterLines(hunk)
  const before = beforeLines(hunk)

  // Primary: line-number anchored (newStart is 1-based).
  let at = hunk.newStart - 1
  if (after.length > 0 && !matchesAt(lines, at, after)) {
    // Fall back to a textual search when line numbers drifted.
    at = indexOfBlock(lines, after)
  }

  // Pure-insertion hunk (no context, no removals): after-block must still be
  // present to know where to delete it; if absent we can't safely locate it.
  if (after.length === 0) {
    // Nothing to find/remove on the "after" side — treat before-block as a
    // straight insertion at newStart. Only safe when within bounds.
    const idx = hunk.newStart - 1
    if (idx < 0 || idx > lines.length) return null
    return [...lines.slice(0, idx), ...before, ...lines.slice(idx)]
  }

  if (at < 0 || !matchesAt(lines, at, after)) return null

  return [...lines.slice(0, at), ...before, ...lines.slice(at + after.length)]
}

/**
 * Rebuild the baseline (pre-session) content of a file.
 *
 * @param current  the file's current on-disk content
 * @param batches  edits in the order they were applied (oldest first); each
 *                 batch is one Edit/Write tool call's hunks
 */
export function reconstructBaseline(
  current: string,
  batches: readonly DiffBatch[],
): ReconstructResult {
  let lines = toLines(current)
  let degraded = false

  // Replay in reverse: undo the newest batch first, and within a batch undo the
  // bottom-most hunk first so earlier hunks' line numbers stay valid.
  for (let b = batches.length - 1; b >= 0; b--) {
    const batch = batches[b]
    if (!batch) continue
    const hunks = [...batch.hunks].sort((x, y) => y.newStart - x.newStart)
    for (const hunk of hunks) {
      const next = unapplyHunk(lines, hunk)
      if (next === null) {
        degraded = true
        continue
      }
      lines = next
    }
  }

  return { baseline: fromLines(lines), degraded }
}
