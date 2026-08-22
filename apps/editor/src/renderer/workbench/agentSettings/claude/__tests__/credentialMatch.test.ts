/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  isProfileActive: pure match between a credential profile and the env block
 *  currently injected into ~/.claude/settings.json. A gateway profile references
 *  a provider instance, so its match is decided by deriving the instance's env.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AiProviderInstance, AiProviderType } from '@universe-editor/platform'
import type { ClaudeCredentialProfile } from '../../../../../shared/ipc/claudeConfigService.js'
import { isProfileActive } from '../credentialMatch.js'

const API_KEY = 'ANTHROPIC_API_KEY'
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL = 'ANTHROPIC_BASE_URL'

const NO_PROVIDERS: readonly AiProviderInstance[] = []
const NO_TYPES: Readonly<Record<string, AiProviderType>> = {}

const gatewayProvider: AiProviderInstance = {
  name: 'gw',
  type: 'anthropic',
  apiKey: 'tok-1',
  baseUrl: 'https://gw.example.com',
}
const gatewayTypes: Readonly<Record<string, AiProviderType>> = {
  anthropic: { protocol: 'anthropic-messages' },
}

describe('isProfileActive', () => {
  it('matches an apiKey profile only when the env key is identical', () => {
    const profile: ClaudeCredentialProfile = {
      id: 'p1',
      label: 'Personal',
      kind: 'apiKey',
      apiKey: 'sk-ant-old',
    }
    expect(
      isProfileActive(profile, { [API_KEY]: 'sk-ant-old' }, undefined, NO_PROVIDERS, NO_TYPES),
    ).toBe(true)
    expect(
      isProfileActive(profile, { [API_KEY]: 'sk-ant-new' }, undefined, NO_PROVIDERS, NO_TYPES),
    ).toBe(false)
    expect(isProfileActive(profile, {}, undefined, NO_PROVIDERS, NO_TYPES)).toBe(false)
  })

  it('does not match an apiKey profile while a token / base URL overrides it', () => {
    const profile: ClaudeCredentialProfile = {
      id: 'p1',
      label: 'Personal',
      kind: 'apiKey',
      apiKey: 'sk-ant-old',
    }
    const env = { [API_KEY]: 'sk-ant-old', [AUTH_TOKEN]: 'tok' }
    expect(isProfileActive(profile, env, undefined, NO_PROVIDERS, NO_TYPES)).toBe(false)
  })

  it('matches a gateway profile on the derived token + base URL', () => {
    const profile: ClaudeCredentialProfile = {
      id: 'g1',
      label: 'Gateway',
      kind: 'gateway',
      providerRef: 'anthropic/gw',
    }
    const env = { [AUTH_TOKEN]: 'tok-1', [BASE_URL]: 'https://gw.example.com' }
    expect(isProfileActive(profile, env, undefined, [gatewayProvider], gatewayTypes)).toBe(true)
    expect(
      isProfileActive(
        profile,
        { ...env, [AUTH_TOKEN]: 'tok-2' },
        undefined,
        [gatewayProvider],
        gatewayTypes,
      ),
    ).toBe(false)
    expect(
      isProfileActive(
        profile,
        { ...env, [BASE_URL]: 'https://other.example.com' },
        undefined,
        [gatewayProvider],
        gatewayTypes,
      ),
    ).toBe(false)
  })

  it('requires settings.model to match when the gateway profile pins a model', () => {
    const profile: ClaudeCredentialProfile = {
      id: 'g1',
      label: 'Gateway',
      kind: 'gateway',
      providerRef: 'anthropic/gw',
      model: 'kimi-k3',
    }
    const env = { [AUTH_TOKEN]: 'tok-1', [BASE_URL]: 'https://gw.example.com' }
    expect(isProfileActive(profile, env, 'kimi-k3', [gatewayProvider], gatewayTypes)).toBe(true)
    expect(isProfileActive(profile, env, 'claude-opus', [gatewayProvider], gatewayTypes)).toBe(
      false,
    )
    expect(isProfileActive(profile, env, undefined, [gatewayProvider], gatewayTypes)).toBe(false)
  })

  it('is not active when the gateway ref cannot be resolved', () => {
    const profile: ClaudeCredentialProfile = {
      id: 'g1',
      label: 'Gateway',
      kind: 'gateway',
      providerRef: 'anthropic/missing',
    }
    const env = { [AUTH_TOKEN]: 'tok-1', [BASE_URL]: 'https://gw.example.com' }
    expect(isProfileActive(profile, env, undefined, [gatewayProvider], gatewayTypes)).toBe(false)
  })
})
