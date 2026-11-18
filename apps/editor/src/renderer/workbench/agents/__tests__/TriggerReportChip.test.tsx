import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import {
  ICommandService,
  InstantiationService,
  observableValue,
  ServiceCollection,
} from '@universe-editor/platform'
import { TriggerReportChip } from '../TriggerReportChip.js'
import { ServicesContext } from '../../useService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionAutomation,
  type AcpSessionHistoryEntry,
} from '../../../services/acp/session/acpSessionHistory.js'
import type { IAcpSession } from '../../../services/acp/session/acpSessionService.js'

afterEach(() => cleanup())

const AUTOMATION = {
  triggerId: 'swarm-triage',
  triggerName: 'Swarm 分诊',
  eventKey: 'swarm:42',
  runId: 'run-1',
} as const

function entry(automation?: AcpSessionHistoryEntry['automation']): AcpSessionHistoryEntry {
  return {
    id: 'durable-1',
    agentId: 'fake',
    sessionIdOnAgent: 'durable-1',
    title: 'session',
    createdAt: 1,
    lastUsedAt: 1,
    ...(automation !== undefined ? { automation } : {}),
  }
}

function renderChip(options: {
  entries?: AcpSessionHistoryEntry[]
  liveAutomation?: AcpSessionAutomation
}) {
  const entries = observableValue<readonly AcpSessionHistoryEntry[]>(
    't.entries',
    options.entries ?? [],
  )
  const history = {
    _serviceBrand: undefined,
    entries,
    get: (id: string) => entries.get().find((e) => e.id === id),
  }
  const executeCommand = vi.fn()
  const services = new ServiceCollection()
  services.set(IAcpSessionHistoryService, history as never)
  services.set(ICommandService, { _serviceBrand: undefined, executeCommand } as never)
  const inst = new InstantiationService(services)
  const session = {
    id: 'local-1',
    agentId: 'fake',
    sessionIdOnAgent: observableValue<string | undefined>('t.sid', 'durable-1'),
    automation: options.liveAutomation,
  } as unknown as IAcpSession
  const { container } = render(
    <ServicesContext.Provider value={inst}>
      <TriggerReportChip session={session} />
    </ServicesContext.Provider>,
  )
  const chip = () => container.querySelector('[data-testid="acp-trigger-report"]')
  return { chip, entries, executeCommand }
}

describe('TriggerReportChip', () => {
  it('renders nothing for a session no trigger started', () => {
    const h = renderChip({ entries: [entry()] })
    expect(h.chip()).toBeNull()
  })

  it('shows the trigger provenance and opens the report for this session', () => {
    const h = renderChip({ liveAutomation: AUTOMATION })
    const chip = h.chip()
    expect(chip?.getAttribute('data-tooltip')).toContain('Swarm 分诊')
    expect(chip?.getAttribute('data-tooltip')).toContain('swarm:42')

    fireEvent.click(chip!)

    expect(h.executeCommand).toHaveBeenCalledWith('workbench.action.triggers.viewReport', {
      sessionId: 'local-1',
    })
  })

  it('appears once history hydrates and shows the recorded verdict', () => {
    const h = renderChip({})
    expect(h.chip()).toBeNull()

    act(() => {
      h.entries.set([entry({ ...AUTOMATION, verdict: 'escalate' })], undefined)
    })

    expect(h.chip()?.textContent).toContain('Needs review')
    expect(h.chip()?.getAttribute('data-verdict')).toBe('escalate')
  })
})
