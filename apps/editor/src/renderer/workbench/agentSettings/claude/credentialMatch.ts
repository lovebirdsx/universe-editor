/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Whether a credential profile is the one currently injected into
 *  ~/.claude/settings.json. Shared by the Authentication panel ("In use" badge)
 *  and useClaudeConfig.saveProfile (re-applying an edited in-use profile).
 *
 *  A `gateway` profile references a provider instance; its active state is
 *  decided by deriving the instance's env and comparing it to settings.json.
 *--------------------------------------------------------------------------------------------*/

import type { AiProviderInstance, AiProviderType } from '@universe-editor/platform'
import type { ClaudeCredentialProfile } from '../../../../shared/ipc/claudeConfigService.js'
import { deriveClaudeEnv, resolveProviderRef } from '../../../../shared/ai/providerDerivation.js'

const API_KEY = 'ANTHROPIC_API_KEY'
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL = 'ANTHROPIC_BASE_URL'

/** True when the profile's credentials exactly match the active settings.json env. */
export function isProfileActive(
  profile: ClaudeCredentialProfile,
  env: Record<string, string>,
  model: string | undefined,
  providers: readonly AiProviderInstance[],
  types: Readonly<Record<string, AiProviderType>>,
): boolean {
  if (profile.kind === 'apiKey') {
    return !env[AUTH_TOKEN] && !env[BASE_URL] && !!env[API_KEY] && env[API_KEY] === profile.apiKey
  }
  const ref = profile.providerRef
  if (ref === undefined) return false
  const resolved = resolveProviderRef(ref, providers, types)
  const derived =
    resolved !== undefined ? deriveClaudeEnv(resolved.instance, resolved.type) : undefined
  if (derived === undefined) return false
  if (env[AUTH_TOKEN] !== derived.authToken || env[BASE_URL] !== derived.baseUrl) return false
  // A model preset is part of the gateway identity: if the profile pins a model,
  // it is only "in use" when settings.model matches too.
  const pinned = profile.model?.trim()
  return !pinned || model === pinned
}
