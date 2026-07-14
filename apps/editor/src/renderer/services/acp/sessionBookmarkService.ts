/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionBookmarkService — the session-editor counterpart of the numbered-bookmarks
 *  extension. Each ACP session owns its own ten numbered slots (0-9) that pin to a
 *  timeline slot inside that session; toggling reads the session's currently active
 *  slot (keyboard-selected, or the slot at the top of the viewport) through
 *  AcpSessionOutlineRegistry — the same bridge the Outline view uses to reach a
 *  non-Monaco session editor. Toggle / jump / list / clear all act on the session
 *  whose editor is currently focused; jumping scrolls the slot into view.
 *
 *  State is persisted WORKSPACE-scoped (bookmarks travel with the sessions that
 *  live in this worktree). A message slot key is a client-generated uuid that
 *  changes across a resume, so a restored bookmark whose key no longer exists is
 *  dropped silently on jump; that is the deliberate best-effort contract, matching
 *  AcpChatViewStateCache's per-session view state.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  IEditorService,
  ILoggerService,
  InstantiationType,
  IStorageService,
  StorageScope,
  observableValue,
  registerSingleton,
  type ILogger,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import { IAcpSessionService } from './acpSessionService.js'
import { AcpSessionEditorInput } from './acpSessionEditorInput.js'
import {
  AcpSessionOutlineRegistry,
  type IAcpSessionOutlineController,
} from './acpSessionOutlineRegistry.js'
import { timelineItemToText } from './acpSessionContent.js'
import { itemSlotKey } from '../../workbench/agents/stickyScroll.js'
import { SessionBookmarkStore, SLOT_COUNT, type PersistedSession } from './sessionBookmarks.js'

export interface SessionBookmarkListItem {
  readonly slot: number
  readonly sessionId: string
  readonly slotKey: string
  /** First line of the bookmarked slot's text, or undefined if it can't be resolved. */
  readonly preview: string | undefined
}

export interface ISessionBookmarkService {
  readonly _serviceBrand: undefined
  /** Fires (via a monotonically-bumped counter) whenever any slot changes, so
   *  the timeline gutter indicators re-render. */
  readonly revision: IObservable<number>
  /** Idempotent; fire-and-forget at startup. */
  initialize(): Promise<void>
  toggle(slot: number): void
  jump(slot: number): void
  /** Clear every bookmark in the currently focused session. */
  clearActiveSession(): void
  /** `slotKey → slot number` for one session, for the timeline indicators. */
  bookmarksForSession(sessionId: string): ReadonlyMap<string, number>
  /** The focused session's set bookmarks with a resolved preview, for the list quick pick. */
  list(): SessionBookmarkListItem[]
}

export const ISessionBookmarkService =
  createDecorator<ISessionBookmarkService>('sessionBookmarkService')

const STORAGE_KEY = 'acp.sessionBookmarks'
const SCHEMA_VERSION = 2

interface PersistedShape {
  readonly schemaVersion: number
  readonly sessions: PersistedSession[]
}

export class SessionBookmarkService extends Disposable implements ISessionBookmarkService {
  declare readonly _serviceBrand: undefined

  readonly revision: ISettableObservable<number>

  private readonly _bookmarks = new SessionBookmarkStore()
  private _loaded = false
  private _loadPromise: Promise<void> | undefined
  private _writeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly _logger: ILogger

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @IEditorService private readonly _editor: IEditorService,
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({
      id: 'sessionBookmarks',
      name: 'Session Bookmarks',
    })
    this.revision = observableValue<number>('acp.sessionBookmarks.revision', 0)

    // Bookmarks deliberately survive a tab close: closeSession fires when the
    // user closes the session editor, but the session stays in history and is
    // resumable, so its bookmarks must persist (that is the whole point of the
    // WORKSPACE-scoped store). A slot pointing at a slot key that no longer
    // exists is dropped lazily on the next jump.

