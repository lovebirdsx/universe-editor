/*---------------------------------------------------------------------------------------------
 *  Tests for the automated-run result toast: severity / message per outcome and
 *  verdict, the trigger name from session provenance, and the cancelled no-op.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type INotificationService } from '@universe-editor/platform'
import { describe, expect, it, vi } from 'vitest'
import type { TriggerRunEnd } from '../../../shared/triggers/types.js'
import { TriggerRunNotificationContribution } from '../TriggerRunNotificationContribution.js'

function runEnd(overrides: Partial<TriggerRunEnd> = {}): TriggerRunEnd {
  return {
    runId: 'run-1',
    triggerId: 'swarm-triage',
    sessionId: 'durable-1',
    outcome: 'completed',
    verdict: 'info',
    summary: 'nothing to do',
    actions: [],
    ...overrides,
  }
}

function setup() {
  const emitter = new Emitter<TriggerRunEnd>()
  const notify = vi.fn((_options: unknown) => ({
    id: 'n1',
    progress: { report: () => {}, done: () => {} },
    updateMessage: () => {},
    updateSeverity: () => {},
    dispose: () => {},
  }))
  const notification = { notify, dismiss: vi.fn() } as unknown as INotificationService
  const sessions = {
    getById: () => ({
      id: 'local-1',
      agentId: 'claude-code',
      automation: {
        triggerId: 'swarm-triage',
        triggerName: 'Swarm triage',
        eventKey: 'swarm:1001',
        runId: 'run-1',
      },
    }),
  }
  const contribution = new TriggerRunNotificationContribution(
    { onDidEndRun: emitter.event } as never,
    sessions as never,
    { groups: [] } as never,
    { createInstance: vi.fn() } as never,
    { focusSessionInput: vi.fn() } as never,
    { focusGroup: vi.fn() } as never,
    notification,
    { createLogger: () => ({ debug: vi.fn(), warn: vi.fn() }) } as never,
  )
  return { contribution, emitter, notify }
}

describe('TriggerRunNotificationContribution', () => {
  it('warns with the trigger name and summary on an escalation', () => {
    const { emitter, notify } = setup()
    emitter.fire(
      runEnd({ verdict: 'escalate', summary: 'author pushed a new version', outcome: 'completed' }),
    )
    expect(notify).toHaveBeenCalledTimes(1)
    const options = notify.mock.calls[0]![0] as { severity: number; message: string }
    expect(options.severity).toBe(1)
    expect(options.message).toBe('Needs your action: Swarm triage · author pushed a new version')
  })

  it('reports a clean finish at info level', () => {
    const { emitter, notify } = setup()
    emitter.fire(runEnd({ verdict: 'auto-approve', summary: 'voted up' }))
    const options = notify.mock.calls[0]![0] as { severity: number; message: string }
    expect(options.severity).toBe(0)
    expect(options.message).toBe('Completed: Swarm triage')
  })

  it('warns when the run did not complete', () => {
    const { emitter, notify } = setup()
    emitter.fire(runEnd({ outcome: 'budget-exceeded', verdict: 'info' }))
    const options = notify.mock.calls[0]![0] as { severity: number; message: string }
    expect(options.severity).toBe(1)
    expect(options.message).toContain('did not complete: Swarm triage (budget-exceeded)')
  })

  it('stays silent when the user cancelled the run', () => {
    const { emitter, notify } = setup()
    emitter.fire(runEnd({ outcome: 'cancelled' }))
    expect(notify).not.toHaveBeenCalled()
  })

  it('falls back to the trigger id when the session is gone', () => {
    const emitter = new Emitter<TriggerRunEnd>()
    const notify = vi.fn((_options: unknown) => ({
      id: 'n1',
      progress: { report: () => {}, done: () => {} },
      updateMessage: () => {},
      updateSeverity: () => {},
      dispose: () => {},
    }))
    new TriggerRunNotificationContribution(
      { onDidEndRun: emitter.event } as never,
      { getById: () => undefined } as never,
      { groups: [] } as never,
      { createInstance: vi.fn() } as never,
      { focusSessionInput: vi.fn() } as never,
      { focusGroup: vi.fn() } as never,
      { notify, dismiss: vi.fn() } as never,
      { createLogger: () => ({ debug: vi.fn(), warn: vi.fn() }) } as never,
    )
    emitter.fire(runEnd({ verdict: 'reject' }))
    expect((notify.mock.calls[0]![0] as { message: string }).message).toBe(
      'Completed: swarm-triage',
    )
  })
})
