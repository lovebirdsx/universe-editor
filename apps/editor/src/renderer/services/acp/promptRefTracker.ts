/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PromptRefTracker — tracks embedded @/# references in the Monaco prompt model
 *  by character range, VSCode Copilot-style. Each reference is inserted as plain
 *  display text (`@src/a.ts`, `#foo bar`) and painted as a "pill" via a Monaco
 *  decoration. Monaco migrates the decoration range across edits automatically,
 *  so a reference whose label contains spaces round-trips correctly and follows
 *  the text as the user types around it.
 *
 *  Insertions are undoable: they go through `pushEditOperations` (not
 *  `applyEdits`, which Monaco keeps out of the undo stack) and are delimited by
 *  `pushStackElement`. A batch inserted inside `beginUndoGroup`/`endUndoGroup`
 *  collapses to one undo step.
 *
 *  Undo/redo moves the text but does NOT grow a decoration back: a pill whose
 *  range was consumed by the inverse edit collapses to an empty range. So
 *  `reconcile` treats `isUndoing` as "remove the decoration, keep the ref
 *  suspended", and `isRedoing` as "the changes carry the pill text again — mount
 *  the decoration back". A plain edit drops suspended refs (its redo branch is
 *  gone anyway).
 *--------------------------------------------------------------------------------------------*/

import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { refDisplay, type PlacedRef, type PromptRef } from './promptRef.js'

interface TrackedEntry {
  readonly ref: PromptRef
  decorationId: string
  /** The exact display text inserted; a range whose text drifts from this is dead. */
  readonly snapshot: string
}

interface SuspendedEntry {
  readonly ref: PromptRef
  readonly snapshot: string
}

/** The subset of Monaco's `IModelContentChangedEvent` this tracker reads. */
export interface PromptModelChange {
  readonly isUndoing?: boolean
  readonly isRedoing?: boolean
  readonly isFlush?: boolean
  readonly changes?: readonly { readonly rangeOffset: number; readonly text: string }[]
}

export interface PromptRefInsertOptions {
  /** Whitespace appended in the SAME edit so the pill and its boundary undo together. */
  readonly suffix?: string
  /** Cursor before the edit; Monaco restores it when the insertion is undone. */
  readonly beforeCursorState?: monaco.Selection[] | null
}

export class PromptRefTracker {
  private readonly _entries = new Map<string, TrackedEntry>()
  private readonly _suspended: SuspendedEntry[] = []
  private _groupDepth = 0

  constructor(
    private readonly _model: monaco.editor.ITextModel,
    private readonly _ns: typeof monaco,
    /** CSS class painted on the pill span (a CSS-module global class name). */
    private readonly _pillClassName: string,
  ) {}

  /**
   * Replace `[start, end)` with the ref's display text (plus `suffix`) and paint
   * the display as a pill. Returns the offset immediately past the inserted text.
   * The edit must be issued while the host suppresses user-change handling (see
   * PromptMonacoEditor's programmatic guard) so it isn't mistaken for typing.
   */
  insert(ref: PromptRef, start: number, end: number, options: PromptRefInsertOptions = {}): number {
    const display = refDisplay(ref)
    const suffix = options.suffix ?? ''
    const range = this._ns.Range.fromPositions(
      this._model.getPositionAt(start),
      this._model.getPositionAt(end),
    )
    // A new edit closes the redo branch, so suspended pills can never come back.
    this._suspended.length = 0
    const standalone = this._groupDepth === 0
    if (standalone) this._model.pushStackElement()
    // No forceMoveMarkers: an insertion at an existing pill's edge must not grow
    // that pill (its end would then cover the new text, and the next reconcile
    // would delete both).
    this._model.pushEditOperations(
      options.beforeCursorState ?? null,
      [{ range, text: display + suffix }],
      () => null,
    )
    this._mount(ref, start, display)
    if (standalone) this._model.pushStackElement()
    return start + display.length + suffix.length
  }

  /**
   * Start an undo group: every insertion until `endUndoGroup` becomes one undo
   * step. Must not be interleaved with `await` — the group is model state.
   */
  beginUndoGroup(): void {
    if (this._groupDepth === 0) this._model.pushStackElement()
    this._groupDepth++
  }

  endUndoGroup(): void {
    if (this._groupDepth === 0) return
    this._groupDepth--
    if (this._groupDepth === 0) this._model.pushStackElement()
  }

