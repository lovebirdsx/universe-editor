/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  FileEditorRegistry — tracks the live Monaco editor instance backing each
 *  mounted EditorInput. Used by status-bar / command contributions that
 *  need to read cursor position or language from the editor currently showing
 *  a given input. Split views can mount multiple FileEditor components for the
 *  same input, so registrations are kept in order and fall back to the previous
 *  live instance when the latest one unmounts. When the caller knows which
 *  group it wants (e.g. focusing a specific group's editor), it can pass a
 *  groupId to disambiguate split mounts.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '@universe-editor/platform'
import type { EditorInput } from '@universe-editor/platform'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

interface Registration {
  editor: monaco.editor.IStandaloneCodeEditor
  groupId: number | undefined
}

class FileEditorRegistryImpl {
  private readonly _map = new Map<EditorInput, Registration[]>()
  private readonly _onDidChange = new Emitter<EditorInput>()
  readonly onDidChange = this._onDidChange.event

  register(
    input: EditorInput,
    editor: monaco.editor.IStandaloneCodeEditor,
    groupId?: number,
  ): void {
    const list = this._map.get(input) ?? []
    const existing = list.findIndex((r) => r.editor === editor)
    if (existing !== -1) list.splice(existing, 1)
    list.push({ editor, groupId })
    this._map.set(input, list)
    this._onDidChange.fire(input)
  }

  unregister(input: EditorInput, editor: monaco.editor.IStandaloneCodeEditor): void {
    const list = this._map.get(input)
    if (!list) return
    const index = list.findIndex((r) => r.editor === editor)
    if (index === -1) return
    list.splice(index, 1)
    if (list.length === 0) {
      this._map.delete(input)
    }
    this._onDidChange.fire(input)
  }

  get(input: EditorInput, groupId?: number): monaco.editor.IStandaloneCodeEditor | undefined {
    const list = this._map.get(input)
    if (!list || list.length === 0) return undefined
    if (groupId !== undefined) {
      for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i]
        if (r && r.groupId === groupId) return r.editor
      }
      return undefined
    }
    return list[list.length - 1]?.editor
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const FileEditorRegistry = new FileEditorRegistryImpl()
