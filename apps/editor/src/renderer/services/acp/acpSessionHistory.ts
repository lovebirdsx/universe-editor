/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionHistoryService — durable, agent-anchored session metadata.
 *
 *  We persist the minimum required to resume a session against an ACP agent
 *  that advertises `agentCapabilities.loadSession: true`:
 *    - sessionIdOnAgent: the id the agent owns (replayed via `session/load`)
 *    - agentId / cwd:    used to respawn the agent with the same sandbox root
 *    - title / timestamps: pure UX
 *  The conversation messages themselves stay on the agent side; we never try
 *  to mirror them locally.
 *
 *  Storage uses IStorageService at GLOBAL scope (history follows the user, not
 *  the workspace) under a single JSON value with a schema version so future
 *  shape changes can migrate forward without crashing on stale data.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  IStorageService,
  ILoggerService,
  ITelemetryService,
  StorageScope,
  observableValue,
  type ILogger,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'

export interface AcpSessionHistoryEntry {
  /** Local UUID-ish id — distinct from `sessionIdOnAgent`. */
  readonly id: string
  readonly agentId: string
  /** The id the agent assigned at `session/new` time; replayed via `session/load`. */
  readonly sessionIdOnAgent: string
  readonly title: string
  /** Workspace cwd at creation time. Optional because users may run agent-only. */
  readonly cwd?: string
  /** Unix epoch milliseconds. */
  readonly createdAt: number
  /** Unix epoch milliseconds — updated on resume + on outbound prompt. */
  readonly lastUsedAt: number
}

export interface IAcpSessionHistoryService {
  readonly _serviceBrand: undefined
  readonly entries: IObservable<readonly AcpSessionHistoryEntry[]>
  /** Idempotent: safe to call multiple times. main.tsx fire-and-forgets. */
  initialize(): Promise<void>
  list(): readonly AcpSessionHistoryEntry[]
  get(id: string): AcpSessionHistoryEntry | undefined
  /** Returns the new entry (caller usually only needs the id). */
  add(
    entry: Omit<AcpSessionHistoryEntry, 'id' | 'createdAt' | 'lastUsedAt'>,
  ): AcpSessionHistoryEntry
  /** Bump lastUsedAt; no-op if id is unknown. */
  touch(id: string): void
  remove(id: string): void
  clear(): void
}

export const IAcpSessionHistoryService = createDecorator<IAcpSessionHistoryService>(
  'acpSessionHistoryService',
)

const STORAGE_KEY = 'acp.sessionHistory'
const SCHEMA_VERSION = 1
const MAX_ENTRIES = 100

interface PersistedShape {
  readonly schemaVersion: number
  readonly entries: readonly AcpSessionHistoryEntry[]
}

export class AcpSessionHistoryService extends Disposable implements IAcpSessionHistoryService {
  declare readonly _serviceBrand: undefined

  readonly entries: ISettableObservable<readonly AcpSessionHistoryEntry[]>

