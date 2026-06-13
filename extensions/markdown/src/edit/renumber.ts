/**
 * Renumber ordered list items so each contiguous run at a given indent level
 * counts up from its first item. Bullet lists are untouched. A blank line or a
 * shallower indent ends a run; a deeper indent is a nested run tracked
 * independently. The first item's number is kept as the run's start value
 * (so a list starting at 0 or 3 is respected, just made sequential).
 */
import { parseListMarker, renderPrefix } from './listModel.js'
import { replaceLine, type EditOp } from './textEditing.js'

interface RunState {
  /** Next number to assign at this indent width. */
  next: number
}

export function renumberOrderedLists(lines: readonly string[]): EditOp[] {
  const edits: EditOp[] = []
  // Map indent-width → running counter. Cleared for deeper levels when we
  // dedent, so a re-entered nested list restarts.
  const runs = new Map<number, RunState>()
  let lastIndent = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const parsed = parseListMarker(line)

    if (!parsed) {
      // A non-list line breaks every run only if it's blank or non-indented
      // text; indented continuation text (lazy continuation) keeps runs alive.
      if (line.trim().length === 0) runs.clear()
      lastIndent = -1
      continue
    }

    const indentWidth = parsed.indent.length

    // Dedent: drop any runs deeper than the current indent.
    if (indentWidth < lastIndent) {
      for (const key of [...runs.keys()]) {
        if (key > indentWidth) runs.delete(key)
      }
    }
    lastIndent = indentWidth

    if (!parsed.ordered) {
      // A bullet run at this indent resets any ordered counter sharing it.
      runs.delete(indentWidth)
      continue
    }

    let run = runs.get(indentWidth)
    if (!run) {
      const start = Number.parseInt(parsed.marker, 10)
      run = { next: Number.isFinite(start) ? start : 1 }
      runs.set(indentWidth, run)
    }

    const expected = String(run.next)
    run.next += 1

    if (expected !== parsed.marker) {
      const newPrefix = renderPrefix({ ...parsed, marker: expected })
      const newLine = newPrefix + parsed.content
      edits.push(replaceLine(i, line, newLine))
    }
  }

  return edits
}
