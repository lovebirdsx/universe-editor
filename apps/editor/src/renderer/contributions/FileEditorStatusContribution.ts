/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  FileEditorStatusContribution — keeps three status-bar entries (cursor /
 *  language / encoding) in sync with the active editor. Entries appear only
 *  while a FileEditorInput is active; switching away (Welcome / Settings / no
 *  editor) disposes them. The cursor entry updates on every cursor move via
 *  the Monaco editor instance registered in FileEditorRegistry; the language
 *  entry follows the model's language (Change Language Mode can switch it at
 *  any time) and opens that picker on click.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableStore,
  IEditorService,
  IStatusBarService,
  IWorkbenchContribution,
  StatusBarAlignment,
  autorun,
  localize,
  type IStatusBarEntryAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { ChangeLanguageModeAction } from '../actions/languageModeActions.js'
import { languageDisplayName } from '../workbench/files/languageDisplay.js'

export class FileEditorStatusContribution extends Disposable implements IWorkbenchContribution {
  private _cursorEntry: IStatusBarEntryAccessor | undefined
  private _languageEntry: IStatusBarEntryAccessor | undefined
  private _encodingEntry: IStatusBarEntryAccessor | undefined
  private readonly _cursorStore = this._register(new DisposableStore())
  private readonly _registryStore = this._register(new DisposableStore())
  private readonly _languageStore = this._register(new DisposableStore())

  constructor(
    @IEditorService editorService: IEditorService,
    @IStatusBarService private readonly _statusBarService: IStatusBarService,
  ) {
    super()

    this._register(
      autorun((r) => {
        const active = editorService.activeEditor.read(r)
        if (active instanceof FileEditorInput) {
          this._showFor(active)
        } else {
          this._hide()
        }
      }),
    )

    this._register({
      dispose: () => this._hide(),
    })
  }

  private _showFor(input: FileEditorInput): void {
    // Encoding doesn't change for a given input; the language can (Change
    // Language Mode), so the entry also follows onDidChangeLanguage.
    this._ensureLanguageAndEncoding(input)
    this._bindLanguage(input)
    this._bindCursor(input)
  }

  private _languageEntryData(language: string) {
    return {
      text: languageDisplayName(language),
      tooltip: localize('status.selectLanguageMode', 'Select Language Mode'),
      command: ChangeLanguageModeAction.ID,
      alignment: StatusBarAlignment.Right,
      priority: 90,
    }
  }

  private _ensureLanguageAndEncoding(input: FileEditorInput): void {
    if (!this._languageEntry) {
      this._languageEntry = this._statusBarService.addEntry(this._languageEntryData(input.language))
    } else {
      this._languageEntry.update(this._languageEntryData(input.language))
    }
    if (!this._encodingEntry) {
      this._encodingEntry = this._statusBarService.addEntry({
        text: 'UTF-8',
        tooltip: localize('status.editorEncoding', 'Editor Encoding'),
        alignment: StatusBarAlignment.Right,
        priority: 80,
      })
    }
  }

  private _bindLanguage(input: FileEditorInput): void {
    this._languageStore.clear()
    this._languageStore.add(
      input.onDidChangeLanguage((language) => {
        this._languageEntry?.update(this._languageEntryData(language))
      }),
    )
  }

  private _bindCursor(input: FileEditorInput): void {
    this._cursorStore.clear()
    this._registryStore.clear()

    const attach = () => {
      this._cursorStore.clear()
      const editor = FileEditorRegistry.get(input)
      if (!editor) {
        this._renderCursor(1, 1)
        return
      }
      const pos = editor.getPosition()
      this._renderCursor(pos?.lineNumber ?? 1, pos?.column ?? 1)
      this._cursorStore.add(
        editor.onDidChangeCursorPosition((e) => {
          this._renderCursor(e.position.lineNumber, e.position.column)
        }),
      )
    }
    attach()
    this._registryStore.add(
      FileEditorRegistry.onDidChange((changed) => {
        if (changed === input) attach()
      }),
    )
  }

  private _renderCursor(line: number, column: number): void {
    const text = localize('status.cursorPositionText', 'Ln {line}, Col {column}', {
      line,
      column,
    })
    if (!this._cursorEntry) {
      this._cursorEntry = this._statusBarService.addEntry({
        text,
        tooltip: localize('status.cursorPosition', 'Cursor Position'),
        alignment: StatusBarAlignment.Right,
        priority: 100,
      })
    } else {
      this._cursorEntry.update({
        text,
        tooltip: localize('status.cursorPosition', 'Cursor Position'),
        alignment: StatusBarAlignment.Right,
        priority: 100,
      })
    }
  }

  private _hide(): void {
    this._cursorStore.clear()
    this._registryStore.clear()
    this._languageStore.clear()
    this._cursorEntry?.dispose()
    this._cursorEntry = undefined
    this._languageEntry?.dispose()
    this._languageEntry = undefined
    this._encodingEntry?.dispose()
    this._encodingEntry = undefined
  }
}
