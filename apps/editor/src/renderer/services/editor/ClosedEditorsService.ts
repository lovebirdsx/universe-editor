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
  IUriIdentityService,
  URI,
  createDecorator,
  type EditorInput,
  type IDisposable,
  type IEditorGroup,
} from '@universe-editor/platform'

export interface ClosedEditorEntry {
  readonly resource: URI
  readonly typeId: string
  readonly groupId: number
  readonly serializedData: unknown
  readonly label: string
}

export interface IClosedEditorsService {
  readonly _serviceBrand: undefined
  popMostRecent(): ClosedEditorEntry | undefined
  /** Newest-first read-only snapshot, skipping entries whose (typeId, resource)
   *  is currently open somewhere. */
  getClosedEditors(): readonly ClosedEditorEntry[]
  /** Remove and return the newest entry for `resource` whose (typeId, resource)
   *  is not currently open; undefined when none matches. */
  takeMostRecentMatching(resource: URI): ClosedEditorEntry | undefined
}

export const IClosedEditorsService = createDecorator<IClosedEditorsService>('closedEditorsService')

const MAX_ENTRIES = 20

export class ClosedEditorsService extends Disposable implements IClosedEditorsService {
  declare readonly _serviceBrand: undefined

  private readonly _stack: ClosedEditorEntry[] = []
  private readonly _groupWatchers = new Map<number, IDisposable>()

  constructor(
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
  ) {
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
      if (!this._isOpen(entry)) return entry
    }
    return undefined
  }

  getClosedEditors(): readonly ClosedEditorEntry[] {
    const out: ClosedEditorEntry[] = []
    for (let i = this._stack.length - 1; i >= 0; i--) {
      const entry = this._stack[i]!
      if (!this._isOpen(entry)) out.push(entry)
    }
    return out
  }

  takeMostRecentMatching(resource: URI): ClosedEditorEntry | undefined {
    for (let i = this._stack.length - 1; i >= 0; i--) {
      const entry = this._stack[i]!
      if (!this._uriIdentity.isEqual(entry.resource, resource)) continue
      if (this._isOpen(entry)) continue
      this._stack.splice(i, 1)
      return entry
    }
    return undefined
  }

  // Match on typeId too: an image preview and a text view can share one file's
  // resource, so reopening the closed image tab must not be suppressed just
  // because the file's text tab is still open.
  private _isOpen(entry: ClosedEditorEntry): boolean {
    return this._groups.groups.some((g) =>
      g.editors.some(
        (e) => e.typeId === entry.typeId && this._uriIdentity.isEqual(e.resource, entry.resource),
      ),
    )
  }

  private _watchGroup(group: IEditorGroup): void {
    if (this._groupWatchers.has(group.id)) return
    const d = this._register(
      group.onDidChangeModel((event) => {
        // A closed tab, or a preview tab evicted in-place by opening another file
        // into the single preview slot (single-click in the SCM list): the old
        // preview is about to be disposed and never fires a 'close', so capture it
        // here or Ctrl+Shift+T could never reopen it.
        if (event.kind === 'close') this._record(group.id, event.editor)
        else if (event.kind === 'previewReplace') this._record(group.id, event.replacedEditor)
      }),
    )
    this._groupWatchers.set(group.id, d)
  }

  private _record(groupId: number, editor: EditorInput | undefined): void {
    if (!editor?.resource) return
    this._stack.push({
      resource: editor.resource,
      typeId: editor.typeId,
      groupId,
      serializedData: editor.serialize?.() ?? null,
      label: editor.getName(),
    })
    if (this._stack.length > MAX_ENTRIES) this._stack.shift()
  }
}
