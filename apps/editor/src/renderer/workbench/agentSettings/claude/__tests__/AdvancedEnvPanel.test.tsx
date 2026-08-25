/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  AdvancedEnvPanel tests — the free env editor hides the auth-owned keys and
 *  CLAUDE_CODE_SUBAGENT_MODEL (owned by the Authentication panel's sub-agent pick),
 *  while legacy keys without a visual owner (e.g. ANTHROPIC_SMALL_FAST_MODEL) stay
 *  hand-editable.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { AdvancedEnvPanel } from '../AdvancedEnvPanel.js'
import type { UseClaudeConfig } from '../useClaudeConfig.js'

afterEach(() => cleanup())

function makeConfig(env: Record<string, string>): UseClaudeConfig {
  return {
    settings: { env },
    loaded: true,
    configPath: '',
    authority: undefined,
    authStatus: { loggedIn: false, expired: false },
    agentSettings: {},
    subagentModelEnv: env['CLAUDE_CODE_SUBAGENT_MODEL'],
    patch: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    reloadAuthStatus: vi.fn(async () => ({ loggedIn: false, expired: false })),
    applyAuthentication: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setModelOneM: vi.fn(async () => {}),
    setSubagentModel: vi.fn(async () => {}),
    setSubagentModelOneM: vi.fn(async () => {}),
  }
}

describe('AdvancedEnvPanel custom env editor', () => {
  it('shows ANTHROPIC_SMALL_FAST_MODEL but hides CLAUDE_CODE_SUBAGENT_MODEL', () => {
    render(
      <AdvancedEnvPanel
        config={makeConfig({
          ANTHROPIC_SMALL_FAST_MODEL: 'sonnet',
          CLAUDE_CODE_SUBAGENT_MODEL: 'opus',
        })}
      />,
    )

    expect(screen.getByDisplayValue('ANTHROPIC_SMALL_FAST_MODEL')).toBeTruthy()
    expect(screen.queryByDisplayValue('CLAUDE_CODE_SUBAGENT_MODEL')).toBeNull()
  })
})
