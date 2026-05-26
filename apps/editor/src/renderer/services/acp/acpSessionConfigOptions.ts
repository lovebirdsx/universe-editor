/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ConfigOptionStateMachine — owns the per-session `configOptions` observable,
 *  the echo-suppression set, and the `setConfigOption` push. Lives inside an
 *  AcpSession; created once per session and disposed with it.
 *--------------------------------------------------------------------------------------------*/

import {
  observableValue,
  type ITelemetryService,
  type ISettableObservable,
} from '@universe-editor/platform'
import type {
  SessionConfigOption,
  SessionUpdate,
  SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk'
import type { IAcpClientConnection } from './acpClientService.js'
import type { IAcpSessionHistoryService } from './acpSessionHistory.js'
import type { IAcpAgentDefaultsService } from './acpAgentDefaultsService.js'

export interface ConfigOptionSessionInfo {
  /** The session's canonical id (agent-issued — equals `sessionIdOnAgent`). */
  readonly sessionId: string
  readonly agentId: string
}

export interface ConfigOptionStateMachineDeps {
  readonly conn: IAcpClientConnection
  readonly telemetry: ITelemetryService
  readonly sessionInfo: ConfigOptionSessionInfo
  readonly history?: IAcpSessionHistoryService
  readonly defaults?: IAcpAgentDefaultsService
}

export class ConfigOptionStateMachine {
  readonly configOptions: ISettableObservable<readonly SessionConfigOption[]>

  /**
   * Guard against ping-pong between user-driven `setConfigOption` and the
   * agent's echoed `config_option_update`. We add the configId before issuing
   * the RPC and remove it after the response. Updates that arrive while a
   * configId is in this set are skipped — the user's local change wins.
   */
  private readonly _pendingPushes = new Set<string>()

  constructor(private readonly _deps: ConfigOptionStateMachineDeps) {
    this.configOptions = observableValue<readonly SessionConfigOption[]>(
      `acp.session.configOptions.${_deps.sessionInfo.sessionId}`,
      [],
    )
  }

  /** Replay the configOptions bag returned by `session/new` or `session/load`. */
  applyInitState(opts: readonly SessionConfigOption[]): void {
    this.configOptions.set(opts, undefined)
  }

  /** Handle a `config_option_update` notification — filters out echoes for in-flight user pushes. */
  ingestUpdate(update: Extract<SessionUpdate, { sessionUpdate: 'config_option_update' }>): void {
    const filtered =
      this._pendingPushes.size === 0
        ? update.configOptions
        : update.configOptions.filter((o) => !this._pendingPushes.has(o.id))
    if (filtered.length === update.configOptions.length) {
      this.configOptions.set(update.configOptions, undefined)
    } else if (filtered.length > 0) {
      const cur = this.configOptions.get()
      const byId = new Map(cur.map((o) => [o.id, o] as const))
      for (const f of filtered) byId.set(f.id, f)
      this.configOptions.set(Array.from(byId.values()), undefined)
    }
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const params: SetSessionConfigOptionRequest = {
      sessionId: this._deps.sessionInfo.sessionId,
      configId,
      value,
    }
    this._pendingPushes.add(configId)
    try {
      const resp = await this._deps.conn.conn.setSessionConfigOption(params)
      if (resp.configOptions) {
        this.configOptions.set(resp.configOptions, undefined)
      }
      const { sessionId, agentId } = this._deps.sessionInfo
      this._deps.history?.setHistoryConfigOption(sessionId, configId, value)
      this._deps.defaults?.setDefault(agentId, configId, value)
      this._deps.telemetry.publicLog('acp.config_option_set', { sessionId, configId })
    } finally {
      this._pendingPushes.delete(configId)
    }
  }
}
