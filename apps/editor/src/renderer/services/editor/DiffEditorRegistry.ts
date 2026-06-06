/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DiffEditorRegistry — tracks the live Monaco diff editor instance backing each
 *  mounted DiffEditorInput. Mirrors FileEditorRegistry; used by diff-navigation
 *  commands that need to call goToDiff() on the editor currently showing a given
 *  input. Split views can mount multiple DiffEditor components for the same input,
 *  so registrations are kept in order and fall back to the previous live instance
 *  when the latest one unmounts. A groupId disambiguates split mounts.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '@universe-editor/platform'
import type { EditorInput } from '@universe-editor/platform'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

interface Registration {
  editor: monaco.editor.IStandaloneDiffEditor
  groupId: number | undefined
}

class DiffEditorRegistryImpl {
  private readonly _map = new Map<EditorInput, Registration[]>()
  private readonly _onDidChange = new Emitter<EditorInput>()
  readonly onDidChange = this._onDidChange.event

  register(
    input: EditorInput,
    editor: monaco.editor.IStandaloneDiffEditor,
    groupId?: number,
  ): void {
    const list = this._map.get(input) ?? []
    const existing = list.findIndex((r) => r.editor === editor)
    if (existing !== -1) list.splice(existing, 1)
    list.push({ editor, groupId })
    this._map.set(input, list)
    this._onDidChange.fire(input)
  }

  unregister(input: EditorInput, editor: monaco.editor.IStandaloneDiffEditor): void {
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

  get(input: EditorInput, groupId?: number): monaco.editor.IStandaloneDiffEditor | undefined {
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

export const DiffEditorRegistry = new DiffEditorRegistryImpl()
