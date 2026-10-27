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
  IEditorResolverService,
  IFileService,
  IInstantiationService,
  IUriIdentityService,
  IWindowsService,
  URI,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  MonacoLoader,
  type ICodeEditorOpenInput,
  type monaco,
} from '../workbench/editor/monaco/MonacoLoader.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import {
  findExistingFileEditor,
  toRevealRange,
  waitForFileEditor,
} from '../services/editor/revealEditorPosition.js'
import { isImageResource } from '../services/editor/imageFileTypes.js'
import { IWindowFocusService } from '../services/windows/windowFocusService.js'
import { IAuxiliaryEditorWindowService } from '../services/windows/auxiliaryEditorWindowService.js'
import { openUriWithTarget } from '../services/editor/openWithTarget.js'

export class EditorOpenerContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IEditorGroupsService private readonly _groupsService: IEditorGroupsService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IFileService private readonly _fileService: IFileService,
    @IWindowsService private readonly _windowsService: IWindowsService,
    @IEditorResolverService private readonly _editorResolver: IEditorResolverService,
    @IWindowFocusService private readonly _windowFocus: IWindowFocusService,
    @IAuxiliaryEditorWindowService private readonly _aux: IAuxiliaryEditorWindowService,
  ) {
    super()
    void MonacoLoader.registerCodeEditorOpenHandler((input, source, sideBySide) =>
      this._open(input, source, sideBySide),
    ).then((disposable) => {
      if (this._store.isDisposed) disposable.dispose()
      else this._register(disposable)
    })
  }

  private async _open(
    input: ICodeEditorOpenInput,
    source: monaco.editor.ICodeEditor | null,
    sideBySide = false,
  ): Promise<monaco.editor.ICodeEditor | null> {
    const resource = input.resource
    // Same-model navigation: let monaco's default handler move the cursor inside
    // the source editor (and report it as the opened editor, so a same-file
    // reference keeps the peek open as VSCode does).
    if (source && source.getModel()?.uri.toString() === resource.toString()) return null

    const target = URI.parse(resource.toString())
    // A directory link target (e.g. a markdown `[dir](D:/foo)`) can't be shown as
    // an editor — open it in a new window. Text mode can't observe Alt through
    // monaco, so we always use a new window here (parity with a dropped folder).
    if (await this._isDirectory(target)) {
      await this._windowsService.openWindow(target)
      return null
    }

    // An image link target (a markdown `[pic](./a.png)` documentLink) must route
    // through the editor resolver so it opens in the image preview — opening it as
    // a text FileEditorInput would show the binary as garbled text. There is no
    // text cursor to place, so report no monaco editor.
    if (isImageResource(target)) {
      if (sideBySide) await this._openSide(target)
      else void this._editorResolver.openEditor(target, { pinned: true })
      return null
    }

    // Ctrl+Alt+click on a document link reaches us with sideBySide=true (Monaco
    // folds the modifiers before calling the opener). Honor it instead of
    // dropping the target into the current group.
    if (sideBySide) {
      const sideInput = await this._openSide(target)
      if (sideInput) {
        const editor = await waitForFileEditor(sideInput, this._store)
        if (editor) {
          applySelection(editor, input.options?.selection)
          editor.focus()
          return editor
        }
      }
      // Side-open failed; fall through to the default path.
    }

    const fileInput = this._revealExistingOrOpen(target)
    // Owned wait: a target opened into a group that never mounts must not keep
    // the registry/input subscriptions alive past this contribution's lifetime.
    const editor = await waitForFileEditor(fileInput, this._store)
    if (!editor) return null

    applySelection(editor, input.options?.selection)
    editor.focus()
    return editor
  }

  /** Open a document-link target in the group to the right. Returns the
   *  FileEditorInput when the target is a text file, undefined otherwise. */
  private async _openSide(uri: URI): Promise<FileEditorInput | undefined> {
    const result = await openUriWithTarget(
      {
        groups: this._groupsService,
        aux: this._aux,
        inst: this._instantiation,
        uriIdentity: this._uriIdentity,
        resolver: this._editorResolver,
      },
      uri,
      'side',
      { pinned: true },
    )
    return result.handled && result.editor instanceof FileEditorInput ? result.editor : undefined
  }

  private async _isDirectory(uri: URI): Promise<boolean> {
    try {
      return (await this._fileService.stat(uri)).isDirectory
    } catch {
      return false
    }
  }

  /** Activate the file if it's already open in some group; otherwise open it. */
  private _revealExistingOrOpen(uri: URI): FileEditorInput {
    const existing = findExistingFileEditor(this._groupsService, this._uriIdentity, uri)
    if (existing) {
      this._groupsService.activateGroup(existing.group)
      existing.group.setActive(existing.editor)
      this._windowFocus.focusGroup(existing.group)
      return existing.editor
    }
    const input = this._instantiation.createInstance(FileEditorInput, uri)
    const target = this._groupsService.activeGroupForOpen
    target.openEditor(input, { activate: true, pinned: true })
    if (target !== this._groupsService.openTargetGroup) this._groupsService.activateGroup(target)
    this._windowFocus.focusGroup(target)
    return input
  }
}

function applySelection(
  editor: monaco.editor.IStandaloneCodeEditor,
  selection: monaco.IRange | monaco.IPosition | undefined,
): void {
  if (!selection) return
  if ('startLineNumber' in selection) {
    const range = toRevealRange(selection)
    editor.setSelection(range)
    editor.revealRangeInCenterIfOutsideViewport(range)
  } else {
    editor.setPosition(selection)
    editor.revealPositionInCenterIfOutsideViewport(selection)
  }
}
