/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Backwards-compatible IEditorService — proxies to IEditorGroupsService.activeGroup.
 *
 *  Existing consumers use the IEditorInput structural type (`{id, type, label, isDirty, meta?}`)
 *  and call openEditor / closeEditor / closeAllEditors. This service preserves
 *  that surface and forwards every call to the active group.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  EditorInput,
  IEditorGroupsService,
  IEditorInput,
  IEditorService,
  NullLogger,
  ITelemetryService,
  IOpenEditorServiceOptions,
  URI,
  derived,
  observableValue,
  toDisposable,
  transaction,
  type ILogger,
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
  // EditorInput implements IEditorInput structurally via getters. Returning
  // the instance itself preserves `instanceof FileEditorInput` checks in
  // downstream consumers (ExplorerAutoRevealContribution, FileEditorStatusContribution).
  return editor
}

export class EditorService extends Disposable implements IEditorService {
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

  constructor(
    groupsService?: IEditorGroupsService,
    private readonly _telemetry?: ITelemetryService,
    private readonly _logger: ILogger = new NullLogger(),
  ) {
    super()
    this._groupsService = groupsService ?? new EditorGroupsService()
    this._sync()
    // Re-sync on every active-group transition AND on every editor change within
    // the active group — otherwise actions that call `group.openEditor()` directly
    // (e.g. NewUntitledFileAction) would not be reflected in activeEditor / openEditors.
    let unsubscribeActive = this._subscribeActiveGroup()
    this._register(
      this._groupsService.onDidActiveGroupChange(() => {
        unsubscribeActive()
        unsubscribeActive = this._subscribeActiveGroup()
        this._sync()
      }),
    )
    this._register(toDisposable(() => unsubscribeActive()))
  }

  private _subscribeActiveGroup(): () => void {
    const group = this._groupsService.activeGroup
    const handler = () => {
      if (this._suppressGroupSync === 0) this._sync()
    }
    const a = this._register(group.onDidChangeModel(handler))
    const b = this._register(group.onDidActiveEditorChange(handler))
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
        if (options?.activate !== false) {
          group.setActive(existing, { preserveFocus: options?.preserveFocus === true })
        }
        if (input instanceof EditorInput && input !== existing) {
          // Caller handed us a fresh input for an already-open resource; the
          // existing one wins, so release the discarded duplicate so the leak
          // tracker doesn't see it as a dangling owner.
          input.dispose()
        }
      } else {
        group.openEditor(
          input instanceof EditorInput ? input : new LegacyEditorInput(input),
          options,
        )
      }
    } finally {
      this._suppressGroupSync--
    }
    this._sync()
    this._telemetry?.publicLog('editorOpened', { typeId: input.type })
    this._logger.info(
      `openEditor id=${input.id} type=${input.type} reused=${existing !== undefined} pinned=${options?.pinned ?? true} activate=${options?.activate !== false}`,
    )
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
      this._logger.info(`closeEditor id=${id} type=${target.typeId}`)
    }
  }

  closeAllEditors(): void {
    const group = this._groupsService.activeGroup
    if (group.editors.length === 0) return
    const count = group.editors.length
    this._suppressGroupSync++
    try {
      group.closeAllEditors()
    } finally {
      this._suppressGroupSync--
    }
    this._sync()
    this._logger.info(`closeAllEditors count=${count}`)
  }
}
