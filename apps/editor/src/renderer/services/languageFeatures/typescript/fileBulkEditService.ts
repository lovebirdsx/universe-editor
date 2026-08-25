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
 *  File-level operations (create/rename/delete — from the extension API's
 *  `workspace.applyEdit`) go through IFileService, executed in array order so
 *  text edits interleaved with them apply in `documentChanges` sequence.
 *
 *  Injected as an `overrideServices` entry at every `editor.create` call site
 *  (collected on MonacoLoader) so Monaco's rename contribution resolves this
 *  instance instead of the standalone one.
 *--------------------------------------------------------------------------------------------*/

import { dirname, FileSystemError, IFileService, URI } from '@universe-editor/platform'
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

/**
 * Monaco-shaped file operation (`monaco.languages.IWorkspaceFileEdit`). create =
 * `newResource` only, rename = both, delete = `oldResource` only. `folder` marks
 * a directory create (carried by Monaco's options; never set by the LSP wire).
 */
interface WorkspaceFileEdit {
  readonly oldResource?: monaco.Uri
  readonly newResource?: monaco.Uri
  readonly options?: {
    readonly overwrite?: boolean
    readonly ignoreIfNotExists?: boolean
    readonly ignoreIfExists?: boolean
    readonly recursive?: boolean
    readonly folder?: boolean
    readonly skipTrashBin?: boolean
  }
}

interface WorkspaceEdit {
  readonly edits: readonly unknown[]
}

/** Monaco passes `{ editor }` as the second arg to IBulkEditService.apply. */
interface BulkEditOptions {
  readonly editor?: monaco.editor.ICodeEditor
  /**
   * Force every edit to land on disk (not just in an open model). Used by the
   * "update links on file move" flow, which rewrites the *referrer* files —
   * conceptually closed files whose new content must survive on disk. Closing an
   * editor disposes its model asynchronously (React unmount), so right after
   * `closeAllEditors` a just-closed file can still have a lingering model in the
   * registry; the plain in-memory branch would then push the edit into that
   * orphan model and lose it on dispose, never touching disk. With this set we
   * always write disk (and also sync a live model so a genuinely-open view stays
   * consistent), making the outcome independent of the model-dispose race.
   */
  readonly persistToDisk?: boolean
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

function isWorkspaceFileEdit(edit: unknown): edit is WorkspaceFileEdit {
  if (typeof edit !== 'object' || edit === null || isWorkspaceTextEdit(edit)) return false
  const e = edit as { oldResource?: unknown; newResource?: unknown }
  return e.oldResource != null || e.newResource != null
}

/** Parent directory of `resource`, used to pre-create create-target folders. */
function parentResource(resource: URI): URI {
  return resource.with({ path: dirname(resource.path) })
}

/** LSP semantics for a create landing on an existing path: `overwrite` wins over
 *  `ignoreIfExists` (the collision becomes a replace); `ignoreIfExists` alone
 *  makes it a no-op; neither makes it an EEXIST failure. */
function existingCreateTargetPolicy(options: {
  readonly overwrite?: boolean
  readonly ignoreIfExists?: boolean
}): 'replace' | 'skip' | 'fail' {
  if (options.overwrite === true) return 'replace'
  if (options.ignoreIfExists === true) return 'skip'
  return 'fail'
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
    if (rawEdits.some((e) => !isWorkspaceTextEdit(e))) {
      return this._applySequential(rawEdits)
    }

    const byResource = this._groupByResource(rawEdits as readonly WorkspaceTextEdit[])

    // Snippet edits (drop/paste-to-link) go through SnippetController2 on the
    // target editor so the `${1:…}` placeholder is inserted *and selected*. This
    // is a single-range, single-file, current-editor operation in practice.
    const snippetResult = this._tryApplySnippet(byResource, opts?.editor)
    if (snippetResult) return snippetResult

    const { edits, files } = await this._applyTextGroups(byResource, opts)
    return {
      ariaSummary: `Made ${edits} edits in ${files} files`,
      isApplied: edits > 0,
    }
  }

