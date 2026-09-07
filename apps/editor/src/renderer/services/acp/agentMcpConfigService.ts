/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  agentMcpConfigService — read-only import of the MCP servers each agent CLI
 *  declares in its own config files, folded into the MCP definition pool as
 *  per-agent layers (`agentAffinity`).
 *
 *  Sources (all read-only — the editor never writes these files, the CLIs own
 *  them):
 *    - claude-code  user:    `~/.claude.json` + `~/.claude/settings.json`
 *                            (merged by main, `~/.claude.json` wins)
 *    - codex        user:    `~/.codex/config.toml`  `[mcp_servers]`
 *    - codex        project: `<cwd>/.codex/config.toml` `[mcp_servers]`
 *
 *  Claude's project-level source is the workspace-root `.mcp.json`, which is
 *  NOT read here — `AcpSessionService` already reads it through IFileService
 *  and now tags that layer `agentAffinity: 'claude-code'` (previously it was
 *  shared by every agent).
 *
 *  Unknown agents contribute nothing: their pool is exactly the shared
 *  settings/extension layers. Remote workspaces are routed by `authority`
 *  through the AgentConfig channel — reads hit the remote host's files.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, Disposable, Emitter, type Event } from '@universe-editor/platform'
import { IClaudeConfigService } from '../../../shared/ipc/claudeConfigService.js'
import { ICodexConfigService } from '../../../shared/ipc/codexConfigService.js'
import {
  agentIdToMcpAffinity,
  type McpAgentAffinity,
  type McpServerRawLayer,
} from './acpMcpServers.js'

export interface AgentMcpLayers {
  readonly userLayers: readonly McpServerRawLayer[]
  readonly projectLayers: readonly McpServerRawLayer[]
}

const EMPTY_LAYERS: AgentMcpLayers = { userLayers: [], projectLayers: [] }

export interface IAgentMcpConfigService {
  readonly _serviceBrand: undefined

  /**
   * Fires when an agent-owned MCP config file changes on disk (claude user
   * files or the codex user file — project files are re-read per refresh and
   * not watched). The payload is the affinity whose layers changed.
   */
  readonly onDidChange: Event<{ readonly agentAffinity: McpAgentAffinity }>

  /**
   * Read the agent-owned MCP layers for `agentId`. Unknown agents resolve to
   * empty layers. Read failures degrade to empty records in main, so this
   * never rejects on a missing/broken file.
   */
  readAgentMcpLayers(agentId: string, cwd?: string, authority?: string): Promise<AgentMcpLayers>
}

export const IAgentMcpConfigService =
  createDecorator<IAgentMcpConfigService>('agentMcpConfigService')

export class AgentMcpConfigService extends Disposable implements IAgentMcpConfigService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChange = this._register(new Emitter<{ agentAffinity: McpAgentAffinity }>())
  readonly onDidChange: Event<{ agentAffinity: McpAgentAffinity }> = this._onDidChange.event

  constructor(
    @IClaudeConfigService private readonly _claudeConfig: IClaudeConfigService,
    @ICodexConfigService private readonly _codexConfig: ICodexConfigService,
  ) {
    super()
    this._register(
      this._claudeConfig.onDidChangeMcpConfig(() =>
        this._onDidChange.fire({ agentAffinity: 'claude-code' }),
      ),
    )
    this._register(
      this._codexConfig.onDidChangeMcpConfig(() =>
        this._onDidChange.fire({ agentAffinity: 'codex' }),
      ),
    )
  }

  async readAgentMcpLayers(
    agentId: string,
    cwd?: string,
    authority?: string,
  ): Promise<AgentMcpLayers> {
    const affinity = agentIdToMcpAffinity(agentId)
    if (affinity === undefined) return EMPTY_LAYERS
    if (affinity === 'claude-code') {
      const raw = await this._claudeConfig.readMcpServers(authority)
      return {
        userLayers: [{ source: 'agent-user', raw, agentAffinity: 'claude-code' }],
        // Claude's project layer is the workspace-root `.mcp.json`, supplied
        // by AcpSessionService (it owns the workspace-aware file read).
        projectLayers: [],
      }
    }
    const [userRaw, projectRaw] = await Promise.all([
      this._codexConfig.readUserMcpServers(authority),
      cwd !== undefined ? this._codexConfig.readProjectMcpServers(cwd, authority) : undefined,
    ])
    return {
      userLayers: [{ source: 'agent-user', raw: userRaw, agentAffinity: 'codex' }],
      projectLayers:
        projectRaw !== undefined
          ? [{ source: 'agent-project', raw: projectRaw, agentAffinity: 'codex' }]
          : [],
    }
  }
}
