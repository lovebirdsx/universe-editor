import { describe, expect, it } from 'vitest'
import { parseTriggersConfig } from '../../../../shared/triggers/configParse.js'
import type { TriggerConfig } from '../../../../shared/triggers/types.js'
import { triggerFingerprint } from '../triggerFingerprint.js'

function trigger(overrides: Record<string, unknown> = {}): TriggerConfig {
  const parsed = parseTriggersConfig({
    version: 1,
    triggers: [
      {
        id: 't1',
        name: 'Triage',
        enabled: true,
        source: { type: 'manual' },
        session: { prompt: 'do it' },
        ...overrides,
      },
    ],
  })
  if (!parsed.ok) throw new Error(parsed.error)
  const first = parsed.config.triggers[0]
  if (first === undefined) throw new Error('fixture trigger is invalid')
  return first
}

describe('triggerFingerprint', () => {
  it('is stable across field order and changes with config', () => {
    const base = trigger()
    const reordered: TriggerConfig = {
      overflow: base.overflow,
      session: base.session,
      source: base.source,
      enabled: base.enabled,
      showSession: base.showSession,
      name: base.name,
      id: base.id,
      allowedActions: base.allowedActions,
      concurrency: base.concurrency,
    }
    expect(triggerFingerprint(reordered)).toBe(triggerFingerprint(base))
    expect(triggerFingerprint({ ...base, enabled: false })).not.toBe(triggerFingerprint(base))
    expect(triggerFingerprint({ ...base, showSession: true })).not.toBe(triggerFingerprint(base))
    expect(triggerFingerprint({ ...base, name: 'Renamed' })).not.toBe(triggerFingerprint(base))
  })

  it('produces a full SHA-256 digest', () => {
    expect(triggerFingerprint(trigger())).toMatch(/^[0-9a-f]{64}$/)
  })
})
