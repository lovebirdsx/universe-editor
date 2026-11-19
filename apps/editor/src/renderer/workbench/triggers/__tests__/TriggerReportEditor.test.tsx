import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  ContextKeyService,
  Emitter,
  ICommandService,
  IContextKeyService,
  IEditorGroupsService,
  ILoggerService,
  InstantiationService,
  ServiceCollection,
  observableValue,
  type ICommandService as ICommandServiceType,
  type IEditorGroup,
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
import { MarkdownPreviewRegistry } from '../../../services/editor/MarkdownPreviewRegistry.js'
import { TriggerReportEditorInput } from '../../../services/triggers/triggerReportEditorInput.js'
import { ServicesContext } from '../../useService.js'
import { EditorGroupContext } from '../../editor/EditorGroupContext.js'
import { TriggerReportEditor } from '../TriggerReportEditor.js'

vi.mock('../../markdown/MarkdownView.js', () => ({
  MarkdownView: ({
    text,
    testId,
    baseUri,
  }: {
    text: string
    testId?: string
    baseUri?: { toString(): string }
  }) => (
    <div data-testid={testId ?? 'markdown-view'} data-base-uri={baseUri?.toString()}>
      {text}
    </div>
  ),
}))

vi.mock('../../../services/acp/session/revealSessionChat.js', () => ({
  revealSessionChat: vi.fn(),
}))

vi.mock('../../../services/triggers/rerunTriggerRun.js', () => ({
  rerunTriggerRun: vi.fn(),
}))

import { revealSessionChat } from '../../../services/acp/session/revealSessionChat.js'
import { rerunTriggerRun } from '../../../services/triggers/rerunTriggerRun.js'

const stubCommandService: ICommandServiceType = {
  _serviceBrand: undefined,
  async executeCommand() {
    return undefined
  },
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  MarkdownPreviewRegistry._resetForTests()
})

interface EditorOptions {
  report: TriggerRunReportReadResult
  outcome?: 'completed' | 'failed'
  verdict?: 'escalate' | 'info'
  summary?: string
  authority?: string
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
    ...(options.authority !== undefined ? { authority: options.authority } : {}),
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

  const input = new TriggerReportEditorInput({
    runId: 'run-1',
    triggerName: 'Triage',
    sessionId: 'session-1',
    eventKey: 'swarm:1',
    ...(options.authority !== undefined ? { authority: options.authority } : {}),
  })
  // The report is the active editor of its group, so the reader focuses itself.
  const group = { id: 1, activeEditor: input } as unknown as IEditorGroup

  const services = new ServiceCollection()
  services.set(ITriggerMainService, {
    _serviceBrand: undefined,
    readRunReport,
  } as unknown as ITriggerMainService)
  services.set(IAcpSessionService, sessions)
  services.set(IAcpSessionHistoryService, history)
  services.set(IAutomatedSessionService, automated)
  services.set(IEditorGroupsService, { activeGroup: group } as unknown as IEditorGroupsService)
  services.set(IAcpChatWidgetService, {} as never)
  services.set(IWindowFocusService, {} as never)
  services.set(IContextKeyService, new ContextKeyService())
  services.set(ICommandService, stubCommandService)
  services.set(ILoggerService, {
    _serviceBrand: undefined,
    createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  } as unknown as ILoggerService)
  const inst = new InstantiationService(services)

  render(
    <ServicesContext.Provider value={inst}>
      <EditorGroupContext.Provider value={group}>
        <TriggerReportEditor input={input} />
      </EditorGroupContext.Provider>
    </ServicesContext.Provider>,
  )

  return { readRunReport, endEmitter, input }
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
    // StrictMode replays the mount effect, so the absolute count is not one per
    // mount; the refresh itself must add exactly one read.
    const before = harness.readRunReport.mock.calls.length
    fireEvent.click(screen.getByTestId('trigger-report-refresh'))

    await screen.findByTestId('trigger-report-markdown')
    expect(harness.readRunReport).toHaveBeenCalledTimes(before + 1)
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
    const before = harness.readRunReport.mock.calls.length
    act(() => {
      harness.endEmitter.fire({
        runId: 'run-1',
        triggerId: 'triage',
        outcome: 'completed',
      })
    })

