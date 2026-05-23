/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpAgentDefaultsService — per-agent global default for `configOptions`.
 *
 *  Distinct from `AcpSessionHistoryService`: history caches per-session
 *  selections (so resuming one specific conversation restores its MODEL/MODE);
 *  this service caches the *last user-driven choice* per agentId, so a *brand
 *  new* session against the same agent automatically inherits the last value
 *  the user picked. Different lifetimes (history can be cleared without
 *  blowing away the user's MODEL/MODE preference), so we keep separate
 *  storage keys.
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

export interface IAcpAgentDefaultsService {
  readonly _serviceBrand: undefined
  /**
   * Observable mirror of the in-memory map. UI doesn't currently consume it,
   * but tests use it to assert without scheduling.
   */
  readonly defaults: IObservable<Readonly<Record<string, Readonly<Record<string, string>>>>>
  /** Idempotent. main.tsx fire-and-forgets at startup. */
  initialize(): Promise<void>
  getDefaults(agentId: string): Readonly<Record<string, string>>
  setDefault(agentId: string, configId: string, value: string): void
}

export const IAcpAgentDefaultsService =
  createDecorator<IAcpAgentDefaultsService>('acpAgentDefaultsService')

const STORAGE_KEY = 'acp.agentDefaults'
const SCHEMA_VERSION = 1

interface PersistedShape {
  readonly schemaVersion: number
  readonly defaults: Readonly<Record<string, Readonly<Record<string, string>>>>
}

const EMPTY: Readonly<Record<string, string>> = Object.freeze({})

export class AcpAgentDefaultsService extends Disposable implements IAcpAgentDefaultsService {
  declare readonly _serviceBrand: undefined

  readonly defaults: ISettableObservable<Readonly<Record<string, Readonly<Record<string, string>>>>>

  private _defaults: Record<string, Record<string, string>> = {}
  private _loaded = false
  private _loadPromise: Promise<void> | undefined
  private _writeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly _logger: ILogger

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @ITelemetryService private readonly _telemetry: ITelemetryService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({
      id: 'acpAgentDefaults',
      name: 'ACP Agent Defaults',
    })
    this.defaults = observableValue<Readonly<Record<string, Readonly<Record<string, string>>>>>(
      'acp.agentDefaults',
      {},
    )
  }

  initialize(): Promise<void> {
    if (this._loaded) return Promise.resolve()
    if (this._loadPromise) return this._loadPromise
    this._loadPromise = this._load()
    return this._loadPromise
  }

  getDefaults(agentId: string): Readonly<Record<string, string>> {
    const m = this._defaults[agentId]
    return m ? { ...m } : EMPTY
  }

  setDefault(agentId: string, configId: string, value: string): void {
    const cur = this._defaults[agentId]
    if (cur && cur[configId] === value) return
    const nextForAgent: Record<string, string> = { ...(cur ?? {}), [configId]: value }
    this._defaults = { ...this._defaults, [agentId]: nextForAgent }
    this._publish()
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

  private async _load(): Promise<void> {
    try {
      const raw = await this._storage.get<PersistedShape>(STORAGE_KEY, StorageScope.GLOBAL)
      if (
        raw &&
        typeof raw === 'object' &&
        raw.schemaVersion === SCHEMA_VERSION &&
        isStringRecord2(raw.defaults)
      ) {
        // Clone so we own the mutable shape; freeze ensures callers don't
        // accidentally mutate the persisted-in-memory copy.
        const next: Record<string, Record<string, string>> = {}
        for (const [agentId, m] of Object.entries(raw.defaults)) {
          next[agentId] = { ...m }
        }
        this._defaults = next
        this._publish()
      } else if (raw !== undefined) {
        this._logger.warn(
          `[acp] ignoring acp.agentDefaults with schemaVersion=${
            (raw as PersistedShape).schemaVersion
          }`,
        )
      }
    } catch (err) {
      this._logger.warn(`[acp] failed to load agent defaults: ${(err as Error).message}`)
    } finally {
      this._loaded = true
    }
  }

  private _publish(): void {
    // Freeze the inner maps so observers can rely on referential stability.
    const snapshot: Record<string, Readonly<Record<string, string>>> = {}
    for (const [agentId, m] of Object.entries(this._defaults)) {
      snapshot[agentId] = { ...m }
    }
    this.defaults.set(snapshot, undefined)
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
        defaults: this._defaults,
      }
      await this._storage.set(STORAGE_KEY, payload, StorageScope.GLOBAL)
    } catch (err) {
      this._telemetry.publicLogError('acp.agent_defaults_persist_failed', {
        error: (err as Error).message,
      })
      this._logger.warn(`[acp] failed to persist agent defaults: ${(err as Error).message}`)
    }
  }
}

function isStringRecord2(
  v: unknown,
): v is Readonly<Record<string, Readonly<Record<string, string>>>> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  for (const inner of Object.values(v as Record<string, unknown>)) {
    if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return false
    for (const val of Object.values(inner as Record<string, unknown>)) {
      if (typeof val !== 'string') return false
    }
  }
  return true
}
