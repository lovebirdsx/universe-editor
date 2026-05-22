/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-group MRU tracker for the Ctrl+Tab quick-open editor picker.
 *
 *  Subscribes to IEditorGroupsService events to maintain an ordered list of
 *  (groupId, editorId) tuples reflecting how recently each editor was active.
 *  The active editor of the active group is always at the head.
 *
 *  Editor inputs are looked up lazily on read so the service never holds stale
 *  references to closed editors or removed groups.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorGroupsService,
  createDecorator,
  type EditorInput,
  type IDisposable,
  type IEditorGroup,
} from '@universe-editor/platform'

export interface IRecentEditor {
  readonly editor: EditorInput
  readonly group: IEditorGroup
}

export interface IRecentEditorsService {
  readonly _serviceBrand: undefined
  getRecentEditors(): readonly IRecentEditor[]
}

export const IRecentEditorsService = createDecorator<IRecentEditorsService>('recentEditorsService')

interface MruEntry {
  readonly groupId: number
  readonly editorId: string
}

const MAX_ENTRIES = 50

export class RecentEditorsService extends Disposable implements IRecentEditorsService {
  declare readonly _serviceBrand: undefined

  private readonly _mru: MruEntry[] = []
  private readonly _groupWatchers = new Map<number, IDisposable>()

  constructor(@IEditorGroupsService private readonly _groups: IEditorGroupsService) {
    super()

    // Seed MRU from current state: every group's active editor, then move the
    // active group's active editor to the head so it represents "now".
    for (const g of this._groups.groups) {
      if (g.activeEditor) this._touch(g.id, g.activeEditor.id)
      this._watchGroup(g)
    }
    const activeGroup = this._groups.activeGroup
    if (activeGroup.activeEditor) {
      this._touch(activeGroup.id, activeGroup.activeEditor.id)
    }

    this._register(
      this._groups.onDidActiveGroupChange((group) => {
        if (group.activeEditor) this._touch(group.id, group.activeEditor.id)
      }),
    )
    this._register(
      this._groups.onDidAddGroup((group) => {
        this._watchGroup(group)
        if (group.activeEditor) this._touch(group.id, group.activeEditor.id)
      }),
    )
    this._register(
      this._groups.onDidRemoveGroup((group) => {
        this._groupWatchers.get(group.id)?.dispose()
        this._groupWatchers.delete(group.id)
        for (let i = this._mru.length - 1; i >= 0; i--) {
          if (this._mru[i]!.groupId === group.id) this._mru.splice(i, 1)
        }
      }),
    )

    this._register({
      dispose: () => {
        for (const d of this._groupWatchers.values()) d.dispose()
        this._groupWatchers.clear()
        this._mru.length = 0
      },
    })
  }

  getRecentEditors(): readonly IRecentEditor[] {
    const out: IRecentEditor[] = []
    const seen = new Set<string>()

    for (const entry of this._mru) {
      const group = this._groups.getGroup(entry.groupId)
      if (!group) continue
      const editor = group.editors.find((e) => e.id === entry.editorId)
      if (!editor) continue
      seen.add(`${entry.groupId}:${entry.editorId}`)
      out.push({ editor, group })
    }

    // Append editors that are open in groups but have never been activated in
    // this session (e.g. background tabs restored from a previous session).
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (!seen.has(`${group.id}:${editor.id}`)) {
          out.push({ editor, group })
        }
      }
    }

    return out
  }

  private _watchGroup(group: IEditorGroup): void {
    if (this._groupWatchers.has(group.id)) return
    const d = group.onDidActiveEditorChange(() => {
      const active = group.activeEditor
      if (active) this._touch(group.id, active.id)
    })
    this._groupWatchers.set(group.id, d)
  }

  private _touch(groupId: number, editorId: string): void {
    for (let i = 0; i < this._mru.length; i++) {
      const e = this._mru[i]!
      if (e.groupId === groupId && e.editorId === editorId) {
        this._mru.splice(i, 1)
        break
      }
    }
    this._mru.unshift({ groupId, editorId })
    if (this._mru.length > MAX_ENTRIES) this._mru.length = MAX_ENTRIES
  }
}
