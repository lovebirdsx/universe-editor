/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/session/planPermissionPolicy.ts
 *  The policy is personal-only: readPlanPermissionPolicy must ignore every layer
 *  below/above User, fall back to `skip` for anything unknown, and the skip
 *  selector must never pick a durable option.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { ConfigurationService, ConfigurationTarget } from '@universe-editor/platform'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import {
  DEFAULT_PLAN_PERMISSION_POLICY,
  PLAN_PERMISSION_POLICY_KEY,
  claudePlanAutoModeOptions,
  isClaudeAgent,
  isPlanPermissionPolicy,
  readPlanPermissionPolicy,
  selectSkipOneShotOption,
} from '../planPermissionPolicy.js'

function request(
  kind: RequestPermissionRequest['toolCall']['kind'] = 'execute',
  options: RequestPermissionRequest['options'] = [
    { optionId: 'allow-with-updates', name: 'Always', kind: 'allow_always' },
    { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
    { optionId: 'reject', name: 'No', kind: 'reject_once' },
  ],
): RequestPermissionRequest {
  return {
    sessionId: 'agent-1',
    toolCall: { toolCallId: 'tc-1', title: 'ls', kind, options: [] as never },
    options,
  } as unknown as RequestPermissionRequest
}

describe('readPlanPermissionPolicy', () => {
  it('defaults to skip when nothing is configured', () => {
    expect(DEFAULT_PLAN_PERMISSION_POLICY).toBe('skip')
    expect(readPlanPermissionPolicy(new ConfigurationService())).toBe('skip')
  })

  it('reads the User layer', () => {
    const config = new ConfigurationService()
    config.update(PLAN_PERMISSION_POLICY_KEY, 'auto', ConfigurationTarget.User)
    expect(readPlanPermissionPolicy(config)).toBe('auto')
  })

  it('ignores Project, VSCodeWorkspace and Memory layers', () => {
    const config = new ConfigurationService()
    for (const target of [
      ConfigurationTarget.Project,
      ConfigurationTarget.VSCodeWorkspace,
      ConfigurationTarget.Memory,
    ]) {
      config.update(PLAN_PERMISSION_POLICY_KEY, 'manual', target)
      expect(readPlanPermissionPolicy(config)).toBe('skip')
    }
  })

  it('keeps the User value when a higher-priority layer disagrees', () => {
    const config = new ConfigurationService()
    config.update(PLAN_PERMISSION_POLICY_KEY, 'manual', ConfigurationTarget.User)
    config.update(PLAN_PERMISSION_POLICY_KEY, 'auto', ConfigurationTarget.Memory)
    expect(readPlanPermissionPolicy(config)).toBe('manual')
  })

  it('falls back to skip for an unknown or malformed value', () => {
    const config = new ConfigurationService()
    config.update(PLAN_PERMISSION_POLICY_KEY, 'yolo', ConfigurationTarget.User)
    expect(readPlanPermissionPolicy(config)).toBe('skip')
    config.update(PLAN_PERMISSION_POLICY_KEY, true, ConfigurationTarget.User)
    expect(readPlanPermissionPolicy(config)).toBe('skip')
  })
})

describe('policy shape helpers', () => {
  it('accepts exactly the three documented values', () => {
    expect(isPlanPermissionPolicy('skip')).toBe(true)
    expect(isPlanPermissionPolicy('auto')).toBe(true)
    expect(isPlanPermissionPolicy('manual')).toBe(true)
    expect(isPlanPermissionPolicy('SKIP')).toBe(false)
    expect(isPlanPermissionPolicy(undefined)).toBe(false)
  })

  it('targets the built-in Claude agent only', () => {
    expect(isClaudeAgent('claude-code')).toBe(true)
    expect(isClaudeAgent('codex')).toBe(false)
    expect(isClaudeAgent('echo')).toBe(false)
  })

  it('maps policy → native classifier flag: only auto turns it on', () => {
    expect(claudePlanAutoModeOptions('auto')).toEqual({
      settings: { useAutoModeDuringPlan: true },
    })
    for (const policy of ['skip', 'manual'] as const) {
      expect(claudePlanAutoModeOptions(policy)).toEqual({
        settings: { useAutoModeDuringPlan: false },
      })
    }
  })
})

describe('selectSkipOneShotOption', () => {
  it('picks the exact allow-once option even when a scoped option is offered', () => {
    expect(selectSkipOneShotOption(request())).toBe('allow-once')
  })

  it('returns undefined when only durable options are offered', () => {
    expect(
      selectSkipOneShotOption(
        request('execute', [
          { optionId: 'allow-with-updates', name: 'Always', kind: 'allow_always' },
          { optionId: 'reject', name: 'No', kind: 'reject_once' },
        ]),
      ),
    ).toBeUndefined()
  })

  it('does not take codex-acp`s underscore id', () => {
    expect(
      selectSkipOneShotOption(
        request('execute', [{ optionId: 'allow_once', name: 'Yes', kind: 'allow_once' }]),
      ),
    ).toBeUndefined()
  })

  it('never picks the plan-review (switch_mode) request', () => {
    expect(selectSkipOneShotOption(request('switch_mode'))).toBeUndefined()
  })

  it('ignores an id/kind mismatch', () => {
    expect(
      selectSkipOneShotOption(
        request('execute', [{ optionId: 'allow-once', name: 'Yes', kind: 'allow_always' }]),
      ),
    ).toBeUndefined()
  })
})
