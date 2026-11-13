import { parse } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'
import {
  isElevatedMode,
  parseTriggersConfig,
  triggerFingerprint,
  TRIGGERS_CONFIG_EXAMPLE,
} from '../configParse.js'
import { TRIGGER_DEFAULTS, type TriggerConfig, type TriggersConfig } from '../types.js'

const rawTrigger = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 't1',
  workspace: 'X:/workspace',
  source: { type: 'manual' },
  session: { prompt: 'go' },
  ...overrides,
})

function parseOk(raw: unknown): TriggersConfig {
  const result = parseTriggersConfig(raw)
  if (!result.ok) throw new Error(result.error)
  return result.config
}

function invalidErrors(trigger: unknown): readonly string[] {
  const config = parseOk({ version: 1, triggers: [trigger] })
  expect(config.triggers).toHaveLength(0)
  expect(config.invalid).toHaveLength(1)
  return config.invalid[0]?.errors ?? []
}

function firstTrigger(raw: unknown): TriggerConfig {
  const config = parseOk({ version: 1, triggers: [raw] })
  const trigger = config.triggers[0]
  if (trigger === undefined) throw new Error(`expected a valid trigger: ${String(raw)}`)
  return trigger
}

describe('parseTriggersConfig (top level)', () => {
  it('requires a JSON object and version 1', () => {
    expect(parseTriggersConfig(null).ok).toBe(false)
    expect(parseTriggersConfig([]).ok).toBe(false)
    expect(parseTriggersConfig({ version: 2, triggers: [] }).ok).toBe(false)
    expect(parseOk({ triggers: [] }).version).toBe(1)
  })

  it('validates maxConcurrentRuns', () => {
    expect(parseTriggersConfig({ maxConcurrentRuns: 0 }).ok).toBe(false)
    expect(parseTriggersConfig({ maxConcurrentRuns: 11 }).ok).toBe(false)
    expect(parseOk({ maxConcurrentRuns: 5 }).maxConcurrentRuns).toBe(5)
    expect(parseOk({}).maxConcurrentRuns).toBe(TRIGGER_DEFAULTS.maxConcurrentRuns)
  })

  it('rejects a non-array triggers field', () => {
    expect(parseTriggersConfig({ triggers: {} }).ok).toBe(false)
  })
})

describe('parseTriggersConfig (defaults)', () => {
  it('fills every default', () => {
    const trigger = firstTrigger(rawTrigger())
    expect(trigger).toMatchObject({
      id: 't1',
      name: 't1',
      enabled: false,
      workspace: 'X:/workspace',
      allowedActions: [],
      concurrency: 1,
      overflow: 'queue',
    })
    expect(trigger.session.prompt).toBe('go')
    expect(trigger.session.budget).toEqual(TRIGGER_DEFAULTS.budget)
  })

  it('ignores unknown fields', () => {
    expect(firstTrigger(rawTrigger({ unknownField: true })).id).toBe('t1')
  })
})

describe('parseTriggersConfig (trigger fields)', () => {
  it('validates id format and uniqueness', () => {
    expect(invalidErrors(rawTrigger({ id: 'Bad' })).length).toBeGreaterThan(0)
    expect(invalidErrors(rawTrigger({ id: '-bad' })).length).toBeGreaterThan(0)
    expect(invalidErrors(rawTrigger({ id: 'a'.repeat(65) })).length).toBeGreaterThan(0)
    const duplicated = parseOk({
      version: 1,
      triggers: [rawTrigger(), rawTrigger()],
    })
    expect(duplicated.triggers).toHaveLength(0)
    expect(duplicated.invalid).toHaveLength(2)
    expect(duplicated.invalid[0]?.errors.join(' ')).toContain('duplicate')
  })

  it('validates name and enabled types', () => {
    expect(invalidErrors(rawTrigger({ name: 1 })).length).toBeGreaterThan(0)
    expect(invalidErrors(rawTrigger({ name: '  ' })).length).toBeGreaterThan(0)
    expect(invalidErrors(rawTrigger({ enabled: 'yes' })).length).toBeGreaterThan(0)
  })

  it('requires an absolute local workspace path', () => {
    for (const workspace of [
      undefined,
      '',
      'relative/path',
      'file:///X:/workspace',
      '\\\\server\\share',
      '//server/share',
    ]) {
      expect(invalidErrors(rawTrigger({ workspace })).length, String(workspace)).toBeGreaterThan(0)
    }
    expect(firstTrigger(rawTrigger({ workspace: '/workspace' })).workspace).toBe('/workspace')
    expect(firstTrigger(rawTrigger({ workspace: 'C:\\work' })).workspace).toBe('C:\\work')
  })

  it('validates concurrency and overflow', () => {
    expect(invalidErrors(rawTrigger({ concurrency: 0 })).length).toBeGreaterThan(0)
    expect(invalidErrors(rawTrigger({ concurrency: 11 })).length).toBeGreaterThan(0)
    expect(invalidErrors(rawTrigger({ concurrency: 1.5 })).length).toBeGreaterThan(0)
    expect(invalidErrors(rawTrigger({ overflow: 'drop-oldest' })).length).toBeGreaterThan(0)
    expect(firstTrigger(rawTrigger({ concurrency: 4, overflow: 'drop' }))).toMatchObject({
      concurrency: 4,
      overflow: 'drop',
    })
  })

  it('validates allowedActions', () => {
    expect(invalidErrors(rawTrigger({ allowedActions: 'swarm.vote' })).length).toBeGreaterThan(0)
    expect(
      invalidErrors(rawTrigger({ allowedActions: ['swarm.vote', 'swarm.delete'] })).length,
    ).toBeGreaterThan(0)
    expect(
      firstTrigger(rawTrigger({ allowedActions: ['swarm.vote', 'swarm.vote'] })).allowedActions,
    ).toEqual(['swarm.vote'])
  })

  it('isolates invalid triggers and labels non-object entries', () => {
    const config = parseOk({
      version: 1,
      triggers: [rawTrigger({ id: 'good' }), rawTrigger({ id: 'bad id' }), 42],
    })
    expect(config.triggers.map((trigger) => trigger.id)).toEqual(['good'])
    expect(config.invalid.map((entry) => entry.id)).toEqual(['bad id', '#2'])
  })
})