    this._register({
      dispose: () => {
        if (this._writeTimer) clearTimeout(this._writeTimer)
      },
    })
  }

  initialize(): Promise<void> {
    if (this._loaded) return Promise.resolve()
    this._loadPromise ??= this._load()
    return this._loadPromise
  }

  toggle(slot: number): void {
    if (!this._isValidSlot(slot)) return
    const ctx = this._activeContext()
    if (!ctx) {
      this._logger.info(`toggle #${slot}: no active session editor`)
      return
    }
    const key = ctx.controller.getActiveKey()
    if (key === undefined) {
      this._logger.info(`toggle #${slot}: session ${ctx.sessionId} has no active slot`)
      return
    }
    // Store the durable (agent-issued) id, not the in-memory local id: on a
    // fresh session those differ, and after restart the session is rebuilt with
    // id === durable id. Persisting the local id would orphan the bookmark on
    // the next launch (getById accepts both, so runtime lookups stay fine).
    const durableId = this._durableId(ctx.sessionId)
    const result = this._bookmarks.toggle(durableId, slot, key)
    this._logger.info(`toggle #${slot} @ ${key} → ${result ? 'set' : 'cleared'} (${durableId})`)
    this._changed()
  }

  jump(slot: number): void {
    if (!this._isValidSlot(slot)) return
    const ctx = this._activeContext()
    if (!ctx) {
      this._logger.info(`jump #${slot}: no active session editor`)
      return
    }
    const durableId = this._durableId(ctx.sessionId)
    const key = this._bookmarks.get(durableId, slot)
    if (key === null) {
      this._logger.info(`jump #${slot}: no bookmark set in ${durableId}`)
      return
    }
    this._logger.info(`jump #${slot} → ${durableId} @ ${key}`)
    ctx.controller.scrollToKey(key)
  }

  clearActiveSession(): void {
    const ctx = this._activeContext()
    if (!ctx) return
    const durableId = this._durableId(ctx.sessionId)
    if (this._bookmarks.clearSession(durableId)) this._changed()
  }

  bookmarksForSession(sessionId: string): ReadonlyMap<string, number> {
    // Callers pass the ChatBody's in-memory session.id; bookmarks are keyed by
    // durable id. Normalize the query to the durable id so a fresh session (whose
    // local id differs) still matches its stored bookmarks.
    const durableId = this._durableId(sessionId)
    const map = new Map<string, number>()
    for (const [slot, key] of this._bookmarks.forSession(durableId)) {
      map.set(key, slot)
    }
    return map
  }

  list(): SessionBookmarkListItem[] {
    const ctx = this._activeContext()
    if (!ctx) return []
    const durableId = this._durableId(ctx.sessionId)
    return this._bookmarks.forSession(durableId).map(([slot, key]) => ({
      slot,
      sessionId: durableId,
      slotKey: key,
      preview: this._previewFor(durableId, key),
    }))
  }

  // -- internals ---------------------------------------------------------

  private _isValidSlot(slot: number): boolean {
    return Number.isInteger(slot) && slot >= 0 && slot < SLOT_COUNT
  }

  /**
   * Map an in-memory session id to its durable (agent-issued) id, falling back
   * to the input when the session is unknown or has not connected yet. Bookmarks
   * are keyed by the durable id so they survive a restart (a fresh session's
   * local id differs from the durable id it is rebuilt with).
   */
  private _durableId(sessionId: string): string {
    return this._sessions.getById(sessionId)?.sessionIdOnAgent.get() ?? sessionId
  }

  private _activeContext():
    | { sessionId: string; controller: IAcpSessionOutlineController }
    | undefined {
    const active = this._editor.activeEditor.get()
    if (!(active instanceof AcpSessionEditorInput)) return undefined
    const controller = AcpSessionOutlineRegistry.get(active.sessionId)
    if (!controller) return undefined
    return { sessionId: active.sessionId, controller }
  }

  private _previewFor(sessionId: string, slotKey: string): string | undefined {
    const session = this._sessions.getById(sessionId)
    if (!session) return undefined
    const item = session.timeline.get().find((it) => itemSlotKey(it) === slotKey)
    if (!item) return undefined
    const text = timelineItemToText(item).split('\n', 1)[0]?.trim() ?? ''
    return text.length > 0 ? text : undefined
  }

  private _changed(): void {
    this.revision.set(this.revision.get() + 1, undefined)
    this._scheduleWrite()
  }

  private async _load(): Promise<void> {
    try {
      const raw = await this._storage.get<PersistedShape>(STORAGE_KEY, StorageScope.WORKSPACE)
      if (raw && typeof raw === 'object' && raw.schemaVersion === SCHEMA_VERSION) {
        this._bookmarks.load(raw.sessions)
        this.revision.set(this.revision.get() + 1, undefined)
        this._logger.info(
          `loaded session bookmarks for ${this._bookmarks.serialize().length} session(s)`,
        )
      } else if (raw !== undefined) {
        this._logger.warn(
          `ignoring ${STORAGE_KEY} with schemaVersion=${(raw as PersistedShape).schemaVersion}`,
        )
      }
    } catch (err) {
      this._logger.warn(`failed to load session bookmarks: ${(err as Error).message}`)
    } finally {
      this._loaded = true
    }
  }

  private _scheduleWrite(): void {
    if (this._writeTimer) return
    this._writeTimer = setTimeout(() => {
      this._writeTimer = undefined
      void this._writeNow()
    }, 250)
  }

  private async _writeNow(): Promise<void> {
    try {
      // A bookmark set before its session connected was stored under the local
      // id; re-key to the durable id now (if it has since been issued) so the
      // persisted snapshot survives a restart.
      this._bookmarks.normalize((id) => this._durableId(id))
      const payload: PersistedShape = {
        schemaVersion: SCHEMA_VERSION,
        sessions: this._bookmarks.serialize(),
      }
      await this._storage.set(STORAGE_KEY, payload, StorageScope.WORKSPACE)
    } catch (err) {
      this._logger.warn(`failed to persist session bookmarks: ${(err as Error).message}`)
    }
  }
}

registerSingleton(ISessionBookmarkService, SessionBookmarkService, InstantiationType.Delayed)
