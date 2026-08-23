/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure comparison between a persisted `authentication` selection and the env
 *  block currently injected into ~/.claude/settings.json. Shared by the
 *  Authentication panel's "In use" badge and any drift warning: a gateway /
 *  official-key selection is active only while settings.json still carries the
 *  exact derived env; `@subscription` (or an unset selection) is active only
 *  while no credential env is set.
 *--------------------------------------------------------------------------------------------*/

import type { AiResolvedProvider } from '@universe-editor/platform'
import { AGENT_SUBSCRIPTION_AUTH } from '../../../../shared/ipc/claudeConfigService.js'
import { deriveClaudeAuth, findProviderById } from '../../../../shared/ai/providerDerivation.js'

const API_KEY = 'ANTHROPIC_API_KEY'
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL = 'ANTHROPIC_BASE_URL'

/** True when `authentication` is the credential currently reflected by `env`. */
export function isClaudeAuthActive(
  authentication: string | undefined,
  env: Record<string, string>,
  providers: readonly AiResolvedProvider[],
): boolean {
  if (authentication === undefined || authentication === AGENT_SUBSCRIPTION_AUTH) {
    return !env[API_KEY] && !env[AUTH_TOKEN] && !env[BASE_URL]
  }
  const derived = deriveClaudeAuth(findProviderById(providers, authentication))
  if (derived === undefined) return false
  if (derived.kind === 'apiKey') {
    return !env[AUTH_TOKEN] && !env[BASE_URL] && env[API_KEY] === derived.apiKey
  }
  return env[AUTH_TOKEN] === derived.authToken && env[BASE_URL] === derived.baseUrl
}