describe('parseTriggersConfig (schedule source)', () => {
  it('requires exactly one of cron / everyMin', () => {
    expect(
      invalidErrors(rawTrigger({ source: { type: 'schedule', cron: '0 9 * * *', everyMin: 60 } }))
        .length,
    ).toBeGreaterThan(0)
    expect(invalidErrors(rawTrigger({ source: { type: 'schedule' } })).length).toBeGreaterThan(0)
  })

  it('defaults onMissed to skip and validates it', () => {
    const trigger = firstTrigger(rawTrigger({ source: { type: 'schedule', cron: '0 9 * * 1-5' } }))
    expect(trigger.source).toEqual({
      type: 'schedule',
      cron: '0 9 * * 1-5',
      onMissed: 'skip',
    })
    expect(
      firstTrigger(
        rawTrigger({
          source: { type: 'schedule', everyMin: 15, onMissed: 'catch-up-once' },
        }),
      ).source,
    ).toEqual({ type: 'schedule', everyMin: 15, onMissed: 'catch-up-once' })
    expect(
      invalidErrors(
        rawTrigger({ source: { type: 'schedule', cron: '0 9 * * *', onMissed: 'later' } }),
      ).length,
    ).toBeGreaterThan(0)
  })

  it('rejects invalid cron and everyMin values', () => {
    expect(
      invalidErrors(rawTrigger({ source: { type: 'schedule', cron: '0 25 * * *' } })).length,
    ).toBeGreaterThan(0)
    expect(
      invalidErrors(rawTrigger({ source: { type: 'schedule', everyMin: 0 } })).length,
    ).toBeGreaterThan(0)
    expect(
      invalidErrors(rawTrigger({ source: { type: 'schedule', everyMin: 2.5 } })).length,
    ).toBeGreaterThan(0)
  })

  it('rejects unknown source types', () => {
    expect(invalidErrors(rawTrigger({ source: { type: 'webhook' } })).length).toBeGreaterThan(0)
    expect(invalidErrors(rawTrigger({ source: 'manual' })).length).toBeGreaterThan(0)
  })
})

describe('parseTriggersConfig (poll source)', () => {
  it('accepts a command poll and defaults timeoutSec to 60', () => {
    const trigger = firstTrigger(
      rawTrigger({
        source: {
          type: 'poll',
          intervalSec: 600,
          fetch: { type: 'command', command: 'node fetch.js' },
          keyField: 'id',
        },
      }),
    )
    expect(trigger.source).toEqual({
      type: 'poll',
      intervalSec: 600,
      fetch: { type: 'command', command: 'node fetch.js', timeoutSec: 60 },
      keyField: 'id',
    })
  })

  it('validates every poll field', () => {
    const badSources = [
      { type: 'poll', intervalSec: 29, fetch: { type: 'command', command: 'x' }, keyField: 'id' },
      {
        type: 'poll',
        intervalSec: 30,
        fetch: { type: 'http', command: 'x' },
        keyField: 'id',
      },
      { type: 'poll', intervalSec: 30, fetch: { type: 'command', command: ' ' }, keyField: 'id' },
      {
        type: 'poll',
        intervalSec: 30,
        fetch: { type: 'command', command: 'x', timeoutSec: 601 },
        keyField: 'id',
      },
      { type: 'poll', intervalSec: 30, fetch: { type: 'command', command: 'x' }, keyField: '' },
      { type: 'poll', intervalSec: 30, keyField: 'id' },
    ]
    for (const source of badSources) {
      expect(invalidErrors(rawTrigger({ source })).length, JSON.stringify(source)).toBeGreaterThan(
        0,
      )
    }
  })
})

