/*---------------------------------------------------------------------------------------------
 *  Tests for the trigger-source descriptor registry, the shared draft helpers and
 *  the skill-template table: every source type must round-trip through
 *  draft → raw config → parsed config, and every template must be createable.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { parseTriggersConfig } from '../../../../shared/triggers/configParse.js'
import type { TriggerConfig, TriggerSourceConfig } from '../../../../shared/triggers/types.js'
import {
  draftFromConfig,
  emptyDraft,
  validateTriggerDraft,
  withSourcePatch,
  withSourceType,
} from '../triggerConfigDraft.js'
import {
  TRIGGER_SOURCE_DESCRIPTORS,
  TRIGGER_SOURCE_ORDER,
  triggerSourceDescriptor,
  triggerSourceDescriptorFor,
} from '../triggerSources/index.js'
import { TRIGGER_SKILL_TEMPLATES } from '../triggerTemplates.js'

function parsedTrigger(source: unknown): TriggerConfig | undefined {
  const parsed = parseTriggersConfig({
    version: 1,
    triggers: [{ id: 'sample', name: 'Sample', source, session: { prompt: 'Do it' } }],
  })
  return parsed.ok ? parsed.config.triggers[0] : undefined
}

describe('trigger source descriptors', () => {
  it('registers exactly one descriptor per source type', () => {
    expect(TRIGGER_SOURCE_ORDER).toEqual(['manual', 'schedule', 'poll', 'event'])
    expect(Object.keys(TRIGGER_SOURCE_DESCRIPTORS)).toEqual([...TRIGGER_SOURCE_ORDER])
    for (const type of TRIGGER_SOURCE_ORDER) {
      expect(triggerSourceDescriptor(type).type).toBe(type)
      expect(triggerSourceDescriptor(type).label).not.toHaveLength(0)
    }
  })

  it('round-trips every source draft through the parser', () => {
    const drafts = [
      triggerSourceDescriptor('manual').empty(),
      triggerSourceDescriptor('schedule').empty(),
      { ...triggerSourceDescriptor('poll').empty(), command: 'node scripts/fetch.js' },
      triggerSourceDescriptor('event').empty(),
    ]
    for (const draft of drafts) {
      const descriptor = triggerSourceDescriptor(draft.type)
      const config = parsedTrigger(descriptor.build(draft))
      expect(config, `${draft.type} must produce a valid source`).toBeDefined()
      if (config === undefined) continue
      expect(config.source.type).toBe(draft.type)
      expect(descriptor.fromConfig(config.source)).toEqual(draft)
    }
  })

  it('builds the raw JSON shape each parser expects', () => {
    expect(
      triggerSourceDescriptor('schedule').build({
        type: 'schedule',
        cron: '0 9 * * 1',
        everyMin: '',
        onMissed: 'catch-up-once',
      }),
    ).toMatchObject({ type: 'schedule', cron: '0 9 * * 1', onMissed: 'catch-up-once' })
    expect(
      triggerSourceDescriptor('poll').build({
        type: 'poll',
        intervalSec: '300',
        command: 'node fetch.js',
        pollTimeoutSec: '60',
        keyField: 'id',
      }),
    ).toMatchObject({
      type: 'poll',
      intervalSec: 300,
      fetch: { type: 'command', command: 'node fetch.js', timeoutSec: 60 },
      keyField: 'id',
    })
    expect(
      triggerSourceDescriptor('event').build({
        type: 'event',
        eventName: 'swarm.reviewNeedsAction',
      }),
    ).toEqual({ type: 'event', event: 'swarm.reviewNeedsAction' })
  })

  it('falls back to the descriptor for a parsed source and tolerates unknown drafts', () => {
    const source: TriggerSourceConfig = { type: 'manual' }
    expect(triggerSourceDescriptorFor(source)).toBe(TRIGGER_SOURCE_DESCRIPTORS.manual)
    expect(TRIGGER_SOURCE_DESCRIPTORS.schedule.fromConfig(source)).toEqual({
      type: 'schedule',
      cron: '',
      everyMin: '',
      onMissed: 'skip',
    })
  })
})

describe('trigger config draft helpers', () => {
  it('resets source parameters when the type changes', () => {
    const draft = {
      ...emptyDraft(),
      source: {
        type: 'schedule' as const,
        cron: '0 9 * * 1',
        everyMin: '',
        onMissed: 'skip' as const,
      },
    }
    const next = withSourceType(draft, 'poll')
    expect(next.source).toEqual(triggerSourceDescriptor('poll').empty())
    expect(draft.source.type).toBe('schedule')
  })

  it('merges source patches without letting them change the discriminant', () => {
    const draft = withSourceType(emptyDraft(), 'schedule')
    const patched = withSourcePatch(draft, { type: 'poll', cron: '0 10 * * *' })
    expect(patched.source).toEqual({
      type: 'schedule',
      cron: '0 10 * * *',
      everyMin: '',
      onMissed: 'skip',
    })
  })

  it('reports parser issues for an incomplete poll source', () => {
    const draft = withSourceType(emptyDraft(), 'poll')
    const result = validateTriggerDraft('sample', { ...draft, name: 'Sample', prompt: 'x' })
    expect(result.config).toBeUndefined()
    expect(result.issues.some((issue) => issue.path.join('.') === 'source.fetch.command')).toBe(
      true,
    )
  })

  it('keeps source and session values when drafting from a parsed config', () => {
    const config = parsedTrigger({
      type: 'poll',
      intervalSec: 300,
      fetch: { type: 'command', command: 'node fetch.js', timeoutSec: 60 },
      keyField: 'id',
    })
    expect(config).toBeDefined()
    if (config === undefined) return
    const draft = draftFromConfig({
      ...config,
      session: { ...config.session, skill: 'triage' },
    })
    expect(draft.source).toEqual({
      type: 'poll',
      intervalSec: '300',
      command: 'node fetch.js',
      pollTimeoutSec: '60',
      keyField: 'id',
    })
    expect(draft.skill).toBe('triage')
  })
})

describe('skill templates', () => {
  it('keeps ids and doc ids unique and inside the template directory', () => {
    const ids = TRIGGER_SKILL_TEMPLATES.map((template) => template.id)
    const docs = TRIGGER_SKILL_TEMPLATES.map((template) => template.docId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(docs).size).toBe(docs.length)
    for (const docId of docs) {
      expect(docId).toMatch(/^ai-agent\/trigger-templates\/[a-z0-9-]+\/SKILL$/)
    }
  })

  it('prefills a definition that passes the same validation as the wizard', () => {
    for (const template of TRIGGER_SKILL_TEMPLATES) {
      const draft = {
        ...emptyDraft(),
        name: template.label,
        source: template.source,
        skill: template.skill,
        prompt: template.prompt,
        maxCostUsd: template.maxCostUsd,
        timeoutMin: template.timeoutMin,
        approvalTimeoutMin: template.approvalTimeoutMin,
        ...(template.mode !== undefined ? { mode: template.mode } : {}),
      }
      const result = validateTriggerDraft(template.id, draft)
      expect(result.config, `${template.id} must be createable`).toBeDefined()
      if (result.config !== undefined) {
        expect(result.config.source.type).toBe(template.source.type)
        expect(result.config.session.skill).toBe(template.skill)
      }
    }
  })
})
