/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpConfigOptionsCacheService — per-agent cache of the full `configOptions`
 *  bag last advertised by `session/new` / `session/load`.
 *
 *  Why a separate cache from `AcpAgentDefaultsService`: that service stores only
 *  the `{ configId: value }` selections, which is enough to *restore* a choice
 *  but NOT enough to *render* the config bar — the UI needs the full option
 *  skeleton (name / category / type / options list). Caching the whole bag lets
 *  a freshly created session render its config bar optimistically (with the last
 *  known shape) the instant it appears, instead of waiting 1-5s for the agent
 *  handshake to return the real bag. The real bag replaces the optimistic one
 *  once `session/new` lands.
 *
 *  Keyed by agentId because different agent kinds advertise different options
 *  (Claude vs Codex differ in model/mode/thought_level shape). Scope follows the
 *  same workspace-first + global-fallback policy as agent defaults.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  IStorageService,
  ILoggerService,
  ITelemetryService,
  IWorkspaceService,
  InstantiationType,
  observableValue,
  registerSingleton,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { PersistedStateBase } from './persistedStateBase.js'

export interface IAcpConfigOptionsCacheService {
  readonly _serviceBrand: undefined
  /** Observable mirror of the in-memory map. Tests assert against it without scheduling. */
  readonly cache: IObservable<Readonly<Record<string, readonly SessionConfigOption[]>>>
  /** Idempotent. AcpInitContribution fire-and-forgets at startup. */
  initialize(): Promise<void>
  /** Last known bag for an agent, or an empty array if none cached. */
  get(agentId: string): readonly SessionConfigOption[]
  /** Replace the cached bag for an agent (called after a real session/new bag arrives). */
  set(agentId: string, bag: readonly SessionConfigOption[]): void
}

export const IAcpConfigOptionsCacheService = createDecorator<IAcpConfigOptionsCacheService>(
  'acpConfigOptionsCacheService',
)

const STORAGE_KEY = 'acp.configOptionsCache'
const SCHEMA_VERSION = 1

interface PersistedShape {
  readonly schemaVersion: number
  readonly cache: Readonly<Record<string, readonly SessionConfigOption[]>>
}

type CacheState = Record<string, readonly SessionConfigOption[]>

const EMPTY: readonly SessionConfigOption[] = Object.freeze([])

export class AcpConfigOptionsCacheService
  extends PersistedStateBase<CacheState>
  implements IAcpConfigOptionsCacheService
{
  declare readonly _serviceBrand: undefined

  readonly cache: ISettableObservable<Readonly<Record<string, readonly SessionConfigOption[]>>>

  constructor(
    @IStorageService storage: IStorageService,
    @IWorkspaceService workspace: IWorkspaceService,
    @ITelemetryService telemetry: ITelemetryService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super(storage, workspace, telemetry, loggerService, {
      storageKey: STORAGE_KEY,
      loggerId: 'acpConfigOptionsCache',
      loggerName: 'ACP Config Options Cache',
      persistFailureEvent: 'acp.config_options_cache_persist_failed',
    })
    this.cache = observableValue<Readonly<Record<string, readonly SessionConfigOption[]>>>(
      'acp.configOptionsCache',
      {},
    )
  }

  get(agentId: string): readonly SessionConfigOption[] {
    return this._state[agentId] ?? EMPTY
  }

  set(agentId: string, bag: readonly SessionConfigOption[]): void {
    this._state = { ...this._state, [agentId]: bag }
    this._publishState()
    this._scheduleWrite()
  }

  // -- PersistedStateBase hooks ----------------------------------------

  protected override _emptyState(): CacheState {
    return {}
  }

  protected override _serialize(state: CacheState): PersistedShape {
    return { schemaVersion: SCHEMA_VERSION, cache: state }
  }

  protected override _deserialize(raw: unknown): CacheState | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined
    const o = raw as PersistedShape
    if (o.schemaVersion !== SCHEMA_VERSION || !isConfigOptionsRecord(o.cache)) {
      this._logger.warn(`ignoring acp.configOptionsCache with schemaVersion=${o.schemaVersion}`)
      return undefined
    }
    const next: CacheState = {}
    for (const [agentId, bag] of Object.entries(o.cache)) {
      next[agentId] = [...bag]
    }
    return next
  }

  protected override _mergeOnLoad(loaded: CacheState, current: CacheState): CacheState {
    // Any bag captured in-memory before load completed wins over the persisted
    // row for the same agentId (it reflects a live handshake this run).
    return { ...loaded, ...current }
  }

  protected override _onStateReplaced(state: CacheState): void {
    this._publishSnapshot(state)
  }

  // -- private helpers -------------------------------------------------

  private _publishState(): void {
    this._publishSnapshot(this._state)
  }

  private _publishSnapshot(state: CacheState): void {
    this.cache.set({ ...state }, undefined)
  }
}

function isConfigOptionsRecord(
  v: unknown,
): v is Readonly<Record<string, readonly SessionConfigOption[]>> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  for (const bag of Object.values(v as Record<string, unknown>)) {
    if (!Array.isArray(bag)) return false
    for (const opt of bag) {
      if (
        opt == null ||
        typeof opt !== 'object' ||
        typeof (opt as { id?: unknown }).id !== 'string'
      )
        return false
    }
  }
  return true
}

registerSingleton(
  IAcpConfigOptionsCacheService,
  AcpConfigOptionsCacheService,
  InstantiationType.Delayed,
)
