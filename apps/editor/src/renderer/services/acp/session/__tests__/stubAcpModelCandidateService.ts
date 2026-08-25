/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Test stub for IAcpModelCandidateService — scriptable per-agent model lists
 *  with no provider registry behind them. Lets AcpSessionService tests
 *  construct the service and assert the `_meta.extraModels` handshake payload
 *  (including the reject path, which must never break the handshake).
 *--------------------------------------------------------------------------------------------*/

import type { IAcpModelCandidateService } from '../../acpModelCandidateService.js'
import type { AcpModelCandidate } from '../../acpModelCandidates.js'

export interface StubAcpModelCandidateOptions {
  /** Models returned for every agent; default []. */
  readonly models?: readonly string[]
  /** Known context window per model id; models absent from it carry none. */
  readonly contextWindows?: Readonly<Record<string, number>>
  /** When true, extraModelsForAgent rejects — exercises the best-effort guard. */
  readonly reject?: boolean
}

export function stubAcpModelCandidateService(
  opts: StubAcpModelCandidateOptions = {},
): IAcpModelCandidateService {
  return {
    _serviceBrand: undefined,
    async extraModelsForAgent(_agentId: string): Promise<readonly AcpModelCandidate[]> {
      if (opts.reject === true) throw new Error('stub candidate service failure')
      return (opts.models ?? []).map((id) => {
        const contextWindow = opts.contextWindows?.[id]
        return contextWindow !== undefined ? { id, contextWindow } : { id }
      })
    },
  }
}
