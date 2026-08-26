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

/**
 * What one agent's handshake needs: the candidates to advertise, plus the model
 * its own config file actually picks.
 *
 * The pick is returned separately rather than left implicit as `candidates[0]`
 * because the two are not the same thing when the config file names no model:
 * the pick is then absent while `candidates[0]` is merely the provider's first
 * declared model. Callers resolving "the model this session will run" must be
 * able to tell those apart — see `contextWindowFor`.
 */
export interface AcpAgentModelCandidates {
  /** Effective model id from the agent's own config file; undefined when unset. */
  readonly pick: string | undefined
  readonly candidates: readonly AcpModelCandidate[]
}

export interface IAcpModelCandidateService {
  readonly _serviceBrand: undefined
  /**
   * Model candidates (id + known context window) to advertise for a session of
   * `agentId` running on `authority` (undefined = the local host), plus the
   * agent's own configured pick. No candidates for agents with no editor-side
   * credential model (user-defined agents), and none when the host runs on a
   * subscription or an external credential (the agent's own catalogue is already
   * correct there).
   */
  extraModelsForAgent(agentId: string, authority?: string): Promise<AcpAgentModelCandidates>
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

  async extraModelsForAgent(agentId: string, authority?: string): Promise<AcpAgentModelCandidates> {
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
    return { pick: undefined, candidates: [] }
  }

  private async _resolve(
    activeAuth: AgentActiveAuth,
    protocol: AiWireProtocol,
    pick: string | undefined,
  ): Promise<AcpAgentModelCandidates> {
    const provider = await this._findProvider(activeAuth)
    return { pick, candidates: extraModelCandidatesForAgentSettings(pick, provider, protocol) }
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
