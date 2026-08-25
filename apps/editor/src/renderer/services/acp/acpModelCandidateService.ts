/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpModelCandidateService — turns the editor's provider registry into the extra
 *  model candidates injected into an agent handshake (`_meta.extraModels`).
 *
 *  Each built-in agent has its own credential selection (`aiSettings.json`'s
 *  `agentSettings.claude` / `agentSettings.codex`) naming one provider entry, and
 *  its own wire protocol. This service joins the two: resolve the selected
 *  provider, read the models it declares under that protocol, and add the model
 *  currently configured in the agent's own file (`settings.json` / `config.toml`)
 *  so it stays selectable. See acpModelCandidates.ts for why the forks need this
 *  at all.
 *
 *  Reads are on-demand (three cheap IPC calls per session handshake) rather than
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
import {
  AGENT_SUBSCRIPTION_AUTH,
  IClaudeConfigService,
} from '../../../shared/ipc/claudeConfigService.js'
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
   * `agentId`. Empty for agents with no editor-side credential model (user-defined
   * agents), and empty when no provider is selected (the agent then runs on its
   * official subscription, whose own catalogue is already correct).
   */
  extraModelsForAgent(agentId: string): Promise<readonly AcpModelCandidate[]>
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

  async extraModelsForAgent(agentId: string): Promise<readonly AcpModelCandidate[]> {
    if (agentId === 'claude-code') {
      const [agentSettings, settings] = await Promise.all([
        this._claude.readAgentSettings(),
        this._claude.read(),
      ])
      // The pick is whatever settings.json says — the same value the fork reads.
      return this._resolve(agentSettings.authentication, CLAUDE_AGENT_PROTOCOL, settings.model)
    }
    if (agentId === 'codex') {
      const settings = await this._codex.readAgentSettings()
      return this._resolve(settings.authentication, CODEX_AGENT_PROTOCOL, settings.model)
    }
    return []
  }

  private async _resolve(
    authentication: string | undefined,
    protocol: AiWireProtocol,
    pick: string | undefined,
  ): Promise<readonly AcpModelCandidate[]> {
    const provider = await this._findProvider(authentication)
    return extraModelCandidatesForAgentSettings(pick, provider, protocol)
  }

  /** The resolved provider the agent authenticates with, or undefined for
   *  `@subscription` / no selection / an id that no longer exists. */
  private async _findProvider(
    authentication: string | undefined,
  ): Promise<AiResolvedProvider | undefined> {
    if (authentication === undefined || authentication === AGENT_SUBSCRIPTION_AUTH) return undefined
    const [entries, knowledge] = await Promise.all([
      this._ai.getProviders(),
      this._ai.getModelKnowledge(),
    ])
    return resolveProviderEntries(entries, knowledge).providers.find((p) => p.id === authentication)
  }
}

registerSingleton(IAcpModelCandidateService, AcpModelCandidateService, InstantiationType.Delayed)
