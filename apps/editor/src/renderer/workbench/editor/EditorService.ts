/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IEditorService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '@universe-editor/platform'
import type {
  IEditorService,
  IEditorInput,
  IActiveEditorChangeEvent,
} from '@universe-editor/platform'

export class EditorService implements IEditorService {
  declare readonly _serviceBrand: undefined

  private readonly _openEditors: IEditorInput[] = []
  private _activeEditorId: string | undefined

  private readonly _onDidChangeActiveEditor = new Emitter<IActiveEditorChangeEvent>()
  private readonly _onDidOpenEditor = new Emitter<IEditorInput>()
  private readonly _onDidCloseEditor = new Emitter<IEditorInput>()

  readonly onDidChangeActiveEditor = this._onDidChangeActiveEditor.event
  readonly onDidOpenEditor = this._onDidOpenEditor.event
  readonly onDidCloseEditor = this._onDidCloseEditor.event

  get activeEditor(): IEditorInput | undefined {
    return this._openEditors.find((e) => e.id === this._activeEditorId)
  }

  get openEditors(): readonly IEditorInput[] {
    return this._openEditors
  }

  openEditor(input: IEditorInput): void {
    const existing = this._openEditors.find((e) => e.id === input.id)
    if (!existing) {
      this._openEditors.push(input)
      this._onDidOpenEditor.fire(input)
    }
    this._setActive(input.id)
  }

  closeEditor(id: string): void {
    const idx = this._openEditors.findIndex((e) => e.id === id)
    if (idx === -1) return

    const [closed] = this._openEditors.splice(idx, 1)
    this._onDidCloseEditor.fire(closed!)

    if (this._activeEditorId === id) {
      const next = this._openEditors[Math.max(0, idx - 1)]
      this._setActive(next?.id)
    }
  }

  closeAllEditors(): void {
    for (const e of [...this._openEditors]) {
      this.closeEditor(e.id)
    }
  }

  private _setActive(id: string | undefined): void {
    if (this._activeEditorId === id) return
    this._activeEditorId = id
    this._onDidChangeActiveEditor.fire({ editor: this.activeEditor })
  }
}
