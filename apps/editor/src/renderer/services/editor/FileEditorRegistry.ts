/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  FileEditorRegistry — tracks the live Monaco editor instance backing each
 *  mounted EditorInput. Used by status-bar / command contributions that
 *  need to read cursor position or language from the editor currently showing
 *  a given input. Split views can mount multiple FileEditor components for the
 *  same input, so registrations are kept in order and fall back to the previous
 *  live instance when the latest one unmounts.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '@universe-editor/platform'
import type { EditorInput } from '@universe-editor/platform'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

class FileEditorRegistryImpl {
  private readonly _map = new Map<EditorInput, monaco.editor.IStandaloneCodeEditor[]>()
  private readonly _onDidChange = new Emitter<EditorInput>()
  readonly onDidChange = this._onDidChange.event

  register(input: EditorInput, editor: monaco.editor.IStandaloneCodeEditor): void {
    const editors = this._map.get(input) ?? []
    const existing = editors.indexOf(editor)
    if (existing !== -1) editors.splice(existing, 1)
    editors.push(editor)
    this._map.set(input, editors)
    this._onDidChange.fire(input)
  }

  unregister(input: EditorInput, editor: monaco.editor.IStandaloneCodeEditor): void {
    const editors = this._map.get(input)
    if (!editors) return
    const index = editors.indexOf(editor)
    if (index === -1) return
    editors.splice(index, 1)
    if (editors.length === 0) {
      this._map.delete(input)
    }
    this._onDidChange.fire(input)
  }

  get(input: EditorInput): monaco.editor.IStandaloneCodeEditor | undefined {
    const editors = this._map.get(input)
    return editors?.[editors.length - 1]
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const FileEditorRegistry = new FileEditorRegistryImpl()
