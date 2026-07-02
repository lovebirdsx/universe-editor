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
 *  It also honours `insertAsSnippet` edits (drop/paste-to-link emits these):
 *  monaco's `dropOrPasteInto` builds a `ResourceTextEdit` whose text is a snippet
 *  (`[${1:text}](path)$0`) and the standalone bulk-edit path doesn't interpret it.
 *  We route those through `SnippetController2` on the target editor so the `${1:…}`
 *  placeholder is inserted *and selected* (VSCode's behaviour). Non-snippet edits
 *  (rename) are untouched.
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
  readonly textEdit: {
    readonly range: monaco.IRange
    readonly text: string
    readonly insertAsSnippet?: boolean
  }
  readonly versionId?: number | undefined
}

interface WorkspaceEdit {
  readonly edits: readonly unknown[]
}

/** Monaco passes `{ editor }` as the second arg to IBulkEditService.apply. */
interface BulkEditOptions {
  readonly editor?: monaco.editor.ICodeEditor
}

interface SnippetInsertController {
  insert(template: string): void
}

interface BulkEditResult {
  ariaSummary: string
  isApplied: boolean
}

const SNIPPET_CONTROLLER_ID = 'snippetController2'

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

/**
 * Reduce a snippet template to the plain text it would insert with every tab stop
 * left empty and every placeholder shown as its default text: `${1:alt text}` →
 * `alt text`, `$0`/`${2}` → ``, and escaped `\$`/`\}`/`\\` → their literal char.
 * Used only as a fallback when a snippet edit can't be routed through
 * SnippetController2 (no target editor) — so `${1:…}` never lands literally.
 */
export function stripSnippet(template: string): string {
  let out = ''
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]
    if (ch === '\\') {
      const next = template[i + 1]
      if (next === '$' || next === '}' || next === '\\') {
        out += next
        i++
        continue
      }
      out += ch
      continue
    }
    if (ch === '$') {
      const rest = template.slice(i)
      // `${n:placeholder}` → keep the placeholder text
      const named = /^\$\{\d+:([^}]*)\}/.exec(rest)
      if (named) {
        out += named[1]
        i += named[0].length - 1
        continue
      }
      // `${n}` or `$n` → empty tab stop
      const bare = /^\$\{\d+\}|^\$\d+/.exec(rest)
      if (bare) {
        i += bare[0].length - 1
        continue
      }
    }
    out += ch
  }
  return out
}

export class FileBulkEditService {
  constructor(@IFileService private readonly _fileService: IFileService) {}

  hasPreviewHandler(): boolean {
    return false
  }

  async apply(
    editsIn: WorkspaceEdit | readonly unknown[],
    opts?: BulkEditOptions,
  ): Promise<BulkEditResult> {
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

    // Snippet edits (drop/paste-to-link) go through SnippetController2 on the
    // target editor so the `${1:…}` placeholder is inserted *and selected*. This
    // is a single-range, single-file, current-editor operation in practice.
    const snippetResult = this._tryApplySnippet(byResource, opts?.editor)
    if (snippetResult) return snippetResult

    const monacoNs = MonacoLoader.get()
    let totalEdits = 0
    let totalFiles = 0
    for (const { resource, edits } of byResource.values()) {
      const model = MonacoModelRegistry.peek(resource)
      if (model && !model.isDisposed()) {
        const operations = edits.map((e) => ({
          range: monacoNs.Range.lift(e.textEdit.range),
          // A stray snippet edit that didn't take the SnippetController path
          // (no editor / model mismatch) must not land `${1:…}`/`$0` literally.
          text: e.textEdit.insertAsSnippet ? stripSnippet(e.textEdit.text) : e.textEdit.text,
          forceMoveMarkers: true,
        }))
        model.pushStackElement()
        model.pushEditOperations([], operations, () => null)
        model.pushStackElement()
      } else {
        const current = await this._fileService.readFileText(resource)
        const next = applyTextEditsToString(
          current,
          edits.map((e) => ({
            range: e.textEdit.range,
            text: e.textEdit.insertAsSnippet ? stripSnippet(e.textEdit.text) : e.textEdit.text,
          })),
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

  /**
   * Fast path for snippet insertion (drop/paste-to-link): when every edit is a
   * snippet targeting the given editor's current model, insert each via
   * SnippetController2 (which selects the `${1:…}` placeholder). Returns undefined
   * when this doesn't apply, so `apply` falls back to the plain-text path.
   */
  private _tryApplySnippet(
    byResource: Map<string, { resource: URI; edits: WorkspaceTextEdit[] }>,
    editor: monaco.editor.ICodeEditor | undefined,
  ): BulkEditResult | undefined {
    if (!editor) return undefined
    const model = editor.getModel()
    if (!model) return undefined

    const groups = Array.from(byResource.values())
    // Normalise through the same platform `URI.parse` the group keys use: a
    // monaco `Uri.toString()` percent-encodes the Windows drive-letter colon
    // (`c%3A`) while our platform URI decodes it (`c:`), so comparing the raw
    // monaco string against the parsed group key mismatches and the snippet path
    // (placeholder selection) is silently skipped for the plain-text fallback.
    const targetKey = URI.parse(model.uri.toString()).toString()
    const allSnippetOnTarget = groups.every(
      (g) =>
        g.resource.toString() === targetKey && g.edits.every((e) => e.textEdit.insertAsSnippet),
    )
    if (!allSnippetOnTarget) return undefined

    const controller = editor.getContribution(
      SNIPPET_CONTROLLER_ID,
    ) as SnippetInsertController | null
    if (!controller || typeof controller.insert !== 'function') return undefined

    const monacoNs = MonacoLoader.get()
    let totalEdits = 0
    for (const { edits } of groups) {
      for (const e of edits) {
        // Point the selection at the edit range; SnippetController inserts there
        // and drives the tab stops / placeholder selection from that position.
        editor.setSelection(monacoNs.Range.lift(e.textEdit.range))
        controller.insert(e.textEdit.text)
        totalEdits += 1
      }
    }
    editor.focus()
    return { ariaSummary: `Inserted ${totalEdits} snippet edits`, isApplied: totalEdits > 0 }
  }
}
