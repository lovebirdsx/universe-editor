import { describe, expect, it } from 'vitest'
import {
  isConfigValueAllowedOnMobile,
  isHighRiskConfigValue,
  isHighRiskPermissionOption,
  isPermissionOptionAllowedOnMobile,
} from '../index.js'

describe('mobile safety policy', () => {
  it('rejects every durable allow_always permission option', () => {
    expect(isHighRiskPermissionOption({ optionId: 'whatever', kind: 'allow_always' })).toBe(true)
    expect(isHighRiskPermissionOption({ optionId: 'allow-once', kind: 'allow_once' })).toBe(false)
    expect(isHighRiskPermissionOption({ optionId: 'reject', kind: 'reject_once' })).toBe(false)
  })

  it('rejects scoped grants even when their kind is mislabeled', () => {
    for (const optionId of [
      'allow-with-updates',
      'allow-skill-exact',
      'allow-skill-prefix',
      'exit-plan-bypass',
    ]) {
      expect(isHighRiskPermissionOption({ optionId, kind: 'allow_once' })).toBe(true)
    }
  })

  it('rejects bypass-shaped option ids as a backstop', () => {
    expect(isHighRiskPermissionOption({ optionId: 'bypassPermissions' })).toBe(true)
    expect(isHighRiskPermissionOption({ optionId: 'Allow-Bypass' })).toBe(true)
    expect(isPermissionOptionAllowedOnMobile({ optionId: 'allow-once' })).toBe(true)
  })

  it('recognizes bypass / full-access config values', () => {
    for (const value of [
      'bypassPermissions',
      'bypass',
      'agent-full-access',
      'danger-full-access',
      'full_access',
      'dangerously-skip-permissions',
    ]) {
      expect(isHighRiskConfigValue(value)).toBe(true)
    }
    for (const value of [
      'default',
      'acceptEdits',
      'plan',
      'agent',
      'workspace-write',
      true,
      false,
    ]) {
      expect(isHighRiskConfigValue(value)).toBe(false)
    }
  })

  it('projects the policy to the allowedOnMobile booleans', () => {
    expect(isConfigValueAllowedOnMobile('bypassPermissions')).toBe(false)
    expect(isConfigValueAllowedOnMobile('plan')).toBe(true)
    expect(isConfigValueAllowedOnMobile(true)).toBe(true)
  })
})
