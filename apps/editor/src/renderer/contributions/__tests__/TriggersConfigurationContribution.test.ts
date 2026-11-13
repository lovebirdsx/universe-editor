/*---------------------------------------------------------------------------------------------
 *  Shape tests for the triggers.json JSON schema: the input surface mirrors
 *  TriggersConfig (version / maxConcurrentRuns / triggers[]), each source kind is
 *  covered by one of the four `oneOf` branches, and the enums match the runtime
 *  contract (`allowedActions`, `overflow`, `onMissed`).
 *--------------------------------------------------------------------------------------------*/

import type { IJSONSchema } from '@universe-editor/platform'
import { describe, expect, it } from 'vitest'
import { ELEVATED_MODE_IDS, TRIGGER_ACTION_TYPES } from '../../../shared/triggers/types.js'
import { TRIGGERS_SCHEMA } from '../TriggersConfigurationContribution.js'

function triggerSchema(): IJSONSchema {
  const triggers = TRIGGERS_SCHEMA.properties?.['triggers']
  expect(triggers?.type).toBe('array')
  if (triggers?.items === undefined) throw new Error('triggers.items is missing')
  return triggers.items
}

function sourceTypeEnums(): readonly string[] {
  const source = triggerSchema().properties?.['source']
  return (source?.oneOf ?? []).map((branch) => {
    const type = branch.properties?.['type']
    return String(type?.enum?.[0])
  })
}

describe('triggers.json schema', () => {
  it('describes the input shape and not the parser-only `invalid` list', () => {
    expect(TRIGGERS_SCHEMA.type).toBe('object')
    expect(Object.keys(TRIGGERS_SCHEMA.properties ?? {}).sort()).toEqual([
      'maxConcurrentRuns',
      'triggers',
      'version',
    ])
    expect(TRIGGERS_SCHEMA.properties?.['version']?.enum).toEqual([1])
    expect(TRIGGERS_SCHEMA.properties?.['maxConcurrentRuns']?.minimum).toBe(1)
    expect(TRIGGERS_SCHEMA.properties?.['maxConcurrentRuns']?.maximum).toBe(10)
  })

  it('covers all four trigger sources with a type-discriminated oneOf', () => {
    expect(sourceTypeEnums()).toEqual(['manual', 'schedule', 'poll', 'swarm-review'])
    const source = triggerSchema().properties?.['source']
    expect(source?.required).toEqual(['type'])
    for (const branch of source?.oneOf ?? []) {
      expect(branch.additionalProperties).toBe(false)
    }
  })

  it('requires id / workspace / source / session on a trigger', () => {
    expect(triggerSchema().required).toEqual(['id', 'workspace', 'source', 'session'])
    expect(triggerSchema().properties?.['id']?.pattern).toBe('^[a-z0-9][a-z0-9-]{0,63}$')
    expect(triggerSchema().properties?.['enabled']?.default).toBe(false)
  })

  it('mirrors the runtime action enum and overflow values', () => {
    expect(triggerSchema().properties?.['allowedActions']?.items?.enum).toEqual([
      ...TRIGGER_ACTION_TYPES,
    ])
    expect(triggerSchema().properties?.['overflow']?.enum).toEqual(['queue', 'drop'])
    expect(triggerSchema().properties?.['concurrency']?.minimum).toBe(1)
    expect(triggerSchema().properties?.['concurrency']?.maximum).toBe(10)
  })

  it('lets a session set either a prompt or a skill and describes the budget', () => {
    const session = triggerSchema().properties?.['session']
    expect(session?.anyOf).toEqual([{ required: ['prompt'] }, { required: ['skill'] }])
    const budget = session?.properties?.['budget']
    expect(Object.keys(budget?.properties ?? {}).sort()).toEqual([
      'approvalTimeoutMin',
      'maxCostUsd',
      'timeoutMin',
    ])
    for (const field of ['approvalTimeoutMin', 'maxCostUsd', 'timeoutMin'] as const) {
      const schema = budget?.properties?.[field] as
        | (IJSONSchema & { exclusiveMinimum?: number })
        | undefined
      expect(schema?.exclusiveMinimum).toBe(0)
    }
  })

  it('warns that elevated modes need confirmation', () => {
    const mode = triggerSchema().properties?.['session']?.properties?.['mode']
    for (const id of ELEVATED_MODE_IDS) {
      expect(mode?.description).toContain(id)
    }
    expect(mode?.description).toContain('确认高权限模式')
  })

  it('restricts the schedule to one of cron / everyMin with a missed-run policy', () => {
    const schedule = triggerSchema().properties?.['source']?.oneOf?.find(
      (branch) => branch.properties?.['type']?.enum?.[0] === 'schedule',
    )
    expect(schedule?.properties?.['onMissed']?.enum).toEqual(['skip', 'catch-up-once'])
    expect(schedule?.properties?.['onMissed']?.default).toBe('skip')
    expect(schedule?.oneOf).toEqual([{ required: ['cron'] }, { required: ['everyMin'] }])
    expect(Object.keys(schedule?.properties ?? {}).sort()).toEqual([
      'cron',
      'everyMin',
      'onMissed',
      'type',
    ])
  })

  it('requires a command fetch with the runtime timeout default for poll sources', () => {
    const poll = triggerSchema().properties?.['source']?.oneOf?.find(
      (branch) => branch.properties?.['type']?.enum?.[0] === 'poll',
    )
    expect(poll?.required).toEqual(['type', 'intervalSec', 'fetch', 'keyField'])
    expect(poll?.properties?.['intervalSec']?.minimum).toBe(30)
    expect(poll?.properties?.['intervalSec']?.type).toBe('integer')
    expect(poll?.properties?.['fetch']?.required).toEqual(['type', 'command'])
    expect(poll?.properties?.['fetch']?.properties?.['timeoutSec']?.default).toBe(60)
    expect(poll?.properties?.['fetch']?.description).toContain('items')
  })
})
