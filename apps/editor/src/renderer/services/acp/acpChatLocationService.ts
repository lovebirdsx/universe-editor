/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpChatLocationService — single source of truth for whether the AGENTS Chat
 *  panel renders inside the EditorArea (full-screen tab) or in the
 *  SecondarySideBar (Copilot-style docked panel).
 *
 *  Three-way sync:
 *    - ISettableObservable<'editor' | 'sidebar'>  (React via useObservable)
 *    - ContextKey 'acpChatLocation'               (Action `when` clauses)
 *    - IStorageService GLOBAL                     (persisted across restarts)
 *
 *  Switching mode is a side effect of `setLocation`:
 *    - 'sidebar' → close every AcpSessionEditorInput tab across all groups
 *    - 'editor'  → if there's an active session, open it as a tab
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  createDecorator,
  Disposable,
  IContextKeyService,
  IEditorGroupsService,
  IEditorService,
  IInstantiationService,
  ILoggerService,
  IStorageService,
  ITelemetryService,
  StorageScope,
  observableValue,
  type IContextKey,
  type ILogger,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import { IAcpSessionService } from './acpSessionService.js'
import { AcpSessionEditorInput } from './acpSessionEditorInput.js'

export type AcpChatLocation = 'editor' | 'sidebar'

export interface IAcpChatLocationService {
  readonly _serviceBrand: undefined
  readonly location: IObservable<AcpChatLocation>
  /**
   * True synchronously while `setLocation` is closing/opening editor tabs as
   * part of a chat-location migration. Consumed by
   * `AgentsSessionEditorLifecycleContribution` to distinguish a user-driven
   * tab close (→ stop the agent) from a migration close (→ keep it running).
   */
  readonly isMigrating: boolean
  /** Idempotent. main.tsx fire-and-forgets at startup. */
  initialize(): Promise<void>
  setLocation(location: AcpChatLocation): void
  /** Convenience for menus / Action2 that want to flip without reading first. */
  toggle(): void
}

export const IAcpChatLocationService =
  createDecorator<IAcpChatLocationService>('acpChatLocationService')

const STORAGE_KEY = 'acp.chatLocation'
const SCHEMA_VERSION = 1
const DEFAULT_LOCATION: AcpChatLocation = 'editor'

interface PersistedShape {
  readonly schemaVersion: number
  readonly location: AcpChatLocation
}

export class AcpChatLocationService extends Disposable implements IAcpChatLocationService {
  declare readonly _serviceBrand: undefined

  readonly location: ISettableObservable<AcpChatLocation>

  private _location: AcpChatLocation = DEFAULT_LOCATION
  private _loaded = false
  private _loadPromise: Promise<void> | undefined
  private _writeTimer: ReturnType<typeof setTimeout> | undefined
  private _migrating = false
  private readonly _contextKey: IContextKey<string>
  private readonly _logger: ILogger

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @IContextKeyService contextKeyService: IContextKeyService,
    @IEditorService private readonly _editor: IEditorService,
    @IEditorGroupsService private readonly _editorGroups: IEditorGroupsService,
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @ITelemetryService private readonly _telemetry: ITelemetryService,
    @ILoggerService loggerService: ILoggerService,
    @IInstantiationService private readonly _inst: IInstantiationService,
  ) {
    super()
    this._logger = loggerService.createLogger({
      id: 'acpChatLocation',
      name: 'ACP Chat Location',
    })
    this.location = observableValue<AcpChatLocation>('acp.chatLocation', DEFAULT_LOCATION)
    this._contextKey = contextKeyService.createKey<string>('acpChatLocation', DEFAULT_LOCATION)
    // Keep the editor area in sync with activeSession changes when in 'editor'
    // mode. We do NOT set `_migrating` here — the lifecycle contribution
    // already filters out the no-op "same input in another group" case, and
    // we want a user-driven session swap to count as a real close on the
    // outgoing tab. `openEditor` is idempotent on identical inputs.
    this._register(
      autorun((r) => {
        if (this._location !== 'editor') return
        const active = this._sessions.activeSession.read(r)
        if (!active) return
        this._editor.openEditor(
          this._inst.createInstance(AcpSessionEditorInput, active.id, active.agentId),
        )
      }),
    )
  }

  initialize(): Promise<void> {
    if (this._loaded) return Promise.resolve()
    if (this._loadPromise) return this._loadPromise
    this._loadPromise = this._load()
    return this._loadPromise
  }

  get isMigrating(): boolean {
    return this._migrating
  }

  setLocation(location: AcpChatLocation): void {
    if (this._location === location) return
    this._location = location
    this._publish()
    this._scheduleWrite()
    this._migrating = true
    try {
      this._applySideEffect(location)
    } finally {
      this._migrating = false
    }
    this._telemetry.publicLog('acp.chat_location_set', { location })
  }

  toggle(): void {
    this.setLocation(this._location === 'editor' ? 'sidebar' : 'editor')
  }

  override dispose(): void {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer)
      this._writeTimer = undefined
      void this._writeNow()
    }
    super.dispose()
  }

  // -- internals ---------------------------------------------------------

  private _publish(): void {
    this.location.set(this._location, undefined)
    this._contextKey.set(this._location)
  }

  private async _load(): Promise<void> {
    try {
      const raw = await this._storage.get<PersistedShape>(STORAGE_KEY, StorageScope.GLOBAL)
      if (
        raw &&
        typeof raw === 'object' &&
        raw.schemaVersion === SCHEMA_VERSION &&
        (raw.location === 'editor' || raw.location === 'sidebar')
      ) {
        this._location = raw.location
        this._publish()
      } else if (raw !== undefined) {
        this._logger.warn(
          `ignoring acp.chatLocation with schemaVersion=${(raw as PersistedShape).schemaVersion}`,
        )
      }
    } catch (err) {
      this._logger.warn(`failed to load chat location: ${(err as Error).message}`)
    } finally {
      this._loaded = true
    }
  }

  private _scheduleWrite(): void {
    if (this._writeTimer) return
    this._writeTimer = setTimeout(() => {
      this._writeTimer = undefined
      void this._writeNow()
    }, 100)
  }

  private async _writeNow(): Promise<void> {
    try {
      const payload: PersistedShape = {
        schemaVersion: SCHEMA_VERSION,
        location: this._location,
      }
      await this._storage.set(STORAGE_KEY, payload, StorageScope.GLOBAL)
    } catch (err) {
      this._telemetry.publicLogError('acp.chat_location_persist_failed', {
        error: (err as Error).message,
      })
      this._logger.warn(`failed to persist chat location: ${(err as Error).message}`)
    }
  }

  private _applySideEffect(location: AcpChatLocation): void {
    if (location === 'sidebar') {
      for (const group of this._editorGroups.groups) {
        for (const editor of [...group.editors]) {
          if (editor instanceof AcpSessionEditorInput) {
            group.closeEditor(editor)
          }
        }
      }
      return
    }
    const active = this._sessions.activeSession.get()
    if (!active) return
    this._editor.openEditor(
      this._inst.createInstance(AcpSessionEditorInput, active.id, active.agentId),
    )
  }
}
