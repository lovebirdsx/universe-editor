/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  FileBulkEditService — override for Monaco's IBulkEditService. The standalone
 *  default (`StandaloneBulkEditService`) throws "bad edit - model not found" for
 *  any rename target that isn't an open editor, so cross-file F2 rename silently
 *  fails on unopened files. We fix that: edits to open models go through
 *  `pushEditOperations` (undoable, live in the editor); edits to files the user
 *  hasn't opened are read from disk via IFileService, applied bottom-up, and
 *  written back.
 *
 *  Injected as an `overrideServices` entry at every `editor.create` call site
 *  (collected on MonacoLoader) so Monaco's rename contribution resolves this
 *  instance instead of the standalone one.
 *--------------------------------------------------------------------------------------------*/

import { IFileService, URI } from '@universe-editor/platform'
import { MonacoLoader, type monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'
import { MonacoModelRegistry } from '../../../workbench/editor/monaco/MonacoModelRegistry.js'

interface WorkspaceTextEdit {
  readonly resource: monaco.Uri
  readonly textEdit: { readonly range: monaco.IRange; readonly text: string }
  readonly versionId?: number | undefined
}

interface WorkspaceEdit {
  readonly edits: readonly unknown[]
}

interface BulkEditResult {
  ariaSummary: string
  isApplied: boolean
}

function isWorkspaceTextEdit(edit: unknown): edit is WorkspaceTextEdit {
  if (typeof edit !== 'object' || edit === null) return false
  const e = edit as { resource?: unknown; textEdit?: unknown }
  return e.resource != null && typeof e.textEdit === 'object' && e.textEdit !== null
}

/** Apply Monaco-range (1-based line/column) text edits to a plain string. Edits
 *  are sorted bottom-up so earlier splices don't shift later offsets. */
export function applyTextEditsToString(
  text: string,
  edits: readonly { range: monaco.IRange; text: string }[],
): string {
  const lineStarts: number[] = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) lineStarts.push(i + 1)
  }
  const offsetOf = (lineNumber: number, column: number): number => {
    const base = lineStarts[lineNumber - 1] ?? text.length
    return Math.min(base + (column - 1), text.length)
  }
  const resolved = edits.map((e) => ({
    start: offsetOf(e.range.startLineNumber, e.range.startColumn),
    end: offsetOf(e.range.endLineNumber, e.range.endColumn),
    text: e.text,
  }))
  resolved.sort((a, b) => b.start - a.start || b.end - a.end)
  let out = text
  for (const e of resolved) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end)
  }
  return out
}

export class FileBulkEditService {
  constructor(@IFileService private readonly _fileService: IFileService) {}

  hasPreviewHandler(): boolean {
    return false
  }

  async apply(editsIn: WorkspaceEdit | readonly unknown[]): Promise<BulkEditResult> {
    const rawEdits = Array.isArray(editsIn) ? editsIn : (editsIn as WorkspaceEdit).edits
    const byResource = new Map<string, { resource: URI; edits: WorkspaceTextEdit[] }>()
    for (const edit of rawEdits) {
      if (!isWorkspaceTextEdit(edit)) {
        throw new Error('FileBulkEditService: only text edits are supported')
      }
      const resource = URI.parse(edit.resource.toString())
      const key = resource.toString()
      let group = byResource.get(key)
      if (!group) {
        group = { resource, edits: [] }
        byResource.set(key, group)
      }
      group.edits.push(edit)
    }

    const monacoNs = MonacoLoader.get()
    let totalEdits = 0
    let totalFiles = 0
    for (const { resource, edits } of byResource.values()) {
      const model = MonacoModelRegistry.peek(resource)
      if (model && !model.isDisposed()) {
        const operations = edits.map((e) => ({
          range: monacoNs.Range.lift(e.textEdit.range),
          text: e.textEdit.text,
          forceMoveMarkers: true,
        }))
        model.pushStackElement()
        model.pushEditOperations([], operations, () => null)
        model.pushStackElement()
      } else {
        const current = await this._fileService.readFileText(resource)
        const next = applyTextEditsToString(
          current,
          edits.map((e) => e.textEdit),
        )
        if (next !== current) await this._fileService.writeFile(resource, next)
      }
      totalFiles += 1
      totalEdits += edits.length
    }

    return {
      ariaSummary: `Made ${totalEdits} edits in ${totalFiles} files`,
      isApplied: totalEdits > 0,
    }
  }
}