describe('parseTriggersConfig (session)', () => {
  it('requires skill or prompt', () => {
    expect(invalidErrors(rawTrigger({ session: {} })).join(' ')).toContain('skill')
    expect(invalidErrors(rawTrigger({ session: undefined })).length).toBeGreaterThan(0)
    expect(firstTrigger(rawTrigger({ session: { skill: 'swarm-triage' } })).session.prompt).toBe('')
  })

  it('validates the skill pattern', () => {
    expect(invalidErrors(rawTrigger({ session: { skill: '-bad' } })).length).toBeGreaterThan(0)
    expect(invalidErrors(rawTrigger({ session: { skill: 'has space' } })).length).toBeGreaterThan(0)
    expect(firstTrigger(rawTrigger({ session: { skill: 'team:weekly-1' } })).session.skill).toBe(
      'team:weekly-1',
    )
  })

  it('keeps cwd relative and inside the workspace', () => {
    expect(
      firstTrigger(rawTrigger({ session: { prompt: 'x', cwd: 'sub/project' } })).session.cwd,
    ).toBe('sub/project')
    for (const cwd of ['..', '../x', 'a/../../b', '/abs', 'C:/abs', '\\\\server\\share', '']) {
      expect(
        invalidErrors(rawTrigger({ session: { prompt: 'x', cwd } })).length,
        cwd,
      ).toBeGreaterThan(0)
    }
  })

  it('validates mcpServers and budget', () => {
    expect(
      invalidErrors(rawTrigger({ session: { prompt: 'x', mcpServers: 'swarm' } })),
    ).not.toEqual([])
    expect(
      invalidErrors(rawTrigger({ session: { prompt: 'x', mcpServers: ['swarm', 1] } })).length,
    ).toBeGreaterThan(0)
    expect(
      invalidErrors(rawTrigger({ session: { prompt: 'x', budget: { maxCostUsd: 0 } } })).length,
    ).toBeGreaterThan(0)
    expect(
      invalidErrors(rawTrigger({ session: { prompt: 'x', budget: { timeoutMin: -1 } } })).length,
    ).toBeGreaterThan(0)
    expect(
      firstTrigger(rawTrigger({ session: { prompt: 'x', budget: { maxCostUsd: 2 } } })).session
        .budget,
    ).toEqual({ maxCostUsd: 2, timeoutMin: 30, approvalTimeoutMin: 1440 })
  })

  it('validates agent / mode / model types', () => {
    for (const key of ['agent', 'mode', 'model']) {
      expect(
        invalidErrors(rawTrigger({ session: { prompt: 'x', [key]: 1 } })).length,
        key,
      ).toBeGreaterThan(0)
    }
  })
})

describe('triggerFingerprint', () => {
  it('is stable across field order and changes with config', () => {
    const trigger = firstTrigger(rawTrigger({ enabled: true }))
    const reordered: TriggerConfig = {
      overflow: trigger.overflow,
      session: trigger.session,
      source: trigger.source,
      workspace: trigger.workspace,
      enabled: trigger.enabled,
      name: trigger.name,
      id: trigger.id,
      allowedActions: trigger.allowedActions,
      concurrency: trigger.concurrency,
    }
    expect(triggerFingerprint(reordered)).toBe(triggerFingerprint(trigger))
    expect(triggerFingerprint({ ...trigger, enabled: false })).not.toBe(triggerFingerprint(trigger))
    expect(triggerFingerprint(trigger)).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('isElevatedMode', () => {
  it('recognizes bypass-class mode ids only', () => {
    expect(isElevatedMode('bypassPermissions')).toBe(true)
    expect(isElevatedMode('danger-full-access')).toBe(true)
    expect(isElevatedMode('default')).toBe(false)
    expect(isElevatedMode(undefined)).toBe(false)
  })
})

describe('TRIGGERS_CONFIG_EXAMPLE', () => {
  it('is valid JSONC and parses into three disabled triggers', () => {
    const parsed = parse(TRIGGERS_CONFIG_EXAMPLE, [], { allowTrailingComma: true }) as unknown
    const config = parseOk(parsed)
    expect(config.invalid).toEqual([])
    expect(config.triggers.map((trigger) => trigger.id)).toEqual([
      'swarm-review',
      'weekly-digest',
      'reqs-watch',
    ])
    expect(config.triggers.every((trigger) => !trigger.enabled)).toBe(true)
    expect(config.triggers.map((trigger) => trigger.source.type)).toEqual([
      'swarm-review',
      'schedule',
      'poll',
    ])
  })
})
