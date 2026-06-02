/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpAgentDefaultsService — per-agent default for `configOptions`.
 *
 *  Distinct from `AcpSessionHistoryService`: history caches per-session
 *  selections (so resuming one specific conversation restores its MODEL/MODE);
 *  this service caches the *last user-driven choice* per agentId, so a *brand
 *  new* session against the same agent automatically inherits the last value
 *  the user picked. Different lifetimes (history can be cleared without
 *  blowing away the user's MODEL/MODE preference), so we keep separate
 *  storage keys.
 *
 *  Scope follows the same workspace-first + global-fallback policy as session
 *  history (delegated to `PersistedStateBase`): each workspace keeps its own
 *  per-agent defaults so a `MODEL=opus` choice in workspace-A doesn't seep
 *  into workspace-B's brand new sessions.
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
import { PersistedStateBase } from './persistedStateBase.js'

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

type DefaultsState = Record<string, Record<string, string>>

const EMPTY: Readonly<Record<string, string>> = Object.freeze({})

export class AcpAgentDefaultsService
  extends PersistedStateBase<DefaultsState>
  implements IAcpAgentDefaultsService
{
  declare readonly _serviceBrand: undefined

  readonly defaults: ISettableObservable<Readonly<Record<string, Readonly<Record<string, string>>>>>

  constructor(
    @IStorageService storage: IStorageService,
    @IWorkspaceService workspace: IWorkspaceService,
    @ITelemetryService telemetry: ITelemetryService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super(storage, workspace, telemetry, loggerService, {
      storageKey: STORAGE_KEY,
      loggerId: 'acpAgentDefaults',
      loggerName: 'ACP Agent Defaults',
      persistFailureEvent: 'acp.agent_defaults_persist_failed',
    })
    this.defaults = observableValue<Readonly<Record<string, Readonly<Record<string, string>>>>>(
      'acp.agentDefaults',
      {},
    )
  }

  getDefaults(agentId: string): Readonly<Record<string, string>> {
    const m = this._state[agentId]
    return m ? { ...m } : EMPTY
  }

  setDefault(agentId: string, configId: string, value: string): void {
    const cur = this._state[agentId]
    if (cur && cur[configId] === value) return
    const nextForAgent: Record<string, string> = { ...(cur ?? {}), [configId]: value }
    this._state = { ...this._state, [agentId]: nextForAgent }
    this._publishState()
    this._scheduleWrite()
  }

  // -- PersistedStateBase hooks ----------------------------------------

  protected override _emptyState(): DefaultsState {
    return {}
  }

  protected override _serialize(state: DefaultsState): PersistedShape {
    return { schemaVersion: SCHEMA_VERSION, defaults: state }
  }

  protected override _deserialize(raw: unknown): DefaultsState | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined
    const o = raw as PersistedShape
    if (o.schemaVersion !== SCHEMA_VERSION || !isNestedStringRecord(o.defaults)) {
      this._logger.warn(`ignoring acp.agentDefaults with schemaVersion=${o.schemaVersion}`)
      return undefined
    }
    // Clone so we own the mutable shape.
    const next: DefaultsState = {}
    for (const [agentId, m] of Object.entries(o.defaults)) {
      next[agentId] = { ...m }
    }
    return next
  }

  protected override _mergeOnLoad(loaded: DefaultsState, current: DefaultsState): DefaultsState {
    // Any defaults set in-memory before load completed win over the persisted
    // row for the same agentId.
    const next: DefaultsState = {}
    for (const [agentId, m] of Object.entries(loaded)) {
      next[agentId] = { ...m }
    }
    for (const [agentId, m] of Object.entries(current)) {
      next[agentId] = { ...(next[agentId] ?? {}), ...m }
    }
    return next
  }

  protected override _onStateReplaced(state: DefaultsState): void {
    this._publishSnapshot(state)
  }

  // -- private helpers -------------------------------------------------

  private _publishState(): void {
    this._publishSnapshot(this._state)
  }

  private _publishSnapshot(state: DefaultsState): void {
    // Freeze the inner maps so observers can rely on referential stability.
    const snapshot: Record<string, Readonly<Record<string, string>>> = {}
    for (const [agentId, m] of Object.entries(state)) {
      snapshot[agentId] = { ...m }
    }
    this.defaults.set(snapshot, undefined)
  }
}

function isNestedStringRecord(
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

registerSingleton(IAcpAgentDefaultsService, AcpAgentDefaultsService, InstantiationType.Delayed)
