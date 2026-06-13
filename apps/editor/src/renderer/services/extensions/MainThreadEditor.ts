/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side handler for the host → renderer `mainThreadEditor` channel.
 *  Backs `window.activeTextEditor` and `TextEditor.edit()`: inspects the active
 *  Monaco editor, applies plugin-authored edits as a single undo step, and moves
 *  the selection. Coordinates cross the wire LSP-shaped (0-based); we convert to
 *  Monaco's 1-based positions here, the single boundary where the two meet.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IEditorService, URI, type UriComponents } from '@universe-editor/platform'
import type {
  IActiveTextEditorDto,
  IMainThreadEditor,
  ISelectionDto,
  ITextEditDto,
} from '@universe-editor/extensions-common'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { FileEditorInput } from '../editor/FileEditorInput.js'
import { FileEditorRegistry } from '../editor/FileEditorRegistry.js'

export class MainThreadEditor extends Disposable implements IMainThreadEditor {
  constructor(private readonly _editorService: IEditorService) {
    super()
  }

  $getActiveTextEditor(): Promise<IActiveTextEditorDto | null> {
    const editor = this._activeEditor()
    const model = editor?.getModel()
    if (!editor || !model) return Promise.resolve(null)
    return Promise.resolve({
      uri: model.uri.toJSON() as UriComponents,
      languageId: model.getLanguageId(),
      version: model.getVersionId(),
      text: model.getValue(),
      selections: editor.getSelections()?.map(toSelectionDto) ?? [],
    })
  }

  $applyEdits(
    uri: UriComponents,
    version: number,
    edits: readonly ITextEditDto[],
  ): Promise<boolean> {
    const editor = this._editorFor(uri)
    const model = editor?.getModel()
    if (!editor || !model || model.getVersionId() !== version) return Promise.resolve(false)
    const ops = edits.map<monaco.editor.IIdentifiedSingleEditOperation>((e) => ({
      range: {
        startLineNumber: e.range.start.line + 1,
        startColumn: e.range.start.character + 1,
        endLineNumber: e.range.end.line + 1,
        endColumn: e.range.end.character + 1,
      },
      text: e.text,
    }))
    editor.executeEdits('extHost', ops)
    return Promise.resolve(true)
  }

  $setSelections(uri: UriComponents, selections: readonly ISelectionDto[]): Promise<void> {
    const editor = this._editorFor(uri)
    if (!editor || selections.length === 0) return Promise.resolve()
    editor.setSelections(selections.map(toMonacoSelection))
    const primary = selections[0]!
    editor.revealRangeInCenterIfOutsideViewport({
      startLineNumber: primary.active.line + 1,
      startColumn: primary.active.character + 1,
      endLineNumber: primary.active.line + 1,
      endColumn: primary.active.character + 1,
    })
    return Promise.resolve()
  }

  private _activeEditor(): monaco.editor.IStandaloneCodeEditor | undefined {
    const input = this._editorService.activeEditor.get()
    if (!(input instanceof FileEditorInput)) return undefined
    return FileEditorRegistry.get(input)
  }

  /** The active editor, but only when it is showing the document the host means. */
  private _editorFor(uri: UriComponents): monaco.editor.IStandaloneCodeEditor | undefined {
    const editor = this._activeEditor()
    const model = editor?.getModel()
    if (!editor || !model) return undefined
    const target = URI.revive(uri)
    return target && model.uri.toString() === target.toString() ? editor : undefined
  }
}

function toSelectionDto(sel: monaco.Selection): ISelectionDto {
  return {
    anchor: { line: sel.selectionStartLineNumber - 1, character: sel.selectionStartColumn - 1 },
    active: { line: sel.positionLineNumber - 1, character: sel.positionColumn - 1 },
  }
}

function toMonacoSelection(sel: ISelectionDto): monaco.ISelection {
  return {
    selectionStartLineNumber: sel.anchor.line + 1,
    selectionStartColumn: sel.anchor.character + 1,
    positionLineNumber: sel.active.line + 1,
    positionColumn: sel.active.character + 1,
  }
}
