/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  Test stub for IAgentMcpConfigService — programmable per-agent layer records,
 *  empty by default. `fireChange` simulates an on-disk agent config edit.
 *--------------------------------------------------------------------------------------------*/
import { Emitter, type Event } from '@universe-editor/platform'
import type { AgentMcpLayers, IAgentMcpConfigService } from '../../agentMcpConfigService.js'
import type { McpAgentAffinity, McpServerRawLayer } from '../../acpMcpServers.js'

const EMPTY: AgentMcpLayers = { userLayers: [], projectLayers: [] }

export class StubAgentMcpConfigService implements IAgentMcpConfigService {
  declare readonly _serviceBrand: undefined
  private readonly _onDidChange = new Emitter<{ agentAffinity: McpAgentAffinity }>()
  readonly onDidChange: Event<{ agentAffinity: McpAgentAffinity }> = this._onDidChange.event

  /** Per-agent raw records; keyed `${agentId}` with optional `|project` suffix. */
  readonly records = new Map<string, Record<string, unknown>>()
  readonly calls: Array<{ agentId: string; cwd?: string; authority?: string }> = []

  setUserRecord(agentId: string, raw: Record<string, unknown>): void {
    this.records.set(agentId, raw)
  }

  setProjectRecord(agentId: string, raw: Record<string, unknown>): void {
    this.records.set(`${agentId}|project`, raw)
  }

  fireChange(agentAffinity: McpAgentAffinity): void {
    this._onDidChange.fire({ agentAffinity })
  }

  readAgentMcpLayers(agentId: string, cwd?: string, authority?: string): Promise<AgentMcpLayers> {
    this.calls.push({
      agentId,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(authority !== undefined ? { authority } : {}),
    })
    const affinity: McpAgentAffinity | undefined =
      agentId === 'claude-code' || agentId === 'codex' ? agentId : undefined
    if (affinity === undefined) return Promise.resolve(EMPTY)
    const userRaw = this.records.get(agentId)
    const projectRaw = this.records.get(`${agentId}|project`)
    const userLayers: McpServerRawLayer[] =
      userRaw !== undefined ? [{ source: 'agent-user', raw: userRaw, agentAffinity: affinity }] : []
    const projectLayers: McpServerRawLayer[] =
      projectRaw !== undefined
        ? [{ source: 'agent-project', raw: projectRaw, agentAffinity: affinity }]
        : []
    return Promise.resolve({ userLayers, projectLayers })
  }
}