  private _entries: AcpSessionHistoryEntry[] = []
  private _loaded = false
  private _loadPromise: Promise<void> | undefined
  private _seq = 0
  private _writeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly _logger: ILogger

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @ITelemetryService private readonly _telemetry: ITelemetryService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'acpSessionHistory', name: 'ACP History' })
    this.entries = observableValue<readonly AcpSessionHistoryEntry[]>('acp.sessionHistory', [])
  }

  initialize(): Promise<void> {
    if (this._loaded) return Promise.resolve()
    if (this._loadPromise) return this._loadPromise
    this._loadPromise = this._load()
    return this._loadPromise
  }

  list(): readonly AcpSessionHistoryEntry[] {
    return this._entries
  }

  get(id: string): AcpSessionHistoryEntry | undefined {
    return this._entries.find((e) => e.id === id)
  }

  add(
    entry: Omit<AcpSessionHistoryEntry, 'id' | 'createdAt' | 'lastUsedAt'>,
  ): AcpSessionHistoryEntry {
    const now = Date.now()
    // Same (agentId, sessionIdOnAgent) tuple replaces the prior local row —
    // restarting the editor and creating a new session against the same agent
    // session id should not produce duplicates.
    const existingIdx = this._entries.findIndex(
      (e) => e.agentId === entry.agentId && e.sessionIdOnAgent === entry.sessionIdOnAgent,
    )
    const id = existingIdx >= 0 ? this._entries[existingIdx]!.id : this._mintId()
    const createdAt = existingIdx >= 0 ? this._entries[existingIdx]!.createdAt : now
    const next: AcpSessionHistoryEntry = {
      id,
      agentId: entry.agentId,
      sessionIdOnAgent: entry.sessionIdOnAgent,
      title: entry.title,
      ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
      createdAt,
      lastUsedAt: now,
    }
    if (existingIdx >= 0) {
      this._entries = [next, ...this._entries.filter((_, i) => i !== existingIdx)]
    } else {
      this._entries = [next, ...this._entries]
    }
    this._truncate()
    this._publish()
    this._scheduleWrite()
    return next
  }

  touch(id: string): void {
    const idx = this._entries.findIndex((e) => e.id === id)
    if (idx === -1) return
    const cur = this._entries[idx]!
    const next: AcpSessionHistoryEntry = { ...cur, lastUsedAt: Date.now() }
    this._entries = [next, ...this._entries.filter((_, i) => i !== idx)]
    this._publish()
    this._scheduleWrite()
  }

  remove(id: string): void {
    const before = this._entries.length
    this._entries = this._entries.filter((e) => e.id !== id)
    if (this._entries.length !== before) {
      this._publish()
      this._scheduleWrite()
    }
  }

  clear(): void {
    if (this._entries.length === 0) return
    this._entries = []
    this._publish()
    this._scheduleWrite()
  }

  override dispose(): void {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer)
      this._writeTimer = undefined
      // Flush a final write synchronously so we don't lose the trailing edit.
      void this._writeNow()
    }
    super.dispose()
  }

  // -- internals ---------------------------------------------------------

  private async _load(): Promise<void> {
    try {
      const raw = await this._storage.get<PersistedShape>(STORAGE_KEY, StorageScope.GLOBAL)
      if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) {
        // Schema-version guard: if a future version is found, fail closed
        // (start empty) rather than try to interpret unknown fields.
        if (raw.schemaVersion === SCHEMA_VERSION) {
          const persisted = raw.entries.filter(isValidEntry)
          // Merge: any entries the caller already added before load completed
          // win over the persisted row with the same id.
          const seen = new Set(this._entries.map((e) => e.id))
          const merged = [...this._entries]
          for (const e of persisted) {
            if (!seen.has(e.id)) merged.push(e)
          }
          merged.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
          this._entries = merged
          this._truncate()
          // Bump _seq so newly-minted ids don't collide with anything we just loaded.
          for (const e of this._entries) {
            const n = parseLocalSeq(e.id)
            if (n !== undefined && n > this._seq) this._seq = n
          }
          this._publish()
        } else {
          this._logger.warn(
            `[acp] ignoring acp.sessionHistory with schemaVersion=${raw.schemaVersion}`,
          )
        }
      }
    } catch (err) {
      this._logger.warn(`[acp] failed to load session history: ${(err as Error).message}`)
    } finally {
      this._loaded = true
    }
  }

  private _truncate(): void {
    if (this._entries.length > MAX_ENTRIES) {
      this._entries = this._entries.slice(0, MAX_ENTRIES)
    }
  }

  private _publish(): void {
    this.entries.set(this._entries, undefined)
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
        entries: this._entries,
      }
      await this._storage.set(STORAGE_KEY, payload, StorageScope.GLOBAL)
    } catch (err) {
      this._telemetry.publicLogError('acp.session_history_persist_failed', {
        error: (err as Error).message,
      })
      this._logger.warn(`[acp] failed to persist session history: ${(err as Error).message}`)
    }
  }

  private _mintId(): string {
    this._seq++
    return `h${this._seq}-${Date.now().toString(36)}`
  }
}

function isValidEntry(v: unknown): v is AcpSessionHistoryEntry {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o['id'] === 'string' &&
    typeof o['agentId'] === 'string' &&
    typeof o['sessionIdOnAgent'] === 'string' &&
    typeof o['title'] === 'string' &&
    (o['cwd'] === undefined || typeof o['cwd'] === 'string') &&
    typeof o['createdAt'] === 'number' &&
    typeof o['lastUsedAt'] === 'number'
  )
}

function parseLocalSeq(id: string): number | undefined {
  // ids minted here are `h<n>-<base36>` — extract the n part.
  const m = /^h(\d+)-/.exec(id)
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) ? n : undefined
}
