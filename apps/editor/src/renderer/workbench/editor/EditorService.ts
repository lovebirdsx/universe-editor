/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IEditorService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '@universe-editor/platform'
import type {
  IEditorService,
  IEditorInput,
  IActiveEditorChangeEvent,
  EditorState,
  IDisposable,
} from '@universe-editor/platform'

const EMPTY_STATE: EditorState = Object.freeze({
  openEditors: Object.freeze([]) as readonly IEditorInput[],
  activeEditorId: undefined,
})

export class EditorService implements IEditorService {
  declare readonly _serviceBrand: undefined

  private _state: EditorState = EMPTY_STATE

  private readonly _onChange = new Emitter<void>()
  private readonly _onDidChangeActiveEditor = new Emitter<IActiveEditorChangeEvent>()
  private readonly _onDidOpenEditor = new Emitter<IEditorInput>()
  private readonly _onDidCloseEditor = new Emitter<IEditorInput>()

  readonly onDidChangeActiveEditor = this._onDidChangeActiveEditor.event
  readonly onDidOpenEditor = this._onDidOpenEditor.event
  readonly onDidCloseEditor = this._onDidCloseEditor.event

  getSnapshot(): EditorState {
    return this._state
  }

  subscribe(listener: () => void): IDisposable {
    return this._onChange.event(listener)
  }

  get activeEditor(): IEditorInput | undefined {
    return this._state.openEditors.find((e) => e.id === this._state.activeEditorId)
  }

  get openEditors(): readonly IEditorInput[] {
    return this._state.openEditors
  }

  openEditor(input: IEditorInput): void {
    const cur = this._state
    const existing = cur.openEditors.find((e) => e.id === input.id)

    const openEditors = existing
      ? cur.openEditors
      : (Object.freeze([...cur.openEditors, input]) as readonly IEditorInput[])

    const wasActive = cur.activeEditorId === input.id
    this._commit(Object.freeze({ openEditors, activeEditorId: input.id }))

    if (!existing) this._onDidOpenEditor.fire(input)
    if (!wasActive) this._onDidChangeActiveEditor.fire({ editor: this.activeEditor })
  }

  closeEditor(id: string): void {
    const cur = this._state
    const idx = cur.openEditors.findIndex((e) => e.id === id)
    if (idx === -1) return

    const closed = cur.openEditors[idx]!
    const openEditors = Object.freeze([
      ...cur.openEditors.slice(0, idx),
      ...cur.openEditors.slice(idx + 1),
    ]) as readonly IEditorInput[]

    let activeEditorId = cur.activeEditorId
    let activeChanged = false
    if (activeEditorId === id) {
      const next = openEditors[Math.max(0, idx - 1)]
      activeEditorId = next?.id
      activeChanged = true
    }

    this._commit(Object.freeze({ openEditors, activeEditorId }))

    this._onDidCloseEditor.fire(closed)
    if (activeChanged) this._onDidChangeActiveEditor.fire({ editor: this.activeEditor })
  }

  closeAllEditors(): void {
    const cur = this._state
    if (cur.openEditors.length === 0) return

    const closedEditors = cur.openEditors
    const activeChanged = cur.activeEditorId !== undefined

    // Single commit -> single onChange fire -> single React rerender.
    this._commit(EMPTY_STATE)

    for (const e of closedEditors) {
      this._onDidCloseEditor.fire(e)
    }
    if (activeChanged) this._onDidChangeActiveEditor.fire({ editor: undefined })
  }

  private _commit(next: EditorState): void {
    if (next === this._state) return
    this._state = next
    this._onChange.fire()
  }
}
