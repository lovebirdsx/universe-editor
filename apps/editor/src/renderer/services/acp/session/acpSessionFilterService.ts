/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionFilterService — shared state for the AGENTS session list: both the
 *  ephemeral search box AND the persistent filter/sort selection (the funnel
 *  menu, modeled on VSCode's chat session filter). The trigger buttons live in
 *  the view title bar (AgentsViewToolbar / SessionsPopover) while the find widget
 *  and the filtered list live in the body (SessionListBody); they have no common
 *  React ancestor, so the state is held here as observables.
 *
 *  The search query stays ephemeral. Sort mode + excluded agents + excluded
 *  statuses are persisted in GLOBAL storage (a filter preference is a UX choice
 *  shared across workspaces, matching VSCode's PROFILE-scoped excludes).
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  IStorageService,
  ILoggerService,
  ITelemetryService,
  InstantiationType,
  StorageScope,
  observableValue,
  registerSingleton,
  type ILogger,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import type { AcpSessionDisplayStatus } from './acpSessionStatus.js'

/** How the session list is ordered. */
export type SessionSortMode = 'created' | 'updated'

/**
 * The coarse status buckets the filter menu offers, folding the finer
 * {@link AcpSessionDisplayStatus} down to the four states VSCode surfaces:
 *  - `in_progress`: connecting / running
 *  - `input_needed`: waiting on the user (a pending question or permission → `ask`)
 *  - `failed`: errored
 *  - `completed`: idle / closed, and any non-live history row (no live status)
 */
export type SessionStatusBucket = 'completed' | 'in_progress' | 'input_needed' | 'failed'

export const SESSION_STATUS_BUCKETS: readonly SessionStatusBucket[] = [
  'completed',
  'in_progress',
  'input_needed',
  'failed',
]

/** Fold a session's display status into the coarse bucket the filter uses. */
export function statusBucketFor(status: AcpSessionDisplayStatus): SessionStatusBucket {
  switch (status) {
    case 'connecting':
    case 'running':
      return 'in_progress'
    case 'ask':
      return 'input_needed'
    case 'errored':
      return 'failed'
    default:
      return 'completed'
  }
}

export interface IAcpSessionFilterService {
  readonly _serviceBrand: undefined
  readonly searchOpen: IObservable<boolean>
  readonly query: IObservable<string>
  readonly sortMode: IObservable<SessionSortMode>
  /** Agent ids the user has toggled OFF (hidden). Empty = show all agents. */
  readonly excludedAgentIds: IObservable<ReadonlySet<string>>
  /** Status buckets the user has toggled OFF (hidden). Empty = show all statuses. */
  readonly excludedStatuses: IObservable<ReadonlySet<SessionStatusBucket>>
  /** True when sort + excludes are all at their defaults (used to dim the funnel). */
  readonly isFilterDefault: IObservable<boolean>

  setQuery(value: string): void
  openSearch(): void
  closeSearch(): void
  toggleSearch(): void

  setSortMode(mode: SessionSortMode): void
  toggleAgent(agentId: string): void
  toggleStatus(bucket: SessionStatusBucket): void
  /** Restore sort + excludes to defaults. Does not touch the search box. */
  resetFilters(): void
  /** Idempotent async load of the persisted filter state. */
  initialize(): Promise<void>
}

export const IAcpSessionFilterService =
  createDecorator<IAcpSessionFilterService>('acpSessionFilterService')

const DEFAULT_SORT: SessionSortMode = 'updated'
const STORAGE_KEY = 'acp.sessionFilter'
const SCHEMA_VERSION = 1

interface PersistedShape {
  readonly schemaVersion: number
  readonly sortMode: SessionSortMode
  readonly excludedAgentIds: readonly string[]
  readonly excludedStatuses: readonly SessionStatusBucket[]
}

export class AcpSessionFilterService extends Disposable implements IAcpSessionFilterService {
  declare readonly _serviceBrand: undefined

  private readonly _searchOpen: ISettableObservable<boolean> = observableValue(
    'acp.sessionSearchOpen',
    false,
  )
  private readonly _query: ISettableObservable<string> = observableValue(
    'acp.sessionSearchQuery',
    '',
  )
  private readonly _sortMode: ISettableObservable<SessionSortMode> = observableValue(
    'acp.sessionSortMode',
    DEFAULT_SORT,
  )
  private readonly _excludedAgentIds: ISettableObservable<ReadonlySet<string>> = observableValue(
    'acp.sessionExcludedAgents',
    new Set<string>(),
  )
  private readonly _excludedStatuses: ISettableObservable<ReadonlySet<SessionStatusBucket>> =
    observableValue('acp.sessionExcludedStatuses', new Set<SessionStatusBucket>())
  private readonly _isFilterDefault: ISettableObservable<boolean> = observableValue(
    'acp.sessionFilterDefault',
    true,
  )

  readonly searchOpen: IObservable<boolean> = this._searchOpen
  readonly query: IObservable<string> = this._query
  readonly sortMode: IObservable<SessionSortMode> = this._sortMode
  readonly excludedAgentIds: IObservable<ReadonlySet<string>> = this._excludedAgentIds
  readonly excludedStatuses: IObservable<ReadonlySet<SessionStatusBucket>> = this._excludedStatuses
  readonly isFilterDefault: IObservable<boolean> = this._isFilterDefault

  private readonly _logger: ILogger
  private _loaded = false
  private _loadPromise: Promise<void> | undefined
  private _writeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @ITelemetryService private readonly _telemetry: ITelemetryService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({
      id: 'acpSessionFilter',
      name: 'ACP Session Filter',
    })
  }

  initialize(): Promise<void> {
    if (this._loaded) return Promise.resolve()
    if (this._loadPromise) return this._loadPromise
    this._loadPromise = this._load()
    return this._loadPromise
  }

  setQuery(value: string): void {
    this._query.set(value, undefined)
  }

  openSearch(): void {
    this._searchOpen.set(true, undefined)
  }

  closeSearch(): void {
    this._query.set('', undefined)
    this._searchOpen.set(false, undefined)
  }

  toggleSearch(): void {
    if (this._searchOpen.get()) this.closeSearch()
    else this.openSearch()
  }

  setSortMode(mode: SessionSortMode): void {
    if (this._sortMode.get() === mode) return
    this._sortMode.set(mode, undefined)
    this._refreshDefault()
    this._scheduleWrite()
  }

  toggleAgent(agentId: string): void {
    const next = new Set(this._excludedAgentIds.get())
    if (!next.delete(agentId)) next.add(agentId)
    this._excludedAgentIds.set(next, undefined)
    this._refreshDefault()
    this._scheduleWrite()
  }

  toggleStatus(bucket: SessionStatusBucket): void {
    const next = new Set(this._excludedStatuses.get())
    if (!next.delete(bucket)) next.add(bucket)
    this._excludedStatuses.set(next, undefined)
    this._refreshDefault()
    this._scheduleWrite()
  }

  resetFilters(): void {
    if (this.isFilterDefault.get()) return
    this._sortMode.set(DEFAULT_SORT, undefined)
    this._excludedAgentIds.set(new Set<string>(), undefined)
    this._excludedStatuses.set(new Set<SessionStatusBucket>(), undefined)
    this._refreshDefault()
    this._scheduleWrite()
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

  private _refreshDefault(): void {
    const isDefault =
      this._sortMode.get() === DEFAULT_SORT &&
      this._excludedAgentIds.get().size === 0 &&
      this._excludedStatuses.get().size === 0
    this._isFilterDefault.set(isDefault, undefined)
  }

  private async _load(): Promise<void> {
    try {
      const raw = await this._storage.get<PersistedShape>(STORAGE_KEY, StorageScope.GLOBAL)
      if (raw && typeof raw === 'object' && raw.schemaVersion === SCHEMA_VERSION) {
        if (raw.sortMode === 'created' || raw.sortMode === 'updated') {
          this._sortMode.set(raw.sortMode, undefined)
        }
        if (Array.isArray(raw.excludedAgentIds)) {
          this._excludedAgentIds.set(new Set(raw.excludedAgentIds), undefined)
        }
        if (Array.isArray(raw.excludedStatuses)) {
          const valid = raw.excludedStatuses.filter((s): s is SessionStatusBucket =>
            SESSION_STATUS_BUCKETS.includes(s),
          )
          this._excludedStatuses.set(new Set(valid), undefined)
        }
        this._refreshDefault()
      } else if (raw !== undefined) {
        this._logger.warn(
          `ignoring acp.sessionFilter with schemaVersion=${(raw as PersistedShape).schemaVersion}`,
        )
      }
    } catch (err) {
      this._logger.warn(`failed to load session filter: ${(err as Error).message}`)
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
        sortMode: this._sortMode.get(),
        excludedAgentIds: [...this._excludedAgentIds.get()],
        excludedStatuses: [...this._excludedStatuses.get()],
      }
      await this._storage.set(STORAGE_KEY, payload, StorageScope.GLOBAL)
    } catch (err) {
      this._telemetry.publicLogError('acp.session_filter_persist_failed', {
        error: (err as Error).message,
      })
      this._logger.warn(`failed to persist session filter: ${(err as Error).message}`)
    }
  }
}

registerSingleton(IAcpSessionFilterService, AcpSessionFilterService, InstantiationType.Delayed)
