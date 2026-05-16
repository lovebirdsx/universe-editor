/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  FileEditorRegistry — tracks the live Monaco editor instance backing each
 *  mounted FileEditorInput. Used by status-bar / command contributions that
 *  need to read cursor position or language from the editor currently showing
 *  a given input. Registrations are last-write-wins: in split view both
 *  FileEditor components register against the same input key, and the most
 *  recently mounted one is the visible "active" instance for the active group.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '@universe-editor/platform'
import type { monaco } from './monaco/MonacoLoader.js'
import type { FileEditorInput } from './FileEditorInput.js'

class FileEditorRegistryImpl {
  private readonly _map = new Map<FileEditorInput, monaco.editor.IStandaloneCodeEditor>()
  private readonly _onDidChange = new Emitter<FileEditorInput>()
  readonly onDidChange = this._onDidChange.event

  register(input: FileEditorInput, editor: monaco.editor.IStandaloneCodeEditor): void {
    this._map.set(input, editor)
    this._onDidChange.fire(input)
  }

  unregister(input: FileEditorInput, editor: monaco.editor.IStandaloneCodeEditor): void {
    if (this._map.get(input) === editor) {
      this._map.delete(input)
      this._onDidChange.fire(input)
    }
  }

  get(input: FileEditorInput): monaco.editor.IStandaloneCodeEditor | undefined {
    return this._map.get(input)
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const FileEditorRegistry = new FileEditorRegistryImpl()
