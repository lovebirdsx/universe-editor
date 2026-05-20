/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  FileEditorStatusContribution — keeps three status-bar entries (cursor /
 *  language / encoding) in sync with the active editor. Entries appear only
 *  while a FileEditorInput is active; switching away (Welcome / Settings / no
 *  editor) disposes them. The cursor entry updates on every cursor move via
 *  the Monaco editor instance registered in FileEditorRegistry.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorService,
  IStatusBarService,
  IWorkbenchContribution,
  StatusBarAlignment,
  autorun,
  localize,
  type IDisposable,
  type IStatusBarEntryAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'

function languageLabel(id: string): string {
  if (id === 'plaintext') return 'Plain Text'
  if (id === 'json') return 'JSON'
  if (id === 'markdown') return 'Markdown'
  if (id === 'typescript') return 'TypeScript'
  if (id === 'javascript') return 'JavaScript'
  if (id === 'html') return 'HTML'
  if (id === 'css') return 'CSS'
  if (id === 'xml') return 'XML'
  if (id === 'yaml') return 'YAML'
  return id.charAt(0).toUpperCase() + id.slice(1)
}

export class FileEditorStatusContribution extends Disposable implements IWorkbenchContribution {
  private _cursorEntry: IStatusBarEntryAccessor | undefined
  private _languageEntry: IStatusBarEntryAccessor | undefined
  private _encodingEntry: IStatusBarEntryAccessor | undefined
  private _cursorSub: IDisposable | undefined
  private _registrySub: IDisposable | undefined

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
    // Language + encoding don't change for a given input; recreate on input
    // switch but skip work when re-firing for the same input.
    this._ensureLanguageAndEncoding(input)
    this._bindCursor(input)
  }

  private _ensureLanguageAndEncoding(input: FileEditorInput): void {
    if (!this._languageEntry) {
      this._languageEntry = this._statusBarService.addEntry({
        text: languageLabel(input.language),
        tooltip: localize('status.editorLanguage', 'Editor Language'),
        alignment: StatusBarAlignment.Right,
        priority: 90,
      })
    } else {
      this._languageEntry.update({
        text: languageLabel(input.language),
        tooltip: localize('status.editorLanguage', 'Editor Language'),
        alignment: StatusBarAlignment.Right,
        priority: 90,
      })
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

  private _bindCursor(input: FileEditorInput): void {
    this._cursorSub?.dispose()
    this._cursorSub = undefined
    this._registrySub?.dispose()
    this._registrySub = undefined

    const attach = () => {
      this._cursorSub?.dispose()
      this._cursorSub = undefined
      const editor = FileEditorRegistry.get(input)
      if (!editor) {
        this._renderCursor(1, 1)
        return
      }
      const pos = editor.getPosition()
      this._renderCursor(pos?.lineNumber ?? 1, pos?.column ?? 1)
      this._cursorSub = editor.onDidChangeCursorPosition((e) => {
        this._renderCursor(e.position.lineNumber, e.position.column)
      })
    }
    attach()
    this._registrySub = FileEditorRegistry.onDidChange((changed) => {
      if (changed === input) attach()
    })
  }

  private _renderCursor(line: number, column: number): void {
    const text = `Ln ${line}, Col ${column}`
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
    this._cursorSub?.dispose()
    this._cursorSub = undefined
    this._registrySub?.dispose()
    this._registrySub = undefined
    this._cursorEntry?.dispose()
    this._cursorEntry = undefined
    this._languageEntry?.dispose()
    this._languageEntry = undefined
    this._encodingEntry?.dispose()
    this._encodingEntry = undefined
  }
}