  /**
   * Re-register refs against an already-populated model (draft restore). The text
   * must already contain each ref's display at its `[start, end)`; this only rebuilds
   * the decorations + tracking, it does not edit the text.
   */
  restore(placed: readonly PlacedRef[]): void {
    for (const p of placed) {
      this._mount(p.ref, p.start, refDisplay(p.ref))
    }
  }

  /** Live placed refs, ordered by start offset. Suspended + dead entries are skipped. */
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
   * React to a model content change.
   *
   * - Plain edit: drop any pill the user broke (vanished decoration, or a range
   *   whose text drifted from its insertion snapshot) and delete its leftover
   *   text so no orphan `@`/`#` fragment remains.
   * - Undo: remove drifted pills from the decoration set but DO NOT touch the
   *   model (Monaco already applied the inverse edit) — suspend them instead.
   * - Redo: re-mount decorations for suspended refs whose text the redo change
   *   brought back.
   * - Flush (`setValue`): the model destroyed every decoration and the undo
   *   history; forget everything.
   *
   * Returns true if it mutated the model (the host should re-emit the text).
   */
  reconcile(change?: PromptModelChange): boolean {
    if (change?.isFlush) {
      this.clear()
      return false
    }
    if (change?.isRedoing) {
      this._restoreSuspended(change.changes ?? [])
      return false
    }
    if (change?.isUndoing) {
      this._suspendDrifted()
      return false
    }
    // A plain edit discards the redo branch, so suspended refs can never return.
    this._suspended.length = 0
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
    if (this._entries.size > 0) {
      this._model.deltaDecorations(
        [...this._entries.values()].map((e) => e.decorationId),
        [],
      )
      this._entries.clear()
    }
    this._suspended.length = 0
    this._groupDepth = 0
  }

  dispose(): void {
    this.clear()
  }

  private _mount(ref: PromptRef, start: number, display: string): void {
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
  }

  /** Undo: the model text is already gone; only retire the decoration + track. */
  private _suspendDrifted(): void {
    for (const [refId, entry] of this._entries) {
      const range = this._model.getDecorationRange(entry.decorationId)
      if (!range) {
        this._entries.delete(refId)
        continue
      }
      if (this._model.getValueInRange(range) === entry.snapshot) continue
      this._model.deltaDecorations([entry.decorationId], [])
      this._entries.delete(refId)
      this._suspended.push({ ref: entry.ref, snapshot: entry.snapshot })
    }
  }

  /**
   * Redo: re-mount decorations for suspended pills whose display text the redo
   * brought back. Monaco compresses adjacent edits into ONE change when it
   * records the undo element (`compressConsecutiveTextChanges`), so a multi-file
   * drop comes back as a single chunk like `@a.txt @b.txt @c.txt ` — each
   * snapshot must be located inside the change text, not matched against it
   * whole. Changes arrive in descending offset order and their offsets are
   * already final-text coordinates, so each change can be handled independently.
   */
  private _restoreSuspended(changes: readonly { rangeOffset: number; text: string }[]): void {
    if (this._suspended.length === 0) return
    const pending = [...this._suspended]
    this._suspended.length = 0
    for (const change of changes) {
      if (change.text.length === 0) continue
      let searchFrom = 0
      while (searchFrom < change.text.length) {
        let index = -1
        let at = -1
        for (let i = 0; i < pending.length; i++) {
          const candidate = pending[i]!
          const found = change.text.indexOf(candidate.snapshot, searchFrom)
          if (found < 0) continue
          // Same offset: prefer the longer snapshot, or a label that prefixes
          // another (`@main.ts` vs `@main.tsx`) would claim the longer pill.
          const better =
            at < 0 ||
            found < at ||
            (found === at && candidate.snapshot.length > pending[index]!.snapshot.length)
          if (better) {
            index = i
            at = found
          }
        }
        if (index < 0) break
        const [candidate] = pending.splice(index, 1)
        if (!candidate) break
        const absolute = change.rangeOffset + at
        // The change may also carry surrounding user text; only paint a pill
        // where the model actually holds its display text. Otherwise keep the
        // candidate for a later redo step instead of dropping it.
        if (
          this._model.getValue().slice(absolute, absolute + candidate.snapshot.length) ===
          candidate.snapshot
        ) {
          this._mount(candidate.ref, absolute, candidate.snapshot)
        } else {
          pending.push(candidate)
        }
        searchFrom = at + candidate.snapshot.length
      }
    }
    // Redo events arrive one undo element at a time; keep refs for later steps.
    this._suspended.push(...pending)
  }
}
