/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Bridges Monaco's "open a resource other than the current model" hook (fired by
 *  Go to Definition / peek "open" when the target is in another file) to the
 *  workbench editor service. Without this, cross-file F12 silently does nothing
 *  in a standalone Monaco editor. Language-agnostic — any provider returning a
 *  Location in a different file benefits.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorService,
  IInstantiationService,
  URI,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { MonacoLoader, type monaco } from '../workbench/editor/monaco/MonacoLoader.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'

export class EditorOpenerContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IEditorService private readonly _editorService: IEditorService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
  ) {
    super()
    void MonacoLoader.ensureInitialized().then((monacoNs) => {
      if (this._store.isDisposed) return
      this._register(
        monacoNs.editor.registerEditorOpener({
          openCodeEditor: (source, resource, selectionOrPosition) =>
            this._open(source, resource, selectionOrPosition),
        }),
      )
    })
  }

  private _open(
    source: monaco.editor.ICodeEditor,
    resource: monaco.Uri,
    selectionOrPosition?: monaco.IRange | monaco.IPosition,
  ): boolean {
    // Same-model navigation is handled by Monaco itself; only act cross-file.
    if (source.getModel()?.uri.toString() === resource.toString()) return false

    const input = this._instantiation.createInstance(
      FileEditorInput,
      URI.parse(resource.toString()),
    )
    this._editorService.openEditor(input)

    const position = toPosition(selectionOrPosition)
    if (position) void this._reveal(input, position)
    return true
  }

  /** Monaco may not have mounted the editor yet; retry briefly (cf. historyActions). */
  private async _reveal(input: FileEditorInput, position: monaco.IPosition): Promise<void> {
    const apply = (): boolean => {
      const editor = FileEditorRegistry.get(input)
      if (!editor) return false
      editor.setPosition(position)
      editor.revealLineInCenterIfOutsideViewport(position.lineNumber)
      editor.focus()
      return true
    }
    if (apply()) return
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    if (apply()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    apply()
  }
}

function toPosition(
  value: monaco.IRange | monaco.IPosition | undefined,
): monaco.IPosition | undefined {
  if (!value) return undefined
  if ('startLineNumber' in value) {
    return { lineNumber: value.startLineNumber, column: value.startColumn }
  }
  return { lineNumber: value.lineNumber, column: value.column }
}