  /**
   * Ordered path for edits carrying file operations (create/rename/delete, e.g.
   * from `workspace.applyEdit`): VSCode's `documentChanges` semantics run every
   * entry in array order, so a text edit listed before a rename still targets
   * the old URI and one listed after it the new. Consecutive text edits are
   * grouped per resource and flushed as a batch whenever a file operation is
   * reached; any failure throws, aborting the remaining entries.
   */
  private async _applySequential(rawEdits: readonly unknown[]): Promise<BulkEditResult> {
    let totalEdits = 0
    let totalFiles = 0
    let pending: WorkspaceTextEdit[] = []
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return
      const { edits, files } = await this._applyTextGroups(this._groupByResource(pending))
      totalEdits += edits
      totalFiles += files
      pending = []
    }
    for (const edit of rawEdits) {
      if (isWorkspaceTextEdit(edit)) {
        pending.push(edit)
        continue
      }
      await flush()
      if (!isWorkspaceFileEdit(edit)) {
        throw new Error('FileBulkEditService: unsupported edit (neither text nor file operation)')
      }
      await this._applyFileEdit(edit)
      totalEdits += 1
    }
    await flush()
    return {
      ariaSummary: `Made ${totalEdits} edits in ${totalFiles} files`,
      isApplied: totalEdits > 0,
    }
  }

  private _groupByResource(
    edits: readonly WorkspaceTextEdit[],
  ): Map<string, { resource: URI; edits: WorkspaceTextEdit[] }> {
    const byResource = new Map<string, { resource: URI; edits: WorkspaceTextEdit[] }>()
    for (const edit of edits) {
      const resource = URI.parse(edit.resource.toString())
      const key = resource.toString()
      let group = byResource.get(key)
      if (!group) {
        group = { resource, edits: [] }
        byResource.set(key, group)
      }
      group.edits.push(edit)
    }
    return byResource
  }

  /** Apply grouped text edits: live models get undoable edits, the rest hit disk. */
  private async _applyTextGroups(
    byResource: Map<string, { resource: URI; edits: WorkspaceTextEdit[] }>,
    opts?: BulkEditOptions,
  ): Promise<{ edits: number; files: number }> {
    const monacoNs = MonacoLoader.get()
    let totalEdits = 0
    let totalFiles = 0
    for (const { resource, edits } of byResource.values()) {
      const model = MonacoModelRegistry.peek(resource)
      const liveModel = model && !model.isDisposed() ? model : undefined
      if (liveModel && !opts?.persistToDisk) {
        this._applyToModel(liveModel, edits, monacoNs)
      } else {
        // Disk is the source of truth here. Also mirror into a lingering model so
        // a genuinely-open view (or an orphan awaiting dispose) doesn't overwrite
        // what we just wrote when it flushes/disposes.
        const current = await this._fileService.readFileText(resource)
        const next = applyTextEditsToString(
          current,
          edits.map((e) => ({
            range: e.textEdit.range,
            text: e.textEdit.insertAsSnippet ? stripSnippet(e.textEdit.text) : e.textEdit.text,
          })),
        )
        if (next !== current) await this._fileService.writeFile(resource, next)
        if (liveModel && liveModel.getValue() !== next) liveModel.setValue(next)
      }
      totalFiles += 1
      totalEdits += edits.length
    }
    return { edits: totalEdits, files: totalFiles }
  }

  /**
   * One file operation via IFileService, honouring the option semantics:
   * `overwrite` wins over `ignoreIfExists`; `ignoreIfExists`/`ignoreIfNotExists`
   * turn a would-be failure into a no-op (counted as applied). Anything else
   * throws FileSystemError so the caller rejects the whole edit with false.
   */
  private async _applyFileEdit(edit: WorkspaceFileEdit): Promise<void> {
    const options = edit.options ?? {}
    const oldResource = edit.oldResource ? URI.parse(edit.oldResource.toString()) : undefined
    const newResource = edit.newResource ? URI.parse(edit.newResource.toString()) : undefined

    if (newResource && !oldResource) {
      // create
      if (options.folder === true) {
        if (await this._fileService.exists(newResource)) {
          if (existingCreateTargetPolicy(options) === 'fail') {
            throw new FileSystemError(`create: target already exists: ${newResource}`, 'EEXIST')
          }
          return
        }
        await this._fileService.createDirectory(newResource)
        return
      }
      if (await this._fileService.exists(newResource)) {
        const policy = existingCreateTargetPolicy(options)
        if (policy === 'fail') {
          throw new FileSystemError(`create: target already exists: ${newResource}`, 'EEXIST')
        }
        if (policy === 'skip') return
      } else {
        // fs.writeFile does not create parents; VSCode's createFile does.
        await this._fileService.createDirectory(parentResource(newResource))
      }
      await this._fileService.writeFile(newResource, '')
      return
    }

    if (oldResource && newResource) {
      // rename
      if (!(await this._fileService.exists(oldResource))) {
        if (options.ignoreIfNotExists === true) return
        throw new FileSystemError(`rename: source does not exist: ${oldResource}`, 'ENOENT')
      }
      if (options.overwrite === true && (await this._fileService.exists(newResource))) {
        // Deleting the target first would destroy it irreversibly when the
        // rename then fails (EXDEV, ACL, file lock). Park it at a same-directory
        // sibling instead (same volume, so this rename can't fail cross-device),
        // delete the backup once the real rename lands, and restore it when it
        // does not.
        const backup = newResource.with({
          path: `${newResource.path}.rename-overwrite-${Math.random().toString(36).slice(2, 10)}`,
        })
        await this._fileService.rename(newResource, backup, {})
        try {
          await this._fileService.rename(oldResource, newResource, { overwrite: true })
        } catch (err) {
          await this._fileService.rename(backup, newResource, { overwrite: true }).catch(() => {})
          throw err
        }
        await this._fileService.delete(backup, { recursive: true })
        return
      }
      await this._fileService.rename(oldResource, newResource, {
        overwrite: options.overwrite === true,
      })
      return
    }

    if (oldResource) {
      // delete
      if (!(await this._fileService.exists(oldResource))) {
        if (options.ignoreIfNotExists === true) return
        throw new FileSystemError(`delete: resource does not exist: ${oldResource}`, 'ENOENT')
      }
      // `skipTrashBin: false` means "use the trash if there is one", and there
      // is none on a remote host — asking anyway would fail the whole edit.
      // There is no dialog to consult on this path, so degrade silently the way
      // VSCode's bulkFileEdits does.
      const caps = this._fileService.getCapabilities
        ? await this._fileService.getCapabilities(oldResource)
        : undefined
      await this._fileService.delete(oldResource, {
        recursive: options.recursive === true,
        useTrash: options.skipTrashBin !== true && (caps?.supportsTrash ?? true),
      })
      return
    }

    throw new Error('FileBulkEditService: file operation without old/new resource')
  }

  /** Apply edits to a live model in-place (undoable, visible in the editor). */
  private _applyToModel(
    model: monaco.editor.ITextModel,
    edits: readonly WorkspaceTextEdit[],
    monacoNs: typeof monaco,
  ): void {
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
