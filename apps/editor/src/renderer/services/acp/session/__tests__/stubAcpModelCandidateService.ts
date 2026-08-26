/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Test stub for IAcpModelCandidateService — scriptable per-agent model lists
 *  with no provider registry behind them. Lets AcpSessionService tests
 *  construct the service and assert the `_meta.extraModels` handshake payload
 *  (including the reject path, which must never break the handshake).
 *--------------------------------------------------------------------------------------------*/

import type {
  AcpAgentModelCandidates,
  IAcpModelCandidateService,
} from '../../acpModelCandidateService.js'

export interface StubAcpModelCandidateOptions {
  /** Models returned for every agent; default []. */
  readonly models?: readonly string[]
  /** Known context window per model id; models absent from it carry none. */
  readonly contextWindows?: Readonly<Record<string, number>>
  /**
   * The model the agent's own config file picks. Deliberately independent of
   * `models`: production reads it from settings.json / config.toml, and the
   * codex case where it is absent (config.toml naming no model) is exactly the
   * regression these tests guard.
   */
  readonly pick?: string
  /** When true, extraModelsForAgent rejects — exercises the best-effort guard. */
  readonly reject?: boolean
}

export function stubAcpModelCandidateService(
  opts: StubAcpModelCandidateOptions = {},
): IAcpModelCandidateService {
  return {
    _serviceBrand: undefined,
    async extraModelsForAgent(_agentId: string): Promise<AcpAgentModelCandidates> {
      if (opts.reject === true) throw new Error('stub candidate service failure')
      const candidates = (opts.models ?? []).map((id) => {
        const contextWindow = opts.contextWindows?.[id]
        return contextWindow !== undefined ? { id, contextWindow } : { id }
      })
      return { pick: opts.pick, candidates }
    },
  }
}
