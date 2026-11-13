import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Emitter,
  IEditorGroupsService,
  InstantiationService,
  ServiceCollection,
  observableValue,
} from '@universe-editor/platform'
import type {
  TriggerRunEnd,
  TriggerRunReportReadResult,
} from '../../../../shared/triggers/types.js'
import { ITriggerMainService } from '../../../../shared/ipc/triggerService.js'
import { IAcpSessionService } from '../../../services/acp/session/acpSessionService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
} from '../../../services/acp/session/acpSessionHistory.js'
import { IAcpChatWidgetService } from '../../../services/acp/session/acpChatWidgetService.js'
import { IAutomatedSessionService } from '../../../services/triggers/automatedSessionService.js'
import { IWindowFocusService } from '../../../services/windows/windowFocusService.js'
import { TriggerReportEditorInput } from '../../../services/triggers/triggerReportEditorInput.js'
import { ServicesContext } from '../../useService.js'
import { TriggerReportEditor } from '../TriggerReportEditor.js'

vi.mock('../../markdown/MarkdownView.js', () => ({
  MarkdownView: ({ text, testId }: { text: string; testId?: string }) => (
    <div data-testid={testId ?? 'markdown-view'}>{text}</div>
  ),
}))

vi.mock('../../../services/acp/session/revealSessionChat.js', () => ({
  revealSessionChat: vi.fn(),
}))

import { revealSessionChat } from '../../../services/acp/session/revealSessionChat.js'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

interface EditorOptions {
  report: TriggerRunReportReadResult
  outcome?: 'completed' | 'failed'
  verdict?: 'auto-approve' | 'escalate' | 'reject' | 'info'
  summary?: string
}

function renderEditor(options: EditorOptions) {
  const readRunReport = vi.fn(async (): Promise<TriggerRunReportReadResult> => options.report)
  const endEmitter = new Emitter<TriggerRunEnd>()
  const entry: AcpSessionHistoryEntry = {
    id: 'session-1',
    agentId: 'claude-code',
    sessionIdOnAgent: 'session-1',
    title: 'Session',
    createdAt: 1,
    lastUsedAt: 1,
    automation: {
      triggerId: 'triage',
      triggerName: 'Triage',
      eventKey: 'swarm:1',
      runId: 'run-1',
      ...(options.outcome !== undefined ? { outcome: options.outcome } : {}),
      ...(options.verdict !== undefined ? { verdict: options.verdict } : {}),
      ...(options.summary !== undefined ? { summary: options.summary } : {}),
    },
  }
  const history = {
    _serviceBrand: undefined,
    entries: observableValue<readonly AcpSessionHistoryEntry[]>('test.entries', [entry]),
    get: (id: string) => (id === 'session-1' ? entry : undefined),
  } as unknown as IAcpSessionHistoryService
  const sessions = {
    _serviceBrand: undefined,
    sessions: observableValue('test.sessions', []),
    getById: () => undefined,
  } as unknown as IAcpSessionService
  const automated = {
    _serviceBrand: undefined,
    onDidEndRun: endEmitter.event,
  } as unknown as IAutomatedSessionService

  const services = new ServiceCollection()
  services.set(ITriggerMainService, {
    _serviceBrand: undefined,
    readRunReport,
  } as unknown as ITriggerMainService)
  services.set(IAcpSessionService, sessions)
  services.set(IAcpSessionHistoryService, history)
  services.set(IAutomatedSessionService, automated)
  services.set(IEditorGroupsService, {} as never)
  services.set(IAcpChatWidgetService, {} as never)
  services.set(IWindowFocusService, {} as never)
  const inst = new InstantiationService(services)

  render(
    <ServicesContext.Provider value={inst}>
      <TriggerReportEditor
        input={
          new TriggerReportEditorInput({
            runId: 'run-1',
            triggerName: 'Triage',
            sessionId: 'session-1',
            eventKey: 'swarm:1',
          })
        }
      />
    </ServicesContext.Provider>,
  )

  return { readRunReport, endEmitter }
}

describe('TriggerReportEditor', () => {
  it('renders the summary bar and the report markdown', async () => {
    renderEditor({
      report: {
        kind: 'ok',
        text: '# Report body',
        runDir: 'X:/runs/run-1',
        modifiedAt: Date.now(),
      },
      outcome: 'completed',
      verdict: 'escalate',
      summary: 'needs review',
    })

    const markdown = await screen.findByTestId('trigger-report-markdown')
    expect(markdown.textContent).toBe('# Report body')
    expect(screen.getByTestId('trigger-report-trigger').textContent).toContain('Triage')
    expect(screen.getByTestId('trigger-report-event').textContent).toBe('swarm:1')
    expect(screen.getByTestId('trigger-report-meta').textContent).toContain('Completed')
    expect(screen.getByTestId('trigger-report-meta').textContent).toContain('Needs review')
    expect(screen.getByTestId('trigger-report-meta').textContent).toContain('needs review')
  })

  it('shows the running state when the report is missing and the run has no outcome', async () => {
    renderEditor({ report: { kind: 'not-found' } })

    await screen.findByTestId('trigger-report-running')
  })

  it('shows the missing state when the report is missing after the run ended', async () => {
    renderEditor({ report: { kind: 'not-found' }, outcome: 'failed' })

    await screen.findByTestId('trigger-report-missing')
  })

  it('shows the empty and too-large states', async () => {
    const first = renderEditor({
      report: { kind: 'ok', text: '   ', runDir: 'X:/r', modifiedAt: 1 },
    })
    await screen.findByTestId('trigger-report-empty')
    cleanup()

    renderEditor({ report: { kind: 'too-large' } })
    await screen.findByTestId('trigger-report-too-large')
    expect(first.readRunReport).toHaveBeenCalled()
  })

  it('refreshes manually', async () => {
    const harness = renderEditor({ report: { kind: 'not-found' }, outcome: 'failed' })
    await screen.findByTestId('trigger-report-missing')

    harness.readRunReport.mockResolvedValueOnce({
      kind: 'ok',
      text: '# Fresh',
      runDir: 'X:/r',
      modifiedAt: Date.now(),
    })
    fireEvent.click(screen.getByTestId('trigger-report-refresh'))

    await screen.findByTestId('trigger-report-markdown')
    expect(harness.readRunReport).toHaveBeenCalledTimes(2)
  })

  it('refreshes automatically when the matching run ends', async () => {
    const harness = renderEditor({ report: { kind: 'not-found' } })
    await screen.findByTestId('trigger-report-running')

    harness.readRunReport.mockResolvedValueOnce({
      kind: 'ok',
      text: '# Finished',
      runDir: 'X:/r',
      modifiedAt: Date.now(),
    })
    act(() => {
      harness.endEmitter.fire({
        runId: 'run-1',
        triggerId: 'triage',
        outcome: 'completed',
        actions: [],
      })
    })

    await screen.findByTestId('trigger-report-markdown')
    expect(harness.readRunReport).toHaveBeenCalledTimes(2)
  })

  it('opens the session from the summary bar', async () => {
    renderEditor({ report: { kind: 'not-found' }, outcome: 'completed' })
    await screen.findByTestId('trigger-report-missing')

    fireEvent.click(screen.getByTestId('trigger-report-open-session'))

    expect(revealSessionChat).toHaveBeenCalledWith(expect.anything(), 'session-1', {
      agentId: 'claude-code',
    })
  })
})
