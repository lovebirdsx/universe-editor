/*---------------------------------------------------------------------------------------------
 *  Tests for the trigger QuickPick builders: status / source wording, run counts,
 *  last / next run lines, the high-privilege warning marker, error rows and the
 *  per-trigger action menu.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type {
  TriggerSourceType,
  TriggerStatus,
  TriggerSummary,
} from '../../../shared/triggers/types.js'
import {
  buildTriggerActionItems,
  buildTriggerPickItems,
  triggerSourceLabel,
  triggerStatusLabel,
  triggersForAction,
} from '../triggerPickItems.js'

function summary(overrides: Partial<TriggerSummary> = {}): TriggerSummary {
  const id = overrides.id ?? 'triage'
  return {
    key: `X:/workspace\u0000${id}`,
    id,
    name: 'Triage',
    fingerprint: 'fp-triage',
    workspace: 'X:/workspace',
    workspaceName: 'workspace',
    activationConfirmed: true,
    sourceType: 'event',
    source: { type: 'event', event: 'swarm.reviewNeedsAction' },
    status: 'idle',
    enabled: true,
    paused: false,
    pausedAll: false,
    autoPaused: false,
    elevatedMode: false,
    running: 0,
    queued: 0,
    consecutiveFailures: 0,
    ...overrides,
  }
}

describe('triggerStatusLabel', () => {
  it('labels every status', () => {
    const statuses: TriggerStatus[] = [
      'disabled',
      'idle',
      'running',
      'paused',
      'invalid',
      'needs-confirmation',
    ]
    expect(statuses.map(triggerStatusLabel)).toEqual([
      'Disabled',
      'Idle',
      'Running',
      'Paused',
      'Invalid',
      'Needs confirmation',
    ])
  })
})

describe('triggerSourceLabel', () => {
  it('labels every source type', () => {
    const sources: (TriggerSourceType | 'unknown')[] = ['manual', 'schedule', 'poll', 'unknown']
    expect(sources.map(triggerSourceLabel)).toEqual([
      'Manual',
      'Schedule',
      'Command poll',
      'Unknown source',
    ])
    expect(triggerSourceLabel('event')).toBeTruthy()
  })
})

describe('buildTriggerPickItems', () => {
  it('shows the workspace path, status, source and run counts in the description', () => {
    const [item] = buildTriggerPickItems([summary({ status: 'running', running: 2, queued: 3 })])
    expect(item?.label).toBe('Triage')
    expect(item?.description?.startsWith('X:/workspace · Running · ')).toBe(true)
    expect(item?.description).toContain('2 running · 3 queued')
  })

  it('omits zero counts and absent timestamps', () => {
    const [item] = buildTriggerPickItems([summary()])
    expect(item?.description?.startsWith('X:/workspace · Idle · ')).toBe(true)
    expect(item?.detail).toBeUndefined()
  })

  it('marks an offline remote workspace in the description and detail', () => {
    const [item] = buildTriggerPickItems([
      summary({
        offline: true,
        workspace: 'remote-ssh://dev/home/testuser/proj',
        workspaceName: 'proj',
      }),
    ])
    expect(item?.description).toContain('Remote host not connected')
    expect(item?.detail).toContain('The remote host is disconnected')
  })

  it('renders the last run relatively and the next run as clock time', () => {
    const now = Date.now()
    const next = new Date(2026, 0, 1, 9, 5).getTime()
    const [item] = buildTriggerPickItems([
      summary({ lastRunAt: now - 2 * 60_000, nextRunAt: next }),
    ])
    expect(item?.description).toContain('Last run 2m ago')
    expect(item?.description).toMatch(/Next run at \d{2}:\d{2}/)
  })

  it('marks high-privilege mode with the warning glyph', () => {
    const [item] = buildTriggerPickItems([summary({ elevatedMode: true })])
    expect(item?.label).toBe('⚠ Triage')
    expect(item?.detail).toBeUndefined()
  })

  it('explains that a workspace trigger awaits its activation confirmation', () => {
    const [item] = buildTriggerPickItems([summary({ activationConfirmed: false })])
    expect(item?.detail).toContain('Awaiting confirmation')
    expect(item?.detail).toContain('will not run until you confirm it on this machine')
  })

  it('surfaces the last error and validation errors', () => {
    const [item] = buildTriggerPickItems([
      summary({ lastError: 'fetch failed', errors: ['bad cron', 'missing workspace'] }),
    ])
    expect(item?.detail).toBe('Error: fetch failed · bad cron · missing workspace')
  })

  it('carries the composite workspace + id key on every item', () => {
    const items = buildTriggerPickItems([summary(), summary({ id: 'weekly', name: 'Weekly' })])
    expect(items.map((item) => item.triggerKey)).toEqual([
      'X:/workspace\u0000triage',
      'X:/workspace\u0000weekly',
    ])
    expect(items.map((item) => item.description?.startsWith('X:/workspace · '))).toEqual([
      true,
      true,
    ])
  })
})

describe('buildTriggerActionItems', () => {
  const actions = (overrides: Partial<TriggerSummary>): readonly string[] =>
    buildTriggerActionItems(summary(overrides)).map((item) => item.action)

  it('offers manager / run / pause / config / log for a plain trigger', () => {
    expect(actions({})).toEqual(['openManager', 'runNow', 'pause', 'openConfig', 'showLog'])
  })

  it('offers resume for a paused trigger', () => {
    expect(actions({ paused: true })).toContain('resume')
    expect(actions({ paused: true })).not.toContain('pause')
  })

  it('offers the single workspace activation confirmation only while unconfirmed', () => {
    expect(actions({ activationConfirmed: false })).toContain('confirmActivation')
    expect(actions({})).not.toContain('confirmActivation')
  })

  it('does not offer to run an invalid trigger', () => {
    expect(actions({ status: 'invalid' })).not.toContain('runNow')
    expect(actions({ status: 'invalid' })).toContain('openConfig')
    expect(actions({ status: 'invalid', activationConfirmed: false })).not.toContain(
      'confirmActivation',
    )
  })
})

describe('triggersForAction', () => {
  const all = [
    summary({ id: 'a' }),
    summary({ id: 'b', paused: true }),
    summary({ id: 'c', elevatedMode: true }),
    summary({ id: 'f', activationConfirmed: false }),
    summary({ id: 'g', status: 'invalid', activationConfirmed: false }),
  ]

  it('filters pause candidates to unpaused triggers', () => {
    expect(triggersForAction('pause', all).map((s) => s.id)).toEqual(['a', 'c', 'f', 'g'])
  })

  it('filters resume candidates to paused triggers', () => {
    expect(triggersForAction('resume', all).map((s) => s.id)).toEqual(['b'])
  })

  it('filters confirmation candidates to unconfirmed valid triggers', () => {
    expect(triggersForAction('confirmActivation', all).map((s) => s.id)).toEqual(['f'])
  })
})
