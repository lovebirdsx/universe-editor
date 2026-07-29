/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Whether a credential profile is the one currently injected into
 *  ~/.claude/settings.json. Shared by the Authentication panel ("In use" badge)
 *  and useClaudeConfig.saveProfile (re-applying an edited in-use profile).
 *--------------------------------------------------------------------------------------------*/

import type { ClaudeCredentialProfile } from '../../../../shared/ipc/claudeConfigService.js'

const API_KEY = 'ANTHROPIC_API_KEY'
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL = 'ANTHROPIC_BASE_URL'

/** True when the profile's credentials exactly match the active settings.json env. */
export function isProfileActive(
  profile: ClaudeCredentialProfile,
  env: Record<string, string>,
  model: string | undefined,
): boolean {
  if (profile.kind === 'apiKey') {
    return !env[AUTH_TOKEN] && !env[BASE_URL] && !!env[API_KEY] && env[API_KEY] === profile.apiKey
  }
  if (env[AUTH_TOKEN] !== profile.authToken || env[BASE_URL] !== profile.baseUrl) return false
  // A model preset is part of the gateway identity: if the profile pins a model,
  // it is only "in use" when settings.model matches too.
  const pinned = profile.model?.trim()
  return !pinned || model === pinned
}
