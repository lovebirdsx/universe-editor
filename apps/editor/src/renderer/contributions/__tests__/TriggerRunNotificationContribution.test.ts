/*---------------------------------------------------------------------------------------------
 *  Tests for the automated-run result toast: severity / message per outcome and
 *  verdict, the trigger name from session provenance, and the cancelled no-op.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type INotificationService } from '@universe-editor/platform'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    ...overrides,
  }
}

function setWindowVisible(visible: boolean): void {
  vi.stubGlobal('document', {
    hasFocus: () => visible,
    visibilityState: visible ? 'visible' : 'hidden',
  })
}

beforeEach(() => {
  setWindowVisible(true)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

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
  const notifySystem = vi.fn(async (_options: unknown) => ({ shown: true, clicked: false }))
  const host = { notify: notifySystem }
  const commands = { executeCommand: vi.fn() }
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
    host as never,
    commands as never,
    { createLogger: () => ({ debug: vi.fn(), warn: vi.fn() }) } as never,
  )
  return { contribution, emitter, notify, notifySystem, commands }
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
    emitter.fire(runEnd({ verdict: 'info', summary: 'voted up' }))
    const options = notify.mock.calls[0]![0] as { severity: number; message: string }
    expect(options.severity).toBe(0)
    expect(options.message).toBe('Completed: Swarm triage')
  })

  it('offers a report action that opens the run by id', () => {
    const { emitter, notify, commands } = setup()
    emitter.fire(runEnd({ verdict: 'info' }))
    const options = notify.mock.calls[0]![0] as {
      actions: { label: string; run: () => void }[]
    }
    expect(options.actions.map((action) => action.label)).toEqual(['Open Session', 'View Report'])

    options.actions[1]!.run()

    expect(commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.triggers.viewReport',
      expect.objectContaining({
        runId: 'run-1',
        sessionId: 'durable-1',
        triggerName: 'Swarm triage',
        eventKey: 'swarm:1001',
      }),
    )
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

  it('uses a system notification when the window is hidden or unfocused', async () => {
    setWindowVisible(false)
    const { emitter, notify, notifySystem } = setup()

    emitter.fire(
      runEnd({ verdict: 'escalate', summary: 'author pushed a new version', outcome: 'completed' }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(notify).not.toHaveBeenCalled()
    expect(notifySystem).toHaveBeenCalledTimes(1)
    expect(notifySystem.mock.calls[0]![0]).toMatchObject({
      title: 'Trigger run needs attention',
      body: 'Needs your action: Swarm triage · author pushed a new version',
      originWindow: { kind: 'workspace' },
    })
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
      { notify: vi.fn(async () => ({ shown: true, clicked: false })) } as never,
      { executeCommand: vi.fn() } as never,
      { createLogger: () => ({ debug: vi.fn(), warn: vi.fn() }) } as never,
    )
    emitter.fire(runEnd({ verdict: 'info' }))
    expect((notify.mock.calls[0]![0] as { message: string }).message).toBe(
      'Completed: swarm-triage',
    )
  })
})
