/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpModelCandidateService — turns the editor's provider registry into the extra
 *  model candidates injected into an agent handshake (`_meta.extraModels`).
 *
 *  Each built-in agent authenticates with whatever its own config files say (per
 *  host: `resolveActiveAuth(authority)`), and speaks its own wire protocol. This
 *  service joins the two: resolve the provider actually in effect, read the models
 *  it declares under that protocol, and add the model currently configured in the
 *  agent's own file (`settings.json` / `config.toml`) so it stays selectable. See
 *  acpModelCandidates.ts for why the forks need this at all.
 *
 *  Everything is read for the session's host, not the window's: a remote session
 *  runs against the remote `settings.json` / `config.toml`, and offering it the
 *  local host's models would advertise a model its process cannot reach.
 *
 *  Reads are on-demand (a few cheap IPC calls per session handshake) rather than
 *  cached: the user can edit providers or switch credentials at any time, and a
 *  stale list would silently drop the model they just configured.
 *--------------------------------------------------------------------------------------------*/

import {
  IAiModelService,
  InstantiationType,
  createDecorator,
  registerSingleton,
  resolveProviderEntries,
  type AiResolvedProvider,
  type AiWireProtocol,
} from '@universe-editor/platform'
import type { AgentActiveAuth } from '../../../shared/ai/agentActiveAuth.js'
import { IClaudeConfigService } from '../../../shared/ipc/claudeConfigService.js'
import { ICodexConfigService } from '../../../shared/ipc/codexConfigService.js'
import {
  CLAUDE_AGENT_PROTOCOL,
  CODEX_AGENT_PROTOCOL,
  extraModelCandidatesForAgentSettings,
  type AcpModelCandidate,
} from './acpModelCandidates.js'

export interface IAcpModelCandidateService {
  readonly _serviceBrand: undefined
  /**
   * Model candidates (id + known context window) to advertise for a session of
   * `agentId` running on `authority` (undefined = the local host). Empty for
   * agents with no editor-side credential model (user-defined agents), and empty
   * when the host runs on a subscription or an external credential (the agent's
   * own catalogue is already correct there).
   */
  extraModelsForAgent(agentId: string, authority?: string): Promise<readonly AcpModelCandidate[]>
}

export const IAcpModelCandidateService = createDecorator<IAcpModelCandidateService>(
  'acpModelCandidateService',
)

export class AcpModelCandidateService implements IAcpModelCandidateService {
  declare readonly _serviceBrand: undefined

  constructor(
    @IAiModelService private readonly _ai: IAiModelService,
    @IClaudeConfigService private readonly _claude: IClaudeConfigService,
    @ICodexConfigService private readonly _codex: ICodexConfigService,
  ) {}

  async extraModelsForAgent(
    agentId: string,
    authority?: string,
  ): Promise<readonly AcpModelCandidate[]> {
    if (agentId === 'claude-code') {
      const [activeAuth, settings] = await Promise.all([
        this._claude.resolveActiveAuth(authority),
        this._claude.read(authority),
      ])
      // The pick is whatever settings.json says — the same value the fork reads.
      return this._resolve(activeAuth, CLAUDE_AGENT_PROTOCOL, settings.model)
    }
    if (agentId === 'codex') {
      const [activeAuth, settings] = await Promise.all([
        this._codex.resolveActiveAuth(authority),
        this._codex.read(authority),
      ])
      const model = settings['model']
      return this._resolve(
        activeAuth,
        CODEX_AGENT_PROTOCOL,
        typeof model === 'string' ? model : undefined,
      )
    }
    return []
  }

  private async _resolve(
    activeAuth: AgentActiveAuth,
    protocol: AiWireProtocol,
    pick: string | undefined,
  ): Promise<readonly AcpModelCandidate[]> {
    const provider = await this._findProvider(activeAuth)
    return extraModelCandidatesForAgentSettings(pick, provider, protocol)
  }

  /** The resolved provider in effect on that host, or undefined for a
   *  subscription / an external credential / an id that no longer exists. */
  private async _findProvider(
    activeAuth: AgentActiveAuth,
  ): Promise<AiResolvedProvider | undefined> {
    const providerId = activeAuth.kind === 'provider' ? activeAuth.providerId : undefined
    if (providerId === undefined) return undefined
    const [entries, knowledge] = await Promise.all([
      this._ai.getProviders(),
      this._ai.getModelKnowledge(),
    ])
    return resolveProviderEntries(entries, knowledge).providers.find((p) => p.id === providerId)
  }
}

registerSingleton(IAcpModelCandidateService, AcpModelCandidateService, InstantiationType.Delayed)
