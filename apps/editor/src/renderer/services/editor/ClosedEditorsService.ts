/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tracks recently closed editors so Ctrl+Shift+T and quick open can reopen them.
 *
 *  Subscribes to IEditorGroupsService events to maintain a LIFO stack of
 *  closed editor entries. Each entry captures the resource URI, typeId, and
 *  the originating group so the editor can be reopened in the same location.
 *
 *  The stack is persisted per-workspace: quick open lists closed non-text
 *  editors (sessions, git graph, previews…) across editor restarts and can
 *  still restore them with their exact type — without persistence they would
 *  survive only as unusable resource URIs.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorGroupsService,
  IStorageService,
  IUriIdentityService,
  StorageScope,
  URI,
  createDecorator,
  type EditorInput,
  type IDisposable,
  type IEditorGroup,
  type UriComponents,
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

interface PersistedClosedEditor {
  readonly resource: UriComponents
  readonly typeId: string
  readonly groupId: number
  readonly serializedData: unknown
  readonly label: string
}

const STORAGE_KEY = 'workbench.closedEditors'
const MAX_ENTRIES = 20

export class ClosedEditorsService extends Disposable implements IClosedEditorsService {
  declare readonly _serviceBrand: undefined

  private readonly _stack: ClosedEditorEntry[] = []
  private readonly _groupWatchers = new Map<number, IDisposable>()
  private _loadPromise: Promise<void>

  constructor(
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IStorageService private readonly _storage: IStorageService,
  ) {
    super()

    this._loadPromise = this._load()
    this._register(
      this._storage.onDidChangeWorkspaceScope(() => {
        this._stack.length = 0
        this._loadPromise = this._load()
      }),
    )

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
    let mutated = false
    let popped: ClosedEditorEntry | undefined
    while (this._stack.length > 0) {
      const entry = this._stack.pop()!
      mutated = true
      if (!this._isOpen(entry)) {
        popped = entry
        break
      }
    }
    if (mutated) void this._persist()
    return popped
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
      void this._persist()
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
    void this._persist()
  }

  private async _load(): Promise<void> {
    const raw = await this._storage.get<PersistedClosedEditor[]>(
      STORAGE_KEY,
      StorageScope.WORKSPACE,
    )
    if (!raw || !Array.isArray(raw)) return
    const revived = raw.map((r) => ({ ...r, resource: URI.revive(r.resource) as URI }))
    // Entries closed in this session before the load resolved stay newest: the
    // persisted (previous-session) stack slides underneath them.
    this._stack.unshift(...revived)
    if (this._stack.length > MAX_ENTRIES) {
      this._stack.splice(0, this._stack.length - MAX_ENTRIES)
    }
  }

  /** Waits for the initial load first so an early write can never clobber the
   *  persisted previous-session stack with only this session's entries. */
  private async _persist(): Promise<void> {
    await this._loadPromise
    const data: PersistedClosedEditor[] = this._stack.map((e) => ({
      ...e,
      resource: e.resource.toJSON(),
    }))
    await this._storage.set(STORAGE_KEY, data, StorageScope.WORKSPACE)
  }
}
