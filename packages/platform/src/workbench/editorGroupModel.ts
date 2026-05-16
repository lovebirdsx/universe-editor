/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorGroupModel — the per-group data structure that backs an IEditorGroup.
 *
 *  Owns:
 *   - the editor list (insertion order)
 *   - the active editor pointer
 *   - the MRU (most-recently-used) order used when choosing the next active
 *     editor after a close
 *
 *  Adapted from VSCode's `editorGroupModel.ts` but simplified to the
 *  feature set declared by 主题 5: no preview, no sticky, no transient.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../base/event.js'
import { Disposable } from '../base/lifecycle.js'
import { EditorInput } from './editorService.js'

export type EditorGroupModelChangeKind = 'open' | 'close' | 'move' | 'active'

export interface IEditorGroupModelChangeEvent {
  kind: EditorGroupModelChangeKind
  editor: EditorInput | undefined
  oldIndex?: number
  newIndex?: number
}

export interface IOpenEditorOptions {
  /** Activate the editor after opening (default: true). */
  activate?: boolean
  /** Insert at the given index. Defaults to appending. */
  index?: number
}

export interface IEditorGroupModel {
  readonly id: number
  readonly editors: readonly EditorInput[]
  readonly activeEditor: EditorInput | undefined
  readonly count: number

  readonly onDidChangeModel: Event<IEditorGroupModelChangeEvent>
  readonly onDidActiveEditorChange: Event<void>

  openEditor(editor: EditorInput, options?: IOpenEditorOptions): void
  closeEditor(editor: EditorInput): boolean
  closeAllEditors(): void
  moveEditor(editor: EditorInput, toIndex: number): void
  setActive(editor: EditorInput): void

  getEditorByIndex(index: number): EditorInput | undefined
  indexOf(editor: EditorInput): number
  contains(editor: EditorInput): boolean
  findEditor(editor: EditorInput): EditorInput | undefined
  isFirst(editor: EditorInput): boolean
  isLast(editor: EditorInput): boolean
}

let nextGroupId = 0

export class EditorGroupModel extends Disposable implements IEditorGroupModel {
  readonly id: number = nextGroupId++

  private readonly _editors: EditorInput[] = []
  private _activeEditor: EditorInput | undefined = undefined
  private readonly _mru: EditorInput[] = []

  private readonly _onDidChangeModel = this._register(new Emitter<IEditorGroupModelChangeEvent>())
  readonly onDidChangeModel = this._onDidChangeModel.event

  private readonly _onDidActiveEditorChange = this._register(new Emitter<void>())
  readonly onDidActiveEditorChange = this._onDidActiveEditorChange.event

  get editors(): readonly EditorInput[] {
    return this._editors
  }

  get activeEditor(): EditorInput | undefined {
    return this._activeEditor
  }

  get count(): number {
    return this._editors.length
  }

  openEditor(editor: EditorInput, options?: IOpenEditorOptions): void {
    const activate = options?.activate !== false
    const existing = this.findEditor(editor)

    if (existing) {
      if (activate && existing !== this._activeEditor) {
        this._setActiveInternal(existing)
      }
      return
    }

    const insertIndex = options?.index ?? this._editors.length
    const clampedIndex = Math.max(0, Math.min(insertIndex, this._editors.length))
    this._editors.splice(clampedIndex, 0, editor)
    this._mru.unshift(editor)

    this._onDidChangeModel.fire({ kind: 'open', editor, newIndex: clampedIndex })

    if (activate) {
      this._setActiveInternal(editor)
    } else if (this._activeEditor === undefined) {
      // First editor in an empty group is implicitly active.
      this._setActiveInternal(editor)
    }
  }

  closeEditor(editor: EditorInput): boolean {
    const index = this.indexOf(editor)
    if (index === -1) return false

    const target = this._editors[index]!
    this._editors.splice(index, 1)
    const mruIdx = this._mru.indexOf(target)
    if (mruIdx !== -1) this._mru.splice(mruIdx, 1)

    this._onDidChangeModel.fire({ kind: 'close', editor: target, oldIndex: index })

    if (this._activeEditor === target) {
      // Prefer the most-recently-used remaining editor, else the predecessor,
      // else nothing.
      const next = this._mru[0] ?? this._editors[Math.max(0, index - 1)]
      this._setActiveInternal(next)
    }

    return true
  }

  closeAllEditors(): void {
    if (this._editors.length === 0) return
    this._editors.length = 0
    this._mru.length = 0
    this._onDidChangeModel.fire({ kind: 'close', editor: undefined })
    this._setActiveInternal(undefined)
  }

  moveEditor(editor: EditorInput, toIndex: number): void {
    const oldIndex = this.indexOf(editor)
    if (oldIndex === -1) return
    const target = Math.max(0, Math.min(toIndex, this._editors.length - 1))
    if (target === oldIndex) return

    const [moved] = this._editors.splice(oldIndex, 1)
    this._editors.splice(target, 0, moved!)
    this._onDidChangeModel.fire({ kind: 'move', editor: moved!, oldIndex, newIndex: target })
  }

  setActive(editor: EditorInput): void {
    const existing = this.findEditor(editor)
    if (!existing) return
    if (existing === this._activeEditor) return
    this._setActiveInternal(existing)
  }

  getEditorByIndex(index: number): EditorInput | undefined {
    return this._editors[index]
  }

  indexOf(editor: EditorInput): number {
    return this._editors.findIndex((e) => e.matches(editor))
  }

  contains(editor: EditorInput): boolean {
    return this.indexOf(editor) !== -1
  }

  findEditor(editor: EditorInput): EditorInput | undefined {
    const idx = this.indexOf(editor)
    return idx === -1 ? undefined : this._editors[idx]
  }

  isFirst(editor: EditorInput): boolean {
    return this._editors.length > 0 && this._editors[0]!.matches(editor)
  }

  isLast(editor: EditorInput): boolean {
    return this._editors.length > 0 && this._editors[this._editors.length - 1]!.matches(editor)
  }

  private _setActiveInternal(editor: EditorInput | undefined): void {
    if (this._activeEditor === editor) return
    this._activeEditor = editor
    if (editor) {
      // Move to front of MRU.
      const idx = this._mru.indexOf(editor)
      if (idx !== -1) this._mru.splice(idx, 1)
      this._mru.unshift(editor)
    }
    this._onDidChangeModel.fire({ kind: 'active', editor })
    this._onDidActiveEditorChange.fire()
  }
}
