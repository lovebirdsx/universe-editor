/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MergeEditorRegistry — tracks the live result-pane Monaco editor backing each
 *  mounted MergeEditorInput, mirroring DiffEditorRegistry. Merge-navigation /
 *  completion actions use it to reach the editor currently showing a given input.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '@universe-editor/platform'
import type { EditorInput } from '@universe-editor/platform'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

interface Registration {
  editor: monaco.editor.IStandaloneCodeEditor
  groupId: number | undefined
}

class MergeEditorRegistryImpl {
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
    if (list.length === 0) this._map.delete(input)
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

export const MergeEditorRegistry = new MergeEditorRegistryImpl()
