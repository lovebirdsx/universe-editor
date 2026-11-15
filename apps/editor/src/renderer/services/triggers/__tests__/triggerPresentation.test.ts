/*---------------------------------------------------------------------------------------------
 *  Tests for the pure trigger presentation helpers: confirmation gate, workspace
 *  grouping, source wording, badge priority and the status-bar count summary.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  formatTriggerDuration,
  groupTriggersByWorkspace,
  relativeTimeUntil,
  sortTriggersForDisplay,
  summarizeTriggerCounts,
  summarizeTriggerSource,
  triggerCanRun,
  triggerDisplayRank,
  triggerMatchesListFilter,
  triggerMatchesSearch,
  triggerNeedsConfirmation,
  triggerSourceFacts,
  triggerStatusBadge,
} from '../triggerPresentation.js'
import type { TriggerSummary } from '../../../../shared/triggers/types.js'

function summary(overrides: Partial<TriggerSummary> = {}): TriggerSummary {
  const id = overrides.id ?? 'triage'
  return {
    key: `X:/workspace\u0000${id}`,
    id,
    name: 'Triage',
    fingerprint: 'fp-triage',
    workspace: 'X:/workspace',
    workspaceName: 'workspace',
    sourceType: 'event',
    status: 'idle',
    enabled: true,
    paused: false,
    pausedAll: false,
    autoPaused: false,
    activationConfirmed: true,
    elevatedMode: false,
    running: 0,
    queued: 0,
    consecutiveFailures: 0,
    ...overrides,
  }
}

describe('triggerNeedsConfirmation', () => {
  it('is false for a fully confirmed trigger', () => {
    expect(triggerNeedsConfirmation(summary())).toBe(false)
  })

  it('is true while the workspace activation is unconfirmed', () => {
    expect(triggerNeedsConfirmation(summary({ activationConfirmed: false }))).toBe(true)
  })

  it('is covered by the activation confirmation even for a bypass-class mode', () => {
    expect(
      triggerNeedsConfirmation(summary({ activationConfirmed: true, elevatedMode: true })),
    ).toBe(false)
    expect(
      triggerNeedsConfirmation(summary({ activationConfirmed: false, elevatedMode: true })),
    ).toBe(true)
  })

  it('never flags an invalid entry, which cannot be confirmed from the list', () => {
    expect(
      triggerNeedsConfirmation(summary({ status: 'invalid', activationConfirmed: false })),
    ).toBe(false)
  })
})

describe('groupTriggersByWorkspace', () => {
  it('groups in first-seen order and keeps each workspace name', () => {
    const groups = groupTriggersByWorkspace([
      summary({ id: 'a', workspace: 'ws-1', workspaceName: 'alpha' }),
      summary({ id: 'b', workspace: 'ws-2', workspaceName: 'beta' }),
      summary({ id: 'c', workspace: 'ws-1', workspaceName: 'alpha' }),
    ])
    expect(groups.map((group) => group.workspace)).toEqual(['ws-1', 'ws-2'])
    expect(groups.map((group) => group.workspaceName)).toEqual(['alpha', 'beta'])
    expect(groups[0]?.triggers.map((entry) => entry.id)).toEqual(['a', 'c'])
    expect(groups[1]?.triggers.map((entry) => entry.id)).toEqual(['b'])
  })
})

describe('sortTriggersForDisplay', () => {
  it('orders attention, active, idle, then paused/disabled, keeping ties stable', () => {
    const paused = summary({ id: 'paused', paused: true, status: 'paused' })
    const idle = summary({ id: 'idle' })
    const running = summary({ id: 'running', running: 1, status: 'running' })
    const attention = summary({ id: 'attention', activationConfirmed: false })
    const disabled = summary({ id: 'disabled', enabled: false, status: 'disabled' })
    const queued = summary({ id: 'queued', queued: 1 })

    const ordered = sortTriggersForDisplay([paused, idle, running, attention, disabled, queued])

    expect(ordered.map((entry) => entry.id)).toEqual([
      'attention',
      'running',
      'queued',
      'idle',
      'paused',
      'disabled',
    ])
  })

  it('ranks each badge bucket and ignores the incoming order within a bucket', () => {
    expect(triggerDisplayRank(summary({ activationConfirmed: false }))).toBe(0)
    expect(triggerDisplayRank(summary({ running: 1 }))).toBe(1)
    expect(triggerDisplayRank(summary())).toBe(2)
    expect(triggerDisplayRank(summary({ paused: true, status: 'paused' }))).toBe(3)
  })

  it('moves a group whose best trigger needs attention above earlier groups', () => {
    const groups = groupTriggersByWorkspace(
      sortTriggersForDisplay([
        summary({ id: 'a-paused', workspace: 'a', paused: true, status: 'paused' }),
        summary({ id: 'b-attention', workspace: 'b', activationConfirmed: false }),
        summary({ id: 'a-idle', workspace: 'a' }),
      ]),
    )

    expect(groups.map((group) => group.workspace)).toEqual(['b', 'a'])
    expect(groups[1]?.triggers.map((entry) => entry.id)).toEqual(['a-idle', 'a-paused'])
  })
})

describe('triggerMatchesListFilter', () => {
  it('separates all, active, attention and paused', () => {
    expect(triggerMatchesListFilter(summary(), 'all')).toBe(true)
    expect(triggerMatchesListFilter(summary(), 'active')).toBe(true)
    expect(triggerMatchesListFilter(summary(), 'attention')).toBe(false)
    expect(triggerMatchesListFilter(summary(), 'paused')).toBe(false)

    expect(triggerMatchesListFilter(summary({ activationConfirmed: false }), 'attention')).toBe(
      true,
    )
    expect(triggerMatchesListFilter(summary({ activationConfirmed: false }), 'active')).toBe(false)
    expect(triggerMatchesListFilter(summary({ running: 1, status: 'running' }), 'active')).toBe(
      true,
    )
    expect(triggerMatchesListFilter(summary({ queued: 1 }), 'active')).toBe(true)
    expect(triggerMatchesListFilter(summary({ paused: true, status: 'paused' }), 'paused')).toBe(
      true,
    )
  })

  it('lets an auto-paused trigger match both attention and paused', () => {
    const autoPaused = summary({ autoPaused: true, paused: true, status: 'paused' })
    expect(triggerMatchesListFilter(autoPaused, 'attention')).toBe(true)
    expect(triggerMatchesListFilter(autoPaused, 'paused')).toBe(true)
  })

  it('does not treat a disabled but unpaused trigger as active or paused', () => {
    const disabled = summary({ enabled: false, status: 'disabled' })
    expect(triggerMatchesListFilter(disabled, 'active')).toBe(false)
    expect(triggerMatchesListFilter(disabled, 'paused')).toBe(false)
  })
})

describe('triggerMatchesSearch', () => {
  const item = summary({
    name: 'Triage',
    id: 'triage-id',
    workspaceName: 'acme 4.0',
    source: {
      type: 'poll',
      intervalSec: 300,
      fetch: { type: 'command', command: 'gh pr list', timeoutSec: 10 },
      keyField: 'id',
    },
    lastRunSummary: 'Merged the fix',
    lastError: 'network down',
  })

  it('searches name, id, workspace, source wording, summary and error', () => {
    expect(triggerMatchesSearch(item, 'triage')).toBe(true)
    expect(triggerMatchesSearch(item, 'acme')).toBe(true)
    expect(triggerMatchesSearch(item, 'every 300s')).toBe(true)
    expect(triggerMatchesSearch(item, 'MERGED')).toBe(true)
    expect(triggerMatchesSearch(item, 'network')).toBe(true)
    expect(triggerMatchesSearch(item, 'triage merged')).toBe(true)
    expect(triggerMatchesSearch(item, 'triage missing')).toBe(false)
    expect(triggerMatchesSearch(item, '   ')).toBe(true)
  })

  it('tolerates an absent source and absent run text', () => {
    const invalid = summary({ status: 'invalid' })
    expect(triggerMatchesSearch(invalid, 'unknown source')).toBe(true)
  })
})

describe('triggerCanRun', () => {
  it('allows a paused trigger but blocks invalid, unconfirmed, paused-all and offline', () => {
    expect(triggerCanRun(summary())).toBe(true)
    expect(triggerCanRun(summary({ paused: true, status: 'paused' }))).toBe(true)
    expect(triggerCanRun(summary({ status: 'invalid' }))).toBe(false)
    expect(triggerCanRun(summary({ activationConfirmed: false }))).toBe(false)
    expect(triggerCanRun(summary({ pausedAll: true }))).toBe(false)
    expect(triggerCanRun(summary({ offline: true }))).toBe(false)
  })
})

describe('summarizeTriggerSource', () => {
  it('describes every source shape', () => {
    expect(summarizeTriggerSource({ type: 'manual' })).toBe('Manual')
    expect(summarizeTriggerSource({ type: 'event', event: 'swarm.reviewNeedsAction' })).toBe(
      'Swarm review that needs action',
    )
    expect(summarizeTriggerSource({ type: 'schedule', cron: '0 9 * * *', onMissed: 'skip' })).toBe(
      'Cron 0 9 * * *',
    )
    expect(
      summarizeTriggerSource({ type: 'schedule', everyMin: 15, onMissed: 'catch-up-once' }),
    ).toBe('Every 15 min')
    expect(
      summarizeTriggerSource({
        type: 'poll',
        intervalSec: 30,
        fetch: { type: 'command', command: 'gh pr list', timeoutSec: 10 },
        keyField: 'id',
      }),
    ).toBe('Every 30s')
    expect(summarizeTriggerSource(undefined)).toBe('Unknown source')
  })
})

describe('triggerSourceFacts', () => {
  it('lists cron and missed-run policy for a schedule', () => {
    const facts = triggerSourceFacts({
      type: 'schedule',
      cron: '0 9 * * *',
      onMissed: 'catch-up-once',
    })
    expect(facts).toEqual([
      { label: 'Cron', value: '0 9 * * *' },
      { label: 'On missed runs', value: 'catch up once' },
    ])
  })

  it('lists poll details and nothing for manual sources', () => {
    expect(triggerSourceFacts({ type: 'manual' })).toEqual([])
    expect(triggerSourceFacts({ type: 'event', event: 'swarm.reviewNeedsAction' })).toEqual([
      { label: 'Event', value: 'swarm.reviewNeedsAction' },
    ])
    expect(
      triggerSourceFacts({
        type: 'poll',
        intervalSec: 30,
        fetch: { type: 'command', command: 'gh pr list', timeoutSec: 10 },
        keyField: 'id',
      }),
    ).toEqual([
      { label: 'Poll interval', value: '30s' },
      { label: 'Command', value: 'gh pr list' },
      { label: 'Command timeout', value: '10s' },
      { label: 'Event key field', value: 'id' },
    ])
  })
})

describe('triggerStatusBadge', () => {
  it('prioritises the conditions that block a run', () => {
    expect(triggerStatusBadge(summary({ status: 'invalid', offline: true })).kind).toBe('invalid')
    expect(triggerStatusBadge(summary({ offline: true, autoPaused: true })).kind).toBe('offline')
    expect(triggerStatusBadge(summary({ activationConfirmed: false })).kind).toBe(
      'needs-confirmation',
    )
    expect(triggerStatusBadge(summary({ autoPaused: true, running: 1 })).kind).toBe('auto-paused')
    expect(triggerStatusBadge(summary({ running: 2 })).kind).toBe('running')
    expect(triggerStatusBadge(summary({ queued: 1 })).kind).toBe('queued')
    expect(triggerStatusBadge(summary({ lastError: 'failed' })).kind).toBe('error')
    expect(triggerStatusBadge(summary({ paused: true })).kind).toBe('paused')
    expect(triggerStatusBadge(summary({ enabled: false, status: 'disabled' })).kind).toBe(
      'disabled',
    )
    expect(triggerStatusBadge(summary()).kind).toBe('idle')
  })

  it('marks only states the user has to act on as attention', () => {
    expect(triggerStatusBadge(summary({ activationConfirmed: false })).attention).toBe(true)
    expect(triggerStatusBadge(summary({ offline: true })).attention).toBe(true)
    expect(triggerStatusBadge(summary({ autoPaused: true })).attention).toBe(true)
    expect(triggerStatusBadge(summary({ running: 1 })).attention).toBe(false)
    expect(triggerStatusBadge(summary({ paused: true })).attention).toBe(false)
  })
})

describe('summarizeTriggerCounts', () => {
  const now = 1_000_000

  it('says there is nothing yet when the list is empty', () => {
    const counts = summarizeTriggerCounts([], now)
    expect(counts).toMatchObject({ total: 0, needsAttention: 0 })
    expect(counts.tooltip).toContain('No triggers')
    expect(counts.tooltip).toContain('Click to open the trigger manager')
  })

  it('counts runs and lists the attention categories in the tooltip', () => {
    const counts = summarizeTriggerCounts(
      [
        summary({ running: 1 }),
        summary({ id: 'b', activationConfirmed: false }),
        summary({ id: 'c', running: 1 }),
      ],
      now,
    )
    expect(counts.total).toBe(3)
    expect(counts.running).toBe(2)
    expect(counts.needsConfirmation).toBe(1)
    expect(counts.needsAttention).toBe(1)
    expect(counts.tooltip).toContain('Triggers: 3 total · 2 running · 1 needs confirmation')
    expect(counts.tooltip).toContain('Click to open the trigger manager.')
  })

  it('counts a trigger with several problems once in needsAttention', () => {
    const counts = summarizeTriggerCounts(
      [
        summary({ autoPaused: true, activationConfirmed: false }),
        summary({ id: 'b', offline: true }),
        summary({ id: 'c', lastError: 'boom' }),
        summary({ id: 'd', status: 'invalid', lastError: 'ignored' }),
      ],
      now,
    )
    expect(counts.autoPaused).toBe(1)
    expect(counts.offline).toBe(1)
    expect(counts.errors).toBe(1)
    expect(counts.needsAttention).toBe(3)
    expect(counts.tooltip).toContain('1 needs confirmation')
    expect(counts.tooltip).toContain('1 auto-paused · 1 offline · 1 error')
  })

  it('reports the earliest upcoming run as a relative time', () => {
    const counts = summarizeTriggerCounts(
      [
        summary({ nextRunAt: now + 10 * 60_000 }),
        summary({ id: 'b', nextRunAt: now + 5 * 60_000 }),
      ],
      now,
    )
    expect(counts.nextRunAt).toBe(now + 5 * 60_000)
    expect(counts.tooltip).toContain('Next run in 5m')
  })
})

describe('relativeTimeUntil', () => {
  const now = 1_000_000

  it('formats upcoming instants', () => {
    expect(relativeTimeUntil(now - 1, now)).toBe('due now')
    expect(relativeTimeUntil(now + 1_000, now)).toBe('in <1m')
    expect(relativeTimeUntil(now + 5 * 60_000, now)).toBe('in 5m')
    expect(relativeTimeUntil(now + 2 * 3_600_000, now)).toBe('in 2h')
    expect(relativeTimeUntil(now + 3 * 86_400_000, now)).toBe('in 3d')
  })
})

describe('formatTriggerDuration', () => {
  it('formats seconds and minutes', () => {
    expect(formatTriggerDuration(5_000)).toBe('5s')
    expect(formatTriggerDuration(65_000)).toBe('1m 5s')
  })
})
