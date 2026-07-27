/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpAgentDefaultsService — per-agent defaults for `configOptions` + MCP.
 *
 *  Distinct from `AcpSessionHistoryService`: history caches per-session
 *  selections (so resuming one specific conversation restores its MODEL/MODE);
 *  this service caches the *last user-driven choice* per agentId, so a *brand
 *  new* session against the same agent automatically inherits the last value
 *  the user picked. Different lifetimes (history can be cleared without
 *  blowing away the user's MODEL/MODE preference), so we keep separate
 *  storage keys.
 *
 *  Two default families share one storage row:
 *    - `options`: configOption id → value (MODEL / MODE / …)
 *    - `mcp`:     MCP server-name whitelist a brand-new session inherits
 *                 (absent = inherit the whole non-disabled pool)
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
import { PersistedStateBase } from '../persistedStateBase.js'

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
  /**
   * The saved MCP whitelist for brand-new sessions of `agentId`; `null` when
   * the user never saved one (sessions then inherit every non-disabled pool
   * entry).
   */
  getMcpServerNames(agentId: string): readonly string[] | null
  /**
   * Save (or clear, with `null`) the per-agent MCP whitelist. Only affects
   * sessions created after the call — live sessions keep their own selection.
   */
  setMcpServerNames(agentId: string, names: readonly string[] | null): void
}

export const IAcpAgentDefaultsService =
  createDecorator<IAcpAgentDefaultsService>('acpAgentDefaultsService')

const STORAGE_KEY = 'acp.agentDefaults'
const SCHEMA_VERSION = 2

interface PersistedShape {
  readonly schemaVersion: number
  readonly defaults: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly mcpDefaults?: Readonly<Record<string, readonly string[]>>
}

interface DefaultsState {
  readonly options: Record<string, Record<string, string>>
  readonly mcp: Record<string, readonly string[]>
}

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
    const m = this._state.options[agentId]
    return m ? { ...m } : EMPTY
  }

  setDefault(agentId: string, configId: string, value: string): void {
    const cur = this._state.options[agentId]
    if (cur && cur[configId] === value) return
    const nextForAgent: Record<string, string> = { ...(cur ?? {}), [configId]: value }
    this._state = {
      ...this._state,
      options: { ...this._state.options, [agentId]: nextForAgent },
    }
    this._publishState()
    this._scheduleWrite()
  }

  getMcpServerNames(agentId: string): readonly string[] | null {
    const names = this._state.mcp[agentId]
    return names === undefined ? null : [...names]
  }

  setMcpServerNames(agentId: string, names: readonly string[] | null): void {
    const cur = this._state.mcp[agentId]
    if (names === null) {
      if (cur === undefined) return
      const nextMcp = { ...this._state.mcp }
      delete nextMcp[agentId]
      this._state = { ...this._state, mcp: nextMcp }
    } else {
      if (cur !== undefined && cur.length === names.length && cur.every((x, i) => x === names[i]))
        return
      this._state = {
        ...this._state,
        mcp: { ...this._state.mcp, [agentId]: [...names] },
      }
    }
    this._scheduleWrite()
  }

  // -- PersistedStateBase hooks ----------------------------------------

  protected override _emptyState(): DefaultsState {
    return { options: {}, mcp: {} }
  }

  protected override _serialize(state: DefaultsState): PersistedShape {
    return { schemaVersion: SCHEMA_VERSION, defaults: state.options, mcpDefaults: state.mcp }
  }

  protected override _deserialize(raw: unknown): DefaultsState | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined
    const o = raw as PersistedShape
    // v1 predates mcpDefaults; its rows load with an empty MCP map (inherit).
    if (
      (o.schemaVersion !== SCHEMA_VERSION && o.schemaVersion !== 1) ||
      !isNestedStringRecord(o.defaults)
    ) {
      this._logger.warn(`ignoring acp.agentDefaults with schemaVersion=${o.schemaVersion}`)
      return undefined
    }
    if (o.mcpDefaults !== undefined && !isStringArrayRecord(o.mcpDefaults)) {
      this._logger.warn('ignoring acp.agentDefaults with malformed mcpDefaults')
      return undefined
    }
    // Clone so we own the mutable shape.
    const options: Record<string, Record<string, string>> = {}
    for (const [agentId, m] of Object.entries(o.defaults)) {
      options[agentId] = { ...m }
    }
    const mcp: Record<string, readonly string[]> = {}
    for (const [agentId, names] of Object.entries(o.mcpDefaults ?? {})) {
      mcp[agentId] = [...names]
    }
    return { options, mcp }
  }

  protected override _mergeOnLoad(loaded: DefaultsState, current: DefaultsState): DefaultsState {
    // Any defaults set in-memory before load completed win over the persisted
    // row for the same agentId.
    const options: Record<string, Record<string, string>> = {}
    for (const [agentId, m] of Object.entries(loaded.options)) {
      options[agentId] = { ...m }
    }
    for (const [agentId, m] of Object.entries(current.options)) {
      options[agentId] = { ...(options[agentId] ?? {}), ...m }
    }
    return { options, mcp: { ...loaded.mcp, ...current.mcp } }
  }

  protected override _onStateReplaced(state: DefaultsState): void {
    this._publishSnapshot(state.options)
  }

  // -- private helpers -------------------------------------------------

  private _publishState(): void {
    this._publishSnapshot(this._state.options)
  }

  private _publishSnapshot(options: DefaultsState['options']): void {
    // Freeze the inner maps so observers can rely on referential stability.
    const snapshot: Record<string, Readonly<Record<string, string>>> = {}
    for (const [agentId, m] of Object.entries(options)) {
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

function isStringArrayRecord(v: unknown): v is Readonly<Record<string, readonly string[]>> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  for (const inner of Object.values(v as Record<string, unknown>)) {
    if (!Array.isArray(inner)) return false
    for (const val of inner) {
      if (typeof val !== 'string') return false
    }
  }
  return true
}

registerSingleton(IAcpAgentDefaultsService, AcpAgentDefaultsService, InstantiationType.Delayed)
