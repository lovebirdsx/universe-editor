/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Backwards-compatible IEditorService — proxies to IEditorGroupsService.activeGroup.
 *
 *  Existing consumers use the IEditorInput structural type (`{id, type, label, isDirty, meta?}`)
 *  and call openEditor / closeEditor / closeAllEditors. This service preserves
 *  that surface and forwards every call to the active group.
 *--------------------------------------------------------------------------------------------*/

import {
  EditorInput,
  IEditorGroupsService,
  IEditorInput,
  IEditorService,
  IOpenEditorServiceOptions,
  URI,
  derived,
  observableValue,
  transaction,
} from '@universe-editor/platform'
import { EditorGroupsService } from './EditorGroupsService.js'

class LegacyEditorInput extends EditorInput {
  constructor(private readonly _input: IEditorInput) {
    super()
  }
  get typeId(): string {
    return this._input.type
  }
  get resource(): URI | undefined {
    return URI.from({ scheme: 'legacy-input', path: '/' + this._input.id })
  }
  override get id(): string {
    return this._input.id
  }
  getName(): string {
    return this._input.label
  }
  get input(): IEditorInput {
    return this._input
  }
}

function toLegacy(editor: EditorInput | undefined): IEditorInput | undefined {
  if (!editor) return undefined
  if (editor instanceof LegacyEditorInput) return editor.input
  return {
    id: editor.id,
    type: editor.type,
    label: editor.label,
    isDirty: editor.isDirty,
  }
}

export class EditorService implements IEditorService {
  declare readonly _serviceBrand: undefined

  private readonly _groupsService: IEditorGroupsService

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

  private _suppressGroupSync = 0

  constructor(groupsService?: IEditorGroupsService) {
    this._groupsService = groupsService ?? new EditorGroupsService()
    this._sync()
    // Re-sync on every active-group transition AND on every editor change within
    // the active group — otherwise actions that call `group.openEditor()` directly
    // (e.g. NewUntitledFileAction) would not be reflected in activeEditor / openEditors.
    let unsubscribeActive = this._subscribeActiveGroup()
    this._groupsService.onDidActiveGroupChange(() => {
      unsubscribeActive()
      unsubscribeActive = this._subscribeActiveGroup()
      this._sync()
    })
  }

  private _subscribeActiveGroup(): () => void {
    const group = this._groupsService.activeGroup
    const handler = () => {
      if (this._suppressGroupSync === 0) this._sync()
    }
    const a = group.onDidChangeModel(handler)
    const b = group.onDidActiveEditorChange(handler)
    return () => {
      a.dispose()
      b.dispose()
    }
  }

  private _sync(): void {
    const group = this._groupsService.activeGroup
    transaction((tx) => {
      this.openEditors.set(
        group.editors.map((e) => toLegacy(e)!),
        tx,
      )
      this.activeEditorId.set(group.activeEditor?.id, tx)
    })
  }

  openEditor(input: IEditorInput, options?: IOpenEditorServiceOptions): void {
    const group = this._groupsService.activeGroup
    const existing = group.editors.find((e) => e.id === input.id)
    this._suppressGroupSync++
    try {
      if (existing) {
        if (options?.pinned === true && group.previewEditor === existing) {
          group.pinEditor(existing)
        }
        if (options?.activate !== false) group.setActive(existing)
      } else {
        group.openEditor(new LegacyEditorInput(input), options)
      }
    } finally {
      this._suppressGroupSync--
    }
    this._sync()
  }

  closeEditor(id: string): void {
    const group = this._groupsService.activeGroup
    const target = group.editors.find((e) => e.id === id)
    if (target) {
      this._suppressGroupSync++
      try {
        group.closeEditor(target)
      } finally {
        this._suppressGroupSync--
      }
      this._sync()
    }
  }

  closeAllEditors(): void {
    const group = this._groupsService.activeGroup
    if (group.editors.length === 0) return
    this._suppressGroupSync++
    try {
      group.closeAllEditors()
    } finally {
      this._suppressGroupSync--
    }
    this._sync()
  }
}
