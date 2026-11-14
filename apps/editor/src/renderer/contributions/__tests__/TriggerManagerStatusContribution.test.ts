/*---------------------------------------------------------------------------------------------
 *  Tests for TriggerManagerStatusContribution: the "⚡ …" entry appears only while
 *  a trigger needs the user, tracks updates, opens the manager and disappears on
 *  dispose / when everything is clear.
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
    name: 'Triage',
    workspace: 'X:/workspace',
    workspaceName: 'workspace',
    sourceType: 'swarm-review',
    status: 'idle',
    enabled: true,
    paused: false,
    pausedAll: false,
    autoPaused: false,
    activationConfirmed: true,
    elevatedMode: false,
    elevatedModeConfirmed: false,
    approveAction: false,
    approveConfirmed: false,
    running: 0,
    queued: 0,
    consecutiveFailures: 0,
    ...overrides,
  }
}

async function makeContribution(summaries: readonly TriggerSummary[]) {
  const emitter = new Emitter<readonly TriggerSummary[]>()
  const triggers = {
    _serviceBrand: undefined,
    listTriggers: async () => summaries,
    onDidChangeTriggers: emitter.event,
  } as unknown as ITriggerMainService
  const statusBar = new StatusBarService()
  const contribution = new TriggerManagerStatusContribution(statusBar, triggers)
  await Promise.resolve()
  await Promise.resolve()
  return { emitter, statusBar, contribution }
}

describe('TriggerManagerStatusContribution', () => {
  it('stays hidden when nothing needs the user', async () => {
    const { statusBar, contribution } = await makeContribution([summary()])
    expect(statusBar.entries.get()).toHaveLength(0)
    contribution.dispose()
  })

  it('shows running and unconfirmed counts and opens the manager on click', async () => {
    const { statusBar, contribution } = await makeContribution([
      summary({ running: 1 }),
      summary({ id: 'b', activationConfirmed: false, status: 'needs-confirmation' }),
    ])
    const entry = statusBar.entries.get()[0]?.entry
    expect(entry?.text).toBe('⚡ 1 running · 1 needs confirmation')
    expect(entry?.command).toBe(OpenTriggerManagerAction.ID)
    expect(entry?.alignment).toBe(StatusBarAlignment.Right)
    expect(entry?.tooltip).toContain('Click to open the trigger manager')
    contribution.dispose()
  })

  it('updates the text when the trigger list changes', async () => {
    const { emitter, statusBar, contribution } = await makeContribution([summary({ running: 1 })])
    expect(statusBar.entries.get()).toHaveLength(1)

    emitter.fire([summary({ id: 'b', autoPaused: true })])

    const entries = statusBar.entries.get()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.entry.text).toBe('⚡ 1 auto-paused')
    contribution.dispose()
  })

  it('removes the entry once everything is clear again', async () => {
    const { emitter, statusBar, contribution } = await makeContribution([summary({ running: 1 })])
    expect(statusBar.entries.get()).toHaveLength(1)

    emitter.fire([summary()])

    expect(statusBar.entries.get()).toHaveLength(0)
    contribution.dispose()
  })

  it('removes the entry on dispose', async () => {
    const { statusBar, contribution } = await makeContribution([summary({ running: 1 })])
    expect(statusBar.entries.get()).toHaveLength(1)

    contribution.dispose()

    expect(statusBar.entries.get()).toHaveLength(0)
  })
})
