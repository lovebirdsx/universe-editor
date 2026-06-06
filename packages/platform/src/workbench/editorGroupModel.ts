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
 *  Adapted from VSCode's `editorGroupModel.ts` but simplified. Carries a
 *  single preview slot per group (主题 11): at most one editor is in
 *  "preview" mode and is replaced in-place by the next preview open.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../base/event.js'
import { Disposable, DisposableStore } from '../base/lifecycle.js'
import { EditorInput } from './editorService.js'

export type EditorGroupModelChangeKind =
  | 'open'
  | 'close'
  | 'move'
  | 'active'
  | 'pin'
  | 'previewReplace'

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
  /**
   * Pin the editor (default: true). `false` opens into the group's single
   * preview slot, replacing any existing preview in-place.
   */
  pinned?: boolean
  /** Open without moving keyboard focus to the editor (default: false). */
  preserveFocus?: boolean
}

export interface IEditorGroupModel {
  readonly id: number
  readonly editors: readonly EditorInput[]
  readonly activeEditor: EditorInput | undefined
  readonly previewEditor: EditorInput | undefined
  readonly count: number
  /** Monotonic counter bumped on every effective activation; lets views dedupe focus handling. */
  readonly activationId: number
  /** Whether the most recent activation asked to keep keyboard focus off the editor. */
  readonly lastActivationPreservedFocus: boolean

  readonly onDidChangeModel: Event<IEditorGroupModelChangeEvent>
  readonly onDidActiveEditorChange: Event<void>

  openEditor(editor: EditorInput, options?: IOpenEditorOptions): void
  closeEditor(editor: EditorInput): boolean
  closeAllEditors(): void
  /**
   * Remove `editor` from this group without disposing it. The caller takes
   * ownership and is expected to re-attach it to another group (e.g. drag-to-
   * other-group). Fires the same 'close' model event as `closeEditor`.
   */
  detachEditor(editor: EditorInput): boolean
  moveEditor(editor: EditorInput, toIndex: number): void
  setActive(editor: EditorInput, options?: { preserveFocus?: boolean }): void
  pinEditor(editor: EditorInput): void
  isPinned(editor: EditorInput): boolean

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
  private _previewEditor: EditorInput | undefined = undefined
  private _activationId = 0
  private _lastActivationPreservedFocus = false
  private readonly _mru: EditorInput[] = []
  /**
   * Owns the lifetime of editors that belong to this group: each `openEditor`
   * parents the input here so the leak tracker can root through the model to
   * its singleton workbench store. `closeEditor` / `closeAllEditors` / preview
   * replace dispose via this store; `detachEditor` removes without disposing
   * so the input can be moved to another group.
   */
  private readonly _editorStore = this._register(new DisposableStore())

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

  get previewEditor(): EditorInput | undefined {
    return this._previewEditor
  }

  get count(): number {
    return this._editors.length
  }

  get activationId(): number {
    return this._activationId
  }

  get lastActivationPreservedFocus(): boolean {
    return this._lastActivationPreservedFocus
  }

  openEditor(editor: EditorInput, options?: IOpenEditorOptions): void {
    const activate = options?.activate !== false
    const pinned = options?.pinned !== false
    this._lastActivationPreservedFocus = options?.preserveFocus === true
    const existing = this.findEditor(editor)

    if (existing) {
      // Re-opening an editor that's already in the group. If this call asks
      // for pinned and the existing entry currently occupies the preview slot,
      // promote it (clear the slot + fire 'pin').
      if (pinned && this._previewEditor === existing) {
        this._previewEditor = undefined
        this._onDidChangeModel.fire({ kind: 'pin', editor: existing })
      }
      if (activate && existing !== this._activeEditor) {
        this._setActiveInternal(existing)
      }
      return
    }

    if (!pinned && this._previewEditor) {
      // Replace the existing preview slot in-place: same index, dispose old.
      const oldPreview = this._previewEditor
      const slotIndex = this._editors.indexOf(oldPreview)
      if (slotIndex !== -1) {
        this._editors.splice(slotIndex, 1, editor)
        this._editorStore.add(editor)
        const mruIdx = this._mru.indexOf(oldPreview)
        if (mruIdx !== -1) this._mru.splice(mruIdx, 1)
        this._mru.unshift(editor)
        this._previewEditor = editor
        const wasActive = this._activeEditor === oldPreview
        if (wasActive) this._activeEditor = undefined
        this._onDidChangeModel.fire({
          kind: 'previewReplace',
          editor,
          oldIndex: slotIndex,
          newIndex: slotIndex,
        })
        this._editorStore.delete(oldPreview)
        if (activate || wasActive) {
          this._setActiveInternal(editor)
        }
        return
      }
      // Stale preview ref — fall through to normal insert.
      this._previewEditor = undefined
    }

    const insertIndex = options?.index ?? this._editors.length
    const clampedIndex = Math.max(0, Math.min(insertIndex, this._editors.length))
    this._editors.splice(clampedIndex, 0, editor)
    this._editorStore.add(editor)
    this._mru.unshift(editor)
    if (!pinned) this._previewEditor = editor

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
    if (this._previewEditor === target) this._previewEditor = undefined

    this._onDidChangeModel.fire({ kind: 'close', editor: target, oldIndex: index })

    if (this._activeEditor === target) {
      // Prefer the most-recently-used remaining editor, else the predecessor,
      // else nothing.
      const next = this._mru[0] ?? this._editors[Math.max(0, index - 1)]
      this._setActiveInternal(next)
    }

    this._editorStore.delete(target)
    return true
  }

  detachEditor(editor: EditorInput): boolean {
    const index = this.indexOf(editor)
    if (index === -1) return false

    const target = this._editors[index]!
    this._editors.splice(index, 1)
    const mruIdx = this._mru.indexOf(target)
    if (mruIdx !== -1) this._mru.splice(mruIdx, 1)
    if (this._previewEditor === target) this._previewEditor = undefined

    this._onDidChangeModel.fire({ kind: 'close', editor: target, oldIndex: index })

    if (this._activeEditor === target) {
      const next = this._mru[0] ?? this._editors[Math.max(0, index - 1)]
      this._setActiveInternal(next)
    }

    this._editorStore.deleteAndLeak(target)
    return true
  }

  closeAllEditors(): void {
    if (this._editors.length === 0) return
    const closed = [...this._editors]
    this._editors.length = 0
    this._mru.length = 0
    this._previewEditor = undefined
    this._onDidChangeModel.fire({ kind: 'close', editor: undefined })
    this._setActiveInternal(undefined)
    for (const editor of closed) this._editorStore.delete(editor)
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

  setActive(editor: EditorInput, options?: { preserveFocus?: boolean }): void {
    const existing = this.findEditor(editor)
    if (!existing) return
    this._lastActivationPreservedFocus = options?.preserveFocus === true
    if (existing === this._activeEditor) return
    this._setActiveInternal(existing)
  }

  pinEditor(editor: EditorInput): void {
    const existing = this.findEditor(editor)
    if (!existing) return
    if (this._previewEditor !== existing) return
    this._previewEditor = undefined
    this._onDidChangeModel.fire({ kind: 'pin', editor: existing })
  }

  isPinned(editor: EditorInput): boolean {
    const existing = this.findEditor(editor)
    if (!existing) return false
    return this._previewEditor !== existing
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
    this._activationId++
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
