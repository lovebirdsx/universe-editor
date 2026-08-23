/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  isClaudeAuthActive: pure comparison between a persisted `authentication`
 *  selection and the env block currently injected into ~/.claude/settings.json.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AiResolvedProvider } from '@universe-editor/platform'
import { AGENT_SUBSCRIPTION_AUTH } from '../../../../../shared/ipc/claudeConfigService.js'
import { isClaudeAuthActive } from '../credentialMatch.js'

const API_KEY = 'ANTHROPIC_API_KEY'
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL = 'ANTHROPIC_BASE_URL'

function provider(partial: Partial<AiResolvedProvider> & { id: string }): AiResolvedProvider {
  return {
    defaultProtocol: 'anthropic-messages',
    protocols: [{ protocol: 'anthropic-messages', models: [], discover: true }],
    ...partial,
  }
}

const OFFICIAL = provider({ id: 'anthropic', apiKey: 'sk-ant-official' })
const GATEWAY = provider({ id: 'gw', apiKey: 'tok-1', baseUrl: 'https://gw.example.com' })
const NO_PROVIDERS: readonly AiResolvedProvider[] = []

describe('isClaudeAuthActive', () => {
  it('treats an unset or @subscription selection as active only with no credential env', () => {
    expect(isClaudeAuthActive(undefined, {}, NO_PROVIDERS)).toBe(true)
    expect(isClaudeAuthActive(AGENT_SUBSCRIPTION_AUTH, {}, NO_PROVIDERS)).toBe(true)
    expect(isClaudeAuthActive(undefined, { [API_KEY]: 'sk-1' }, NO_PROVIDERS)).toBe(false)
    expect(isClaudeAuthActive(AGENT_SUBSCRIPTION_AUTH, { [AUTH_TOKEN]: 'tok' }, NO_PROVIDERS)).toBe(
      false,
    )
  })

  it('matches an official-endpoint provider only when the env key is identical', () => {
    expect(isClaudeAuthActive('anthropic', { [API_KEY]: 'sk-ant-official' }, [OFFICIAL])).toBe(true)
    expect(isClaudeAuthActive('anthropic', { [API_KEY]: 'sk-ant-other' }, [OFFICIAL])).toBe(false)
    expect(isClaudeAuthActive('anthropic', {}, [OFFICIAL])).toBe(false)
  })

  it('does not match an official provider while a token / base URL overrides it', () => {
    const env = { [API_KEY]: 'sk-ant-official', [AUTH_TOKEN]: 'tok' }
    expect(isClaudeAuthActive('anthropic', env, [OFFICIAL])).toBe(false)
  })

  it('matches a gateway provider on the derived token + base URL', () => {
    const env = { [AUTH_TOKEN]: 'tok-1', [BASE_URL]: 'https://gw.example.com' }
    expect(isClaudeAuthActive('gw', env, [GATEWAY])).toBe(true)
    expect(isClaudeAuthActive('gw', { ...env, [AUTH_TOKEN]: 'tok-2' }, [GATEWAY])).toBe(false)
    expect(
      isClaudeAuthActive('gw', { ...env, [BASE_URL]: 'https://other.example.com' }, [GATEWAY]),
    ).toBe(false)
  })

  it('is not active when the provider id cannot be resolved', () => {
    const env = { [AUTH_TOKEN]: 'tok-1', [BASE_URL]: 'https://gw.example.com' }
    expect(isClaudeAuthActive('missing', env, [GATEWAY])).toBe(false)
  })
})
