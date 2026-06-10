/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tracks recently closed editors so Ctrl+Shift+T can reopen them.
 *
 *  Subscribes to IEditorGroupsService events to maintain a LIFO stack of
 *  closed editor entries. Each entry captures the resource URI, typeId, and
 *  the originating group so the editor can be reopened in the same location.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorGroupsService,
  URI,
  createDecorator,
  isEqualResource,
  type IDisposable,
  type IEditorGroup,
} from '@universe-editor/platform'

export interface ClosedEditorEntry {
  readonly resource: URI
  readonly typeId: string
  readonly groupId: number
}

export interface IClosedEditorsService {
  readonly _serviceBrand: undefined
  popMostRecent(): ClosedEditorEntry | undefined
}

export const IClosedEditorsService = createDecorator<IClosedEditorsService>('closedEditorsService')

const MAX_ENTRIES = 20

export class ClosedEditorsService extends Disposable implements IClosedEditorsService {
  declare readonly _serviceBrand: undefined

  private readonly _stack: ClosedEditorEntry[] = []
  private readonly _groupWatchers = new Map<number, IDisposable>()

  constructor(@IEditorGroupsService private readonly _groups: IEditorGroupsService) {
    super()

    for (const g of this._groups.groups) this._watchGroup(g)

    this._register(this._groups.onDidAddGroup((group) => this._watchGroup(group)))
    this._register(
      this._groups.onDidRemoveGroup((group) => {
        this._groupWatchers.get(group.id)?.dispose()
        this._groupWatchers.delete(group.id)
      }),
    )

    this._register({
      dispose: () => {
        for (const d of this._groupWatchers.values()) d.dispose()
        this._groupWatchers.clear()
        this._stack.length = 0
      },
    })
  }

  popMostRecent(): ClosedEditorEntry | undefined {
    while (this._stack.length > 0) {
      const entry = this._stack.pop()!
      // Skip entries whose editor is already open somewhere (e.g. after detach/move).
      const alreadyOpen = this._groups.groups.some((g) =>
        g.editors.some((e) => isEqualResource(e.resource, entry.resource)),
      )
      if (!alreadyOpen) return entry
    }
    return undefined
  }

  private _watchGroup(group: IEditorGroup): void {
    if (this._groupWatchers.has(group.id)) return
    const d = this._register(
      group.onDidChangeModel((event) => {
        if (event.kind !== 'close' || !event.editor?.resource) return
        this._stack.push({
          resource: event.editor.resource,
          typeId: event.editor.typeId,
          groupId: group.id,
        })
        if (this._stack.length > MAX_ENTRIES) this._stack.shift()
      }),
    )
    this._groupWatchers.set(group.id, d)
  }
}
