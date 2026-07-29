/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  isProfileActive: pure match between a credential profile and the env block
 *  currently injected into ~/.claude/settings.json.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { ClaudeCredentialProfile } from '../../../../../shared/ipc/claudeConfigService.js'
import { isProfileActive } from '../credentialMatch.js'

const API_KEY = 'ANTHROPIC_API_KEY'
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL = 'ANTHROPIC_BASE_URL'

describe('isProfileActive', () => {
  it('matches an apiKey profile only when the env key is identical', () => {
    const profile: ClaudeCredentialProfile = {
      id: 'p1',
      label: 'Personal',
      kind: 'apiKey',
      apiKey: 'sk-ant-old',
    }
    expect(isProfileActive(profile, { [API_KEY]: 'sk-ant-old' }, undefined)).toBe(true)
    expect(isProfileActive(profile, { [API_KEY]: 'sk-ant-new' }, undefined)).toBe(false)
    expect(isProfileActive(profile, {}, undefined)).toBe(false)
  })

  it('does not match an apiKey profile while a token / base URL overrides it', () => {
    const profile: ClaudeCredentialProfile = {
      id: 'p1',
      label: 'Personal',
      kind: 'apiKey',
      apiKey: 'sk-ant-old',
    }
    const env = { [API_KEY]: 'sk-ant-old', [AUTH_TOKEN]: 'tok' }
    expect(isProfileActive(profile, env, undefined)).toBe(false)
  })

  it('matches a gateway profile on token + base URL', () => {
    const profile: ClaudeCredentialProfile = {
      id: 'g1',
      label: 'Gateway',
      kind: 'gateway',
      authToken: 'tok-1',
      baseUrl: 'https://gw.example.com',
    }
    const env = { [AUTH_TOKEN]: 'tok-1', [BASE_URL]: 'https://gw.example.com' }
    expect(isProfileActive(profile, env, undefined)).toBe(true)
    expect(isProfileActive(profile, { ...env, [AUTH_TOKEN]: 'tok-2' }, undefined)).toBe(false)
    expect(
      isProfileActive(profile, { ...env, [BASE_URL]: 'https://other.example.com' }, undefined),
    ).toBe(false)
  })

  it('requires settings.model to match when the gateway profile pins a model', () => {
    const profile: ClaudeCredentialProfile = {
      id: 'g1',
      label: 'Gateway',
      kind: 'gateway',
      authToken: 'tok-1',
      baseUrl: 'https://gw.example.com',
      model: 'kimi-k3',
    }
    const env = { [AUTH_TOKEN]: 'tok-1', [BASE_URL]: 'https://gw.example.com' }
    expect(isProfileActive(profile, env, 'kimi-k3')).toBe(true)
    expect(isProfileActive(profile, env, 'claude-opus')).toBe(false)
    expect(isProfileActive(profile, env, undefined)).toBe(false)
  })
})
