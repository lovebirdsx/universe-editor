/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSideTaskIndexService — durable child→parent links for side tasks.
 *
 *  A side task's only identity marker is `sideTaskOf` on its session-history
 *  row, and that row is evictable (MAX_ENTRIES) while the forked agent-side
 *  session is not: `session/list` keeps reporting the fork, so the hydrate
 *  sweep rebuilds a row that no longer knows it is a side task — the child
 *  then surfaces as a regular session in the Sessions list and in
 *  "Resume Agent Session…". This index remembers the link (and the quote)
 *  beyond the row's lifetime so a rebuilt row is re-marked.
 *
 *  GLOBAL scope, deliberately: the keys are agent-issued session ids (globally
 *  unique), and a side task must stay hidden even when its parent row lives in
 *  another workspace bucket — the fork itself is reported by every sweep whose
 *  scope absorbs its cwd.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  IStorageService,
  ILoggerService,
  ITelemetryService,
  InstantiationType,
  StorageScope,
  registerSingleton,
  type ILogger,
} from '@universe-editor/platform'

/** One remembered side task: the fork (`child`) and the session it came from. */
export interface SideTaskLink {
  /** `sessionIdOnAgent` of the forked side task. */
  readonly child: string
  /** `sessionIdOnAgent` of the session it was forked from. */
  readonly parent: string
  /** The selection the side task was created from, mirroring `sideTaskQuote`. */
  readonly quote?: string
  /** When the link was first recorded — the eviction key for {@link MAX_LINKS}. */
  readonly at: number
}

export interface IAcpSideTaskIndexService {
  readonly _serviceBrand: undefined
  /** Idempotent: safe to call multiple times. */
  initialize(): Promise<void>
  /** Record (or refresh) a side task link. Idempotent per `child`. */
  remember(child: string, parent: string, quote?: string): void
  /** The remembered link for `child`, if any. */
  get(child: string): SideTaskLink | undefined
  /** Drop a link — the user deleted the side task for good. */
  forget(child: string): void
}

export const IAcpSideTaskIndexService =
  createDecorator<IAcpSideTaskIndexService>('acpSideTaskIndexService')

const STORAGE_KEY = 'acp.sideTaskIndex'
const SCHEMA_VERSION = 1
/**
 * Bound on remembered links. Side tasks are cheap to forget (they only need to
 * outlive their history row), but the index must not grow without limit across
 * years of sessions; oldest-first eviction matches the history ceiling's spirit.
 */
const MAX_LINKS = 500

interface PersistedShape {
  readonly schemaVersion: number
  readonly links: readonly SideTaskLink[]
}

export class AcpSideTaskIndexService extends Disposable implements IAcpSideTaskIndexService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _links = new Map<string, SideTaskLink>()
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
      id: 'acpSideTaskIndex',
      name: 'ACP Side Task Index',
    })
  }

  initialize(): Promise<void> {
    if (this._loaded) return Promise.resolve()
    if (this._loadPromise) return this._loadPromise
    this._loadPromise = this._load()
    return this._loadPromise
  }

  remember(child: string, parent: string, quote?: string): void {
    const existing = this._links.get(child)
    // An absent quote on a re-add (e.g. a resume that carries no selection)
    // keeps what was recorded at fork time. The parent is written once at fork
    // time and never changes; `at` is kept so eviction stays oldest-first.
    const nextQuote = quote ?? existing?.quote
    if (existing !== undefined && existing.parent === parent && existing.quote === nextQuote) return
    const link: SideTaskLink = {
      child,
      parent,
      ...(nextQuote !== undefined ? { quote: nextQuote } : {}),
      at: existing?.at ?? Date.now(),
    }
    this._links.set(child, link)
    this._evictOverflow()
    this._scheduleWrite()
  }

  get(child: string): SideTaskLink | undefined {
    return this._links.get(child)
  }

  forget(child: string): void {
    if (!this._links.delete(child)) return
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

  private _evictOverflow(): void {
    if (this._links.size <= MAX_LINKS) return
    const oldestFirst = [...this._links.values()].sort((a, b) => a.at - b.at)
    for (const link of oldestFirst.slice(0, this._links.size - MAX_LINKS)) {
      this._links.delete(link.child)
    }
  }

  private async _load(): Promise<void> {
    try {
      const raw = await this._storage.get<PersistedShape>(STORAGE_KEY, StorageScope.GLOBAL)
      if (raw && typeof raw === 'object' && raw.schemaVersion === SCHEMA_VERSION) {
        if (Array.isArray(raw.links)) {
          for (const link of raw.links) {
            // In-memory links recorded before load completed win: they come from
            // a fork the user just made in this window.
            if (isValidLink(link) && !this._links.has(link.child)) {
              this._links.set(link.child, link)
            }
          }
          this._evictOverflow()
        }
      } else if (raw !== undefined) {
        this._logger.warn(
          `ignoring acp.sideTaskIndex with schemaVersion=${(raw as PersistedShape).schemaVersion}`,
        )
      }
    } catch (err) {
      this._logger.warn(`failed to load side task index: ${(err as Error).message}`)
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
        links: [...this._links.values()],
      }
      await this._storage.set(STORAGE_KEY, payload, StorageScope.GLOBAL)
    } catch (err) {
      this._telemetry.publicLogError('acp.side_task_index_persist_failed', {
        error: (err as Error).message,
      })
      this._logger.warn(`failed to persist side task index: ${(err as Error).message}`)
    }
  }
}

function isValidLink(v: unknown): v is SideTaskLink {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o['child'] === 'string' &&
    o['child'].length > 0 &&
    typeof o['parent'] === 'string' &&
    o['parent'].length > 0 &&
    (o['quote'] === undefined || typeof o['quote'] === 'string') &&
    typeof o['at'] === 'number'
  )
}

registerSingleton(IAcpSideTaskIndexService, AcpSideTaskIndexService, InstantiationType.Delayed)
