/*---------------------------------------------------------------------------------------------
 *  Tests for TriggerManagerStatusContribution: the entry is always present, the
 *  icon/number track what needs the user, running shows a single spinning icon,
 *  the tooltip carries the breakdown, and dispose releases the entry.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { Emitter, StatusBarAlignment } from '@universe-editor/platform'
import { ITriggerMainService } from '../../../shared/ipc/triggerService.js'
import type { TriggerSummary } from '../../../shared/triggers/types.js'
import { OpenTriggerManagerAction } from '../../actions/triggerActions.js'
import { StatusBarService } from '../../services/statusbar/StatusBarService.js'
import { TriggerManagerStatusContribution } from '../TriggerManagerStatusContribution.js'

function summary(overrides: Partial<TriggerSummary> = {}): TriggerSummary {
  const id = overrides.id ?? 'triage'
  return {
    key: id,
    id,
    fingerprint: 'fp-triage',
    name: 'Triage',
    workspace: 'X:/workspace',
    workspaceName: 'workspace',
    sourceType: 'event',
    source: { type: 'event', event: 'swarm.reviewNeedsAction' },
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

async function makeContribution(summaries: readonly TriggerSummary[] | Error) {
  const emitter = new Emitter<readonly TriggerSummary[]>()
  const triggers = {
    _serviceBrand: undefined,
    listTriggers: async () => {
      if (summaries instanceof Error) throw summaries
      return summaries
    },
    onDidChangeTriggers: emitter.event,
  } as unknown as ITriggerMainService
  const statusBar = new StatusBarService()
  const contribution = new TriggerManagerStatusContribution(statusBar, triggers)
  await Promise.resolve()
  await Promise.resolve()
  return { emitter, statusBar, contribution }
}

describe('TriggerManagerStatusContribution', () => {
  it('is always mounted, even with no triggers at all', async () => {
    const { statusBar, contribution } = await makeContribution([])
    const entries = statusBar.entries.get()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.entry.text).toBe('$(zap)')
    expect(entries[0]?.entry.tooltip).toContain('No triggers')
    expect(entries[0]?.entry.command).toBe(OpenTriggerManagerAction.ID)
    expect(entries[0]?.entry.alignment).toBe(StatusBarAlignment.Right)
    contribution.dispose()
  })

  it('stays mounted as a plain launcher when listing fails', async () => {
    const { statusBar, contribution } = await makeContribution(new Error('offline'))
    const entries = statusBar.entries.get()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.entry.text).toBe('$(zap)')
    expect(entries[0]?.entry.tooltip).toContain('Click to open the trigger manager')
    contribution.dispose()
  })

  it('shows the distinct attention count with the prominent tone', async () => {
    const { statusBar, contribution } = await makeContribution([
      summary({ activationConfirmed: false, autoPaused: true }),
      summary({ id: 'b', offline: true }),
      summary({ id: 'c', running: 1 }),
    ])
    const entry = statusBar.entries.get()[0]?.entry
    expect(entry?.text).toBe('$(zap) 2')
    expect(entry?.kind).toBe('prominent')
    expect(entry?.showProgress).toBeUndefined()
    expect(entry?.tooltip).toContain('Triggers: 3 total')
    expect(entry?.tooltip).toContain('1 running · 1 needs confirmation · 1 auto-paused')
    expect(entry?.tooltip).toContain('Click to open the trigger manager')
    contribution.dispose()
  })

  it('shows a single spinning icon and the active run count when nothing needs the user', async () => {
    const { statusBar, contribution } = await makeContribution([
      summary({ running: 2 }),
      summary({ id: 'b' }),
    ])
    const entry = statusBar.entries.get()[0]?.entry
    expect(entry?.text).toBe('$(sync~spin) 2')
    expect(entry?.kind).toBeUndefined()
    // The spinning glyph lives in the text; `showProgress` would add a second icon.
    expect(entry?.showProgress).toBeUndefined()
    contribution.dispose()
  })

  it('updates in place when the trigger list changes', async () => {
    const { emitter, statusBar, contribution } = await makeContribution([summary()])
    expect(statusBar.entries.get()).toHaveLength(1)
    expect(statusBar.entries.get()[0]?.entry.text).toBe('$(zap)')

    emitter.fire([summary({ id: 'b', autoPaused: true })])

    const entries = statusBar.entries.get()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.entry.text).toBe('$(zap) 1')

    emitter.fire([summary()])
    expect(statusBar.entries.get()[0]?.entry.text).toBe('$(zap)')
    contribution.dispose()
  })

  it('removes the entry on dispose', async () => {
    const { statusBar, contribution } = await makeContribution([summary({ running: 1 })])
    expect(statusBar.entries.get()).toHaveLength(1)

    contribution.dispose()

    expect(statusBar.entries.get()).toHaveLength(0)
  })
})
