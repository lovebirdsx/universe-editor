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
  ILoggerService,
  IStorageService,
  IUriIdentityService,
  NullLogger,
  StorageScope,
  URI,
  createDecorator,
  type EditorInput,
  type IDisposable,
  type IEditorGroup,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type UriComponents,
} from '@universe-editor/platform'
import { recordPerfPhase, recordPerfPhaseAsync } from '../performance/perfPhases.js'

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
const PERSIST_DEBOUNCE_MS = 200
/** Entries whose serialized payload exceeds this stay in the in-memory stack
 *  (same-session Ctrl+Shift+T keeps working) but are never written to storage:
 *  persisting a multi-MB diff snapshot means synchronously stringifying it on
 *  the main thread on every close. */
export const MAX_PERSISTED_ENTRY_BYTES = 256 * 1024

/** Cheap structural size estimate — counts string lengths without building the
 *  serialized string (JSON.stringify of a 20MB payload is exactly the cost this
 *  budget exists to avoid). */
function estimateSerializedSize(data: unknown, depth = 0): number {
  if (data === null || data === undefined) return 0
  if (typeof data === 'string') return data.length
  if (typeof data === 'number' || typeof data === 'boolean') return 8
  if (depth > 16) return 0
  if (Array.isArray(data)) {
    let size = 0
    for (const item of data) size += estimateSerializedSize(item, depth + 1)
    return size
  }
  if (typeof data === 'object') {
    let size = 0
    for (const value of Object.values(data)) size += estimateSerializedSize(value, depth + 1)
    return size
  }
  return 0
}

export class ClosedEditorsService extends Disposable implements IClosedEditorsService {
  declare readonly _serviceBrand: undefined

  private readonly _stack: ClosedEditorEntry[] = []
  private readonly _groupWatchers = new Map<number, IDisposable>()
  private _loadPromise: Promise<void>
  private _persistTimer: ReturnType<typeof setTimeout> | null = null
  private _persistDebounceMs = PERSIST_DEBOUNCE_MS
  private readonly _logger: ILogger

  /** Test seam: collapse the debounce so specs can flush with a bare timer. */
  _setPersistDebounceMsForTests(ms: number): void {
    this._persistDebounceMs = ms
  }

  constructor(
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IStorageService private readonly _storage: IStorageService,
    @ILoggerService loggerService: ILoggerServiceType,
  ) {
    super()
    this._logger =
      loggerService?.createLogger({ id: 'closedEditors', name: 'Closed Editors' }) ??
      new NullLogger()

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
    if (mutated) this._schedulePersist()
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
      this._schedulePersist()
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
    const resource = editor?.resource
    if (!editor || !resource) return
    recordPerfPhase('closedEditors.record', () => {
      // Closing the same (typeId, resource) again replaces its earlier entry —
      // otherwise repeatedly closing a diff whose serializedData holds both
      // sides' full text piles duplicate multi-MB entries into the stack.
      for (let i = this._stack.length - 1; i >= 0; i--) {
        const e = this._stack[i]!
        if (e.typeId === editor.typeId && this._uriIdentity.isEqual(e.resource, resource)) {
          this._stack.splice(i, 1)
        }
      }
      this._stack.push({
        resource,
        typeId: editor.typeId,
        groupId,
        serializedData: editor.serialize?.() ?? null,
        label: editor.getName(),
      })
      if (this._stack.length > MAX_ENTRIES) this._stack.shift()
    })
    this._schedulePersist()
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
    try {
      let dropped = 0
      await recordPerfPhaseAsync('closedEditors.persist', async () => {
        const data: PersistedClosedEditor[] = []
        for (const e of this._stack) {
          if (estimateSerializedSize(e.serializedData) > MAX_PERSISTED_ENTRY_BYTES) {
            dropped++
            continue
          }
          data.push({ ...e, resource: e.resource.toJSON() })
        }
        await this._storage.set(STORAGE_KEY, data, StorageScope.WORKSPACE)
      })
      if (dropped > 0) {
        this._logger.debug(
          `persisted closed editors, kept ${dropped} oversized entries memory-only`,
        )
      }
    } catch (err) {
      this._logger.warn(
        'failed to persist closed editors',
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      )
    }
  }

  private _schedulePersist(): void {
    if (this._persistTimer !== null) clearTimeout(this._persistTimer)
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null
      void this._persist()
    }, this._persistDebounceMs)
  }

  override dispose(): void {
    if (this._persistTimer !== null) {
      clearTimeout(this._persistTimer)
      this._persistTimer = null
      void this._persist()
    }
    super.dispose()
  }
}
