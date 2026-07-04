/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PromptRefTracker — tracks embedded @/# references in the Monaco prompt model
 *  by character range, VSCode Copilot-style. Each reference is inserted as plain
 *  display text (`@src/a.ts`, `#foo bar`) and painted as a "pill" via a Monaco
 *  decoration. Monaco migrates the decoration range across edits automatically,
 *  so a reference whose label contains spaces round-trips correctly and follows
 *  the text as the user types around it.
 *
 *  On every model change the host calls `reconcile()`: any pill whose current
 *  range text no longer matches its insertion snapshot (the user edited inside
 *  it, or backspaced its edge) is removed entirely — matching VSCode's "editing
 *  a reference deletes it" behaviour. `list()` returns the live placed refs for
 *  serialization (`composePromptBlocksFromRefs`) and draft persistence.
 *--------------------------------------------------------------------------------------------*/

import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { refDisplay, type PlacedRef, type PromptRef } from './promptRef.js'

interface TrackedEntry {
  readonly ref: PromptRef
  decorationId: string
  /** The exact display text inserted; a range whose text drifts from this is dead. */
  readonly snapshot: string
}

export class PromptRefTracker {
  private readonly _entries = new Map<string, TrackedEntry>()

  constructor(
    private readonly _model: monaco.editor.ITextModel,
    private readonly _ns: typeof monaco,
    /** CSS class painted on the pill span (a CSS-module global class name). */
    private readonly _pillClassName: string,
  ) {}

  /**
   * Replace `[start, end)` with the ref's display text and paint it as a pill.
   * Returns the offset immediately past the inserted display (for caret / trailing
   * space). The edit must be issued while the host suppresses user-change handling
   * (see PromptMonacoEditor's programmatic guard) so it isn't mistaken for typing.
   */
  insert(ref: PromptRef, start: number, end: number): number {
    const display = refDisplay(ref)
    const range = this._ns.Range.fromPositions(
      this._model.getPositionAt(start),
      this._model.getPositionAt(end),
    )
    this._model.applyEdits([{ range, text: display, forceMoveMarkers: true }])
    const decoRange = this._ns.Range.fromPositions(
      this._model.getPositionAt(start),
      this._model.getPositionAt(start + display.length),
    )
    const [decorationId] = this._model.deltaDecorations(
      [],
      [
        {
          range: decoRange,
          options: {
            inlineClassName: this._pillClassName,
            stickiness: this._ns.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        },
      ],
    )
    this._entries.set(ref.id, { ref, decorationId: decorationId!, snapshot: display })
    return start + display.length
  }

  /**
   * Re-register refs against an already-populated model (draft restore). The text
   * must already contain each ref's display at its `[start, end)`; this only rebuilds
   * the decorations + tracking, it does not edit the text.
   */
  restore(placed: readonly PlacedRef[]): void {
    for (const p of placed) {
      const display = refDisplay(p.ref)
      const decoRange = this._ns.Range.fromPositions(
        this._model.getPositionAt(p.start),
        this._model.getPositionAt(p.start + display.length),
      )
      const [decorationId] = this._model.deltaDecorations(
        [],
        [
          {
            range: decoRange,
            options: {
              inlineClassName: this._pillClassName,
              stickiness: this._ns.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          },
        ],
      )
      this._entries.set(p.ref.id, { ref: p.ref, decorationId: decorationId!, snapshot: display })
    }
  }

  /** Live placed refs, ordered by start offset. Dead decorations are skipped. */
  list(): PlacedRef[] {
    const out: PlacedRef[] = []
    for (const entry of this._entries.values()) {
      const range = this._model.getDecorationRange(entry.decorationId)
      if (!range) continue
      const start = this._model.getOffsetAt({
        lineNumber: range.startLineNumber,
        column: range.startColumn,
      })
      const end = this._model.getOffsetAt({
        lineNumber: range.endLineNumber,
        column: range.endColumn,
      })
      out.push({ ref: entry.ref, start, end })
    }
    return out.sort((a, b) => a.start - b.start)
  }

  /**
   * Drop any pill the user broke: a vanished decoration, or one whose current
   * range text drifted from its insertion snapshot. Deletes the leftover partial
   * text of an edited pill so no orphan `@`/`#` fragment is left behind. Returns
   * true if it mutated the model (host should re-emit the resulting text).
   */
  reconcile(): boolean {
    const dead: Array<{ refId: string; decorationId: string; range: monaco.IRange }> = []
    for (const [refId, entry] of this._entries) {
      const range = this._model.getDecorationRange(entry.decorationId)
      if (!range) {
        this._entries.delete(refId)
        continue
      }
      if (this._model.getValueInRange(range) !== entry.snapshot) {
        dead.push({ refId, decorationId: entry.decorationId, range })
      }
    }
    if (dead.length === 0) return false
    this._model.deltaDecorations(
      dead.map((d) => d.decorationId),
      [],
    )
    for (const d of dead) this._entries.delete(d.refId)
    // Delete tail-first so earlier ranges stay valid across the edits.
    const edits = dead
      .map((d) => ({ range: d.range, text: '' }))
      .sort(
        (a, b) =>
          b.range.startLineNumber - a.range.startLineNumber ||
          b.range.startColumn - a.range.startColumn,
      )
    this._model.applyEdits(edits)
    return true
  }

  /** Remove all pills + tracking (e.g. after submit clears the buffer). */
  clear(): void {
    if (this._entries.size === 0) return
    this._model.deltaDecorations(
      [...this._entries.values()].map((e) => e.decorationId),
      [],
    )
    this._entries.clear()
  }

  dispose(): void {
    this.clear()
  }
}
