import { localize } from '@universe-editor/platform'
import { describe, expect, it } from 'vitest'
import { TriggerReportEditorInput } from '../triggerReportEditorInput.js'

describe('TriggerReportEditorInput', () => {
  it('keys the tab by run id and exposes a stable title', () => {
    const input = new TriggerReportEditorInput({
      runId: 'run-1',
      triggerName: 'Swarm triage',
      sessionId: 'session-1',
      eventKey: 'swarm:1001',
    })

    expect(input.typeId).toBe(TriggerReportEditorInput.TYPE_ID)
    expect(input.id).toBe('trigger-report:run-1')
    expect(input.resource.scheme).toBe('trigger-report')
    expect(input.resource.path).toBe('/run-1')
    expect(input.getName()).toBe(
      localize('trigger.report.tabTitle', 'Run Report · {0}', { 0: 'Swarm triage' }),
    )
  })

  it('round-trips the target through serialize/deserialize', () => {
    const input = new TriggerReportEditorInput({
      runId: 'run-1',
      triggerName: 'Swarm triage',
      sessionId: 'session-1',
      eventKey: 'swarm:1001',
      snapshot: { outcome: 'completed', verdict: 'escalate', summary: 'needs review' },
    })

    const restored = TriggerReportEditorInput.deserialize(input.serialize())

    expect(restored?.target).toEqual(input.target)
    expect(restored?.id).toBe(input.id)
  })

  it('drops invalid optional snapshot fields and rejects malformed payloads', () => {
    const restored = TriggerReportEditorInput.deserialize({
      schema: 1,
      runId: 'run-1',
      triggerName: 'Triage',
      snapshot: { outcome: 'nope', verdict: 'info', summary: 42 },
    })

    expect(restored?.target.snapshot).toEqual({ verdict: 'info' })
    expect(TriggerReportEditorInput.deserialize(null)).toBeNull()
    expect(
      TriggerReportEditorInput.deserialize({ schema: 2, runId: 'r', triggerName: 't' }),
    ).toBeNull()
    expect(
      TriggerReportEditorInput.deserialize({ schema: 1, runId: '', triggerName: 't' }),
    ).toBeNull()
  })
})
