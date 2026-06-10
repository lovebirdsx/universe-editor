/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Bridges Monaco's "open a resource other than the current model" hook (fired by
 *  Go to Definition / References peek "open" when the target is in another file)
 *  to the workbench editor service. Without this, cross-file F12 silently does
 *  nothing in a standalone Monaco editor.
 *
 *  We register directly on ICodeEditorService rather than via the higher-level
 *  `monaco.editor.registerEditorOpener`, because that wrapper always reports the
 *  *source* editor as the opened one. The references peek (ReferencesController)
 *  compares the returned editor against the source to decide its next move:
 *  same editor → keep the peek open and just re-preview; different editor → close
 *  the peek and follow the user to the target file. Reporting the source for a
 *  cross-file jump therefore wedges the peek open ("press Enter, content shows,
 *  but never jumps"). Returning the *real* target editor restores VSCode parity.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorGroupsService,
  IInstantiationService,
  URI,
  isEqualResource,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  MonacoLoader,
  type ICodeEditorOpenInput,
  type monaco,
} from '../workbench/editor/monaco/MonacoLoader.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'

export class EditorOpenerContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IEditorGroupsService private readonly _groupsService: IEditorGroupsService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
  ) {
    super()
    void MonacoLoader.registerCodeEditorOpenHandler((input, source) =>
      this._open(input, source),
    ).then((disposable) => {
      if (this._store.isDisposed) disposable.dispose()
      else this._register(disposable)
    })
  }

  private async _open(
    input: ICodeEditorOpenInput,
    source: monaco.editor.ICodeEditor | null,
  ): Promise<monaco.editor.ICodeEditor | null> {
    const resource = input.resource
    // Same-model navigation: let monaco's default handler move the cursor inside
    // the source editor (and report it as the opened editor, so a same-file
    // reference keeps the peek open as VSCode does).
    if (source && source.getModel()?.uri.toString() === resource.toString()) return null

    const target = URI.parse(resource.toString())
    const fileInput = this._revealExistingOrOpen(target)
    const editor = await waitForEditor(fileInput)
    if (!editor) return null

    applySelection(editor, input.options?.selection)
    editor.focus()
    return editor
  }

  /** Activate the file if it's already open in some group; otherwise open it. */
  private _revealExistingOrOpen(uri: URI): FileEditorInput {
    for (const group of this._groupsService.groups) {
      for (const editor of group.editors) {
        if (editor instanceof FileEditorInput && isEqualResource(editor.resource, uri)) {
          this._groupsService.activateGroup(group)
          group.setActive(editor)
          return editor
        }
      }
    }
    const input = this._instantiation.createInstance(FileEditorInput, uri)
    this._groupsService.activeGroup.openEditor(input, { activate: true, pinned: true })
    return input
  }
}

/** Monaco may not have mounted the editor yet; retry briefly (cf. gotoSymbolActions). */
async function waitForEditor(
  input: FileEditorInput,
): Promise<monaco.editor.IStandaloneCodeEditor | undefined> {
  let editor = FileEditorRegistry.get(input)
  if (editor) return editor
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  editor = FileEditorRegistry.get(input)
  if (editor) return editor
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  editor = FileEditorRegistry.get(input)
  if (editor) return editor
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  return FileEditorRegistry.get(input)
}

function applySelection(
  editor: monaco.editor.IStandaloneCodeEditor,
  selection: monaco.IRange | monaco.IPosition | undefined,
): void {
  if (!selection) return
  if ('startLineNumber' in selection) {
    // A collapsed range (cursor) is fine here — that's what peek "go to" passes.
    editor.setSelection(selection)
    editor.revealRangeInCenterIfOutsideViewport(selection)
  } else {
    editor.setPosition(selection)
    editor.revealPositionInCenterIfOutsideViewport(selection)
  }
}
