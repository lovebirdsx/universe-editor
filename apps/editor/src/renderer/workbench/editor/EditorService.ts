/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IEditorService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, derived, transaction } from '@universe-editor/platform'
import type { IEditorService, IEditorInput } from '@universe-editor/platform'

export class EditorService implements IEditorService {
  declare readonly _serviceBrand: undefined

  readonly openEditors = observableValue<readonly IEditorInput[]>('EditorService.openEditors', [])
  readonly activeEditorId = observableValue<string | undefined>(
    'EditorService.activeEditorId',
    undefined,
  )
  readonly activeEditor = derived(this, (r) => {
    const id = this.activeEditorId.read(r)
    if (id === undefined) return undefined
    return this.openEditors.read(r).find((e) => e.id === id)
  })

  openEditor(input: IEditorInput): void {
    const existing = this.openEditors.get().find((e) => e.id === input.id)
    transaction((tx) => {
      if (!existing) this.openEditors.set([...this.openEditors.get(), input], tx)
      this.activeEditorId.set(input.id, tx)
    })
  }

  closeEditor(id: string): void {
    const editors = this.openEditors.get()
    const idx = editors.findIndex((e) => e.id === id)
    if (idx === -1) return
    const newEditors = [...editors.slice(0, idx), ...editors.slice(idx + 1)]
    transaction((tx) => {
      this.openEditors.set(newEditors, tx)
      if (this.activeEditorId.get() === id) {
        const next = newEditors[Math.max(0, idx - 1)]
        this.activeEditorId.set(next?.id, tx)
      }
    })
  }

  closeAllEditors(): void {
    if (this.openEditors.get().length === 0) return
    transaction((tx) => {
      this.openEditors.set([], tx)
      this.activeEditorId.set(undefined, tx)
    })
  }
}
