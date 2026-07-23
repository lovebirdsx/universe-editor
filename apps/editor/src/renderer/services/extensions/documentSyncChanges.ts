/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure conversion from Monaco content-change batches to the LSP-shaped deltas
 *  the extension host mirror applies (see DocumentSyncContribution).
 *--------------------------------------------------------------------------------------------*/

import type { TextDocumentContentChangeDto } from '@universe-editor/extensions-common'

/** The slice of Monaco's IModelContentChange the conversion needs. */
export interface MonacoContentChange {
  readonly range: {
    readonly startLineNumber: number
    readonly startColumn: number
    readonly endLineNumber: number
    readonly endColumn: number
  }
  readonly rangeOffset: number
  readonly text: string
}

/**
 * Convert one Monaco content-change event batch into LSP-sequential deltas.
 * Monaco reports all changes of one event against the same pre-event state with
 * non-overlapping ranges; sorted end-of-document-first, applying them one after
 * the other (LSP semantics) yields the identical result, because an edit later
 * in the document never shifts the coordinates of an earlier one.
 */
export function monacoChangesToContentChanges(
  changes: readonly MonacoContentChange[],
): TextDocumentContentChangeDto[] {
  return [...changes]
    .sort((a, b) => b.rangeOffset - a.rangeOffset)
    .map((c) => ({
      range: {
        start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 },
        end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 },
      },
      text: c.text,
    }))
}