    await screen.findByTestId('trigger-report-markdown')
    expect(harness.readRunReport).toHaveBeenCalledTimes(before + 1)
  })

  it('passes the session host authority and uses the runDir URI as the markdown base', async () => {
    const harness = renderEditor({
      authority: 'e2e-local',
      report: {
        kind: 'ok',
        text: '# Remote report',
        runDir: 'remote-ssh://e2e-local/C:/runs/run-1',
        modifiedAt: Date.now(),
      },
    })

    const markdown = await screen.findByTestId('trigger-report-markdown')
    expect(markdown.getAttribute('data-base-uri')).toBe('remote-ssh://e2e-local/C:/runs/run-1')
    expect(harness.readRunReport).toHaveBeenCalledWith('run-1', 'e2e-local')
  })

  it('shows the unavailable state when the remote host is not connected', async () => {
    renderEditor({ authority: 'e2e-local', report: { kind: 'unavailable' } })

    await screen.findByTestId('trigger-report-unavailable')
    expect(screen.queryByTestId('trigger-report-missing')).toBeNull()
  })

  it('opens the session from the summary bar', async () => {
    renderEditor({ report: { kind: 'not-found' }, outcome: 'completed' })
    await screen.findByTestId('trigger-report-missing')

    fireEvent.click(screen.getByTestId('trigger-report-open-session'))

    expect(revealSessionChat).toHaveBeenCalledWith(expect.anything(), 'session-1', {
      agentId: 'claude-code',
    })
  })

  it('focuses the report body and scrolls it with j/k', async () => {
    renderEditor({ report: { kind: 'ok', text: '# Body', runDir: 'X:/r', modifiedAt: 1 } })
    const body = await screen.findByTestId('trigger-report-body')
    expect(document.activeElement).toBe(body)

    const scrollBy = vi.fn()
    body.scrollBy = scrollBy as unknown as typeof body.scrollBy

    fireEvent.keyDown(body, { key: 'j' })
    expect(scrollBy).toHaveBeenCalledWith({ top: 60, behavior: 'smooth' })
    fireEvent.keyDown(body, { key: 'k' })
    expect(scrollBy).toHaveBeenLastCalledWith({ top: -60, behavior: 'smooth' })
  })

  it('opens the session with o', async () => {
    renderEditor({ report: { kind: 'ok', text: '# Body', runDir: 'X:/r', modifiedAt: 1 } })
    const body = await screen.findByTestId('trigger-report-body')

    fireEvent.keyDown(body, { key: 'o' })
    expect(revealSessionChat).toHaveBeenCalledWith(expect.anything(), 'session-1', {
      agentId: 'claude-code',
    })
  })

  it('refreshes with r and re-runs with R', async () => {
    const harness = renderEditor({
      report: { kind: 'ok', text: '# Body', runDir: 'X:/r', modifiedAt: 1 },
    })
    const body = await screen.findByTestId('trigger-report-body')
    const before = harness.readRunReport.mock.calls.length

    fireEvent.keyDown(body, { key: 'r' })
    await screen.findByTestId('trigger-report-markdown')
    expect(harness.readRunReport).toHaveBeenCalledTimes(before + 1)

    fireEvent.keyDown(body, { key: 'R', shiftKey: true })
    expect(rerunTriggerRun).toHaveBeenCalledWith(expect.anything(), 'run-1')
  })

  it('ignores action keys with modifiers', async () => {
    const harness = renderEditor({
      report: { kind: 'ok', text: '# Body', runDir: 'X:/r', modifiedAt: 1 },
    })
    const body = await screen.findByTestId('trigger-report-body')
    const before = harness.readRunReport.mock.calls.length

    fireEvent.keyDown(body, { key: 'r', ctrlKey: true })
    fireEvent.keyDown(body, { key: 'r', altKey: true })
    fireEvent.keyDown(body, { key: 'r', metaKey: true })

    expect(harness.readRunReport).toHaveBeenCalledTimes(before)
    expect(rerunTriggerRun).not.toHaveBeenCalled()
  })

  it('registers the reader controller so find and help work', async () => {
    const harness = renderEditor({
      report: { kind: 'ok', text: '# Body', runDir: 'X:/r', modifiedAt: 1 },
    })
    await screen.findByTestId('trigger-report-body')

    const controller = MarkdownPreviewRegistry.get(harness.input.resource)
    expect(controller).toBeDefined()

    act(() => controller!.toggleHelp())
    expect(screen.getByTestId('md-preview-help')).not.toBeNull()
  })

  it('ignores action keys and navigation while typing in the find box', async () => {
    const harness = renderEditor({
      report: { kind: 'ok', text: '# Body', runDir: 'X:/r', modifiedAt: 1 },
    })
    const body = await screen.findByTestId('trigger-report-body')
    const scrollBy = vi.fn()
    body.scrollBy = scrollBy as unknown as typeof body.scrollBy

    const controller = MarkdownPreviewRegistry.get(harness.input.resource)
    expect(controller).toBeDefined()
    act(() => controller!.openFind())
    const findInput = await screen.findByTestId('acp-find-input')
    const before = harness.readRunReport.mock.calls.length

    fireEvent.keyDown(findInput, { key: 'r' })
    fireEvent.keyDown(findInput, { key: 'j' })

    expect(harness.readRunReport).toHaveBeenCalledTimes(before)
    expect(scrollBy).not.toHaveBeenCalled()
  })
})
