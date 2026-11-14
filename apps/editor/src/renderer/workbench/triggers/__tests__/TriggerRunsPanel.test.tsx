/*---------------------------------------------------------------------------------------------
 *  Tests for the run-history table: loading / empty / error states, the
 *  outcome filter, refresh and the two transitions that mean "a new row exists"
 *  (running → 0 and a new lastRunId). Rows are asserted as plain text.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  IEditorGroupsService,
  IEditorService,
  IInstantiationService,
  IUriIdentityService,
  InstantiationService,
  ServiceCollection,
  observableValue,
} from '@universe-editor/platform'
import { ITriggerMainService } from '../../../../shared/ipc/triggerService.js'
import type { TriggerRunHistoryEntry, TriggerSummary } from '../../../../shared/triggers/types.js'
import { IAcpSessionService } from '../../../services/acp/session/acpSessionService.js'
import { IAcpSessionHistoryService } from '../../../services/acp/session/acpSessionHistory.js'
import { IAcpChatWidgetService } from '../../../services/acp/session/acpChatWidgetService.js'
import { TriggerReportEditorInput } from '../../../services/triggers/triggerReportEditorInput.js'
import { IWindowFocusService } from '../../../services/windows/windowFocusService.js'
import { ServicesContext } from '../../useService.js'
import { TriggerRunsPanel } from '../TriggerRunsPanel.js'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function summary(overrides: Partial<TriggerSummary> = {}): TriggerSummary {
  return {
    key: 'ws\0triage',
    id: 'triage',
    name: 'Triage',
    workspace: 'file:///X:/workspace',
    workspaceName: 'workspace',
    sourceType: 'manual',
    source: { type: 'manual' },
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

function run(overrides: Partial<TriggerRunHistoryEntry> = {}): TriggerRunHistoryEntry {
  return {
    runId: 'run-1',
    triggerKey: 'ws\0triage',
    triggerId: 'triage',
    triggerName: 'Triage',
    workspace: 'file:///X:/workspace',
    workspaceName: 'workspace',
    sessionId: 'session-1',
    startedAt: Date.now() - 120_000,
    endedAt: Date.now() - 60_000,
    outcome: 'completed',
    verdict: 'info',
    summary: 'Reviewed <b>three</b> files',
    costUsd: 0.42,
    durationMs: 65_000,
    ...overrides,
  }
}

function omit(
  entry: TriggerRunHistoryEntry,
  keys: readonly (keyof TriggerRunHistoryEntry)[],
): TriggerRunHistoryEntry {
  const copy = { ...entry } as Record<string, unknown>
  for (const key of keys) delete copy[key]
  return copy as unknown as TriggerRunHistoryEntry
}

function renderPanel(
  options: {
    readonly runs?: readonly TriggerRunHistoryEntry[]
    readonly error?: Error
    readonly summary?: TriggerSummary
  } = {},
) {
  const listRuns = vi.fn(async (filter?: { outcome?: string }) => {
    if (options.error !== undefined) throw options.error
    const runs = options.runs ?? []
    return filter?.outcome === undefined
      ? runs
      : runs.filter((entry) => entry.outcome === filter.outcome)
  })
  const openEditor = vi.fn(async (input: unknown) => input)
  const focusSessionInput = vi.fn()
  const services = new ServiceCollection()
  services.set(ITriggerMainService, {
    _serviceBrand: undefined,
    listRuns,
  } as unknown as ITriggerMainService)
  services.set(IEditorService, { openEditor } as unknown as IEditorService)
  services.set(IEditorGroupsService, { groups: [] } as unknown as IEditorGroupsService)
  services.set(IUriIdentityService, {
    isEqual: () => false,
  } as unknown as IUriIdentityService)
  services.set(IAcpSessionService, {
    sessions: observableValue('test.sessions', []),
  } as unknown as IAcpSessionService)
  services.set(IAcpSessionHistoryService, {
    entries: observableValue('test.history', []),
    get: () => undefined,
  } as unknown as IAcpSessionHistoryService)
  services.set(IAcpChatWidgetService, {
    focusSessionInput,
  } as unknown as IAcpChatWidgetService)
  services.set(IWindowFocusService, {} as never)
  const instantiation = new InstantiationService(services)
  services.set(IInstantiationService, instantiation)

  const view = render(
    <ServicesContext.Provider value={instantiation}>
      <TriggerRunsPanel summary={options.summary ?? summary()} />
    </ServicesContext.Provider>,
  )
  return { view, instantiation, listRuns, openEditor, focusSessionInput }
}

describe('TriggerRunsPanel', () => {
  it('loads the selected trigger history and renders rows as plain text', async () => {
    const harness = renderPanel({
      runs: [
        run(),
        omit(
          run({
            runId: 'run-2',
            outcome: 'failed',
            error: 'agent exited',
            costUsd: 0.1,
          }),
          ['verdict', 'summary'],
        ),
      ],
    })

    expect(await screen.findAllByTestId('trigger-manager-runs-row')).toHaveLength(2)
    expect(harness.listRuns).toHaveBeenCalledWith({ triggerKey: 'ws\0triage', limit: 100 })
    expect(screen.getByText('Reviewed <b>three</b> files')).toBeDefined()
    expect(screen.queryByText('<b>')).toBeNull()
    expect(screen.getByText('agent exited')).toBeDefined()
    expect(screen.getByText('$0.42')).toBeDefined()
    expect(screen.getAllByText('1m 5s').length).toBeGreaterThan(0)
  })

  it('pushes the outcome filter down to listRuns', async () => {
    const harness = renderPanel({
      runs: [run(), run({ runId: 'run-2', outcome: 'failed' })],
    })
    await screen.findAllByTestId('trigger-manager-runs-row')
    expect(harness.listRuns).toHaveBeenCalledWith({ triggerKey: 'ws\0triage', limit: 100 })

    fireEvent.click(screen.getByTestId('trigger-manager-runs-filter'))
    fireEvent.click(screen.getByRole('option', { name: 'Failed' }))

    await waitFor(() =>
      expect(harness.listRuns).toHaveBeenLastCalledWith({
        triggerKey: 'ws\0triage',
        outcome: 'failed',
        limit: 100,
      }),
    )
    expect(await screen.findAllByTestId('trigger-manager-runs-row')).toHaveLength(1)
  })

  it('shows the filtered-empty state when the filter matches nothing', async () => {
    renderPanel({ runs: [run()] })
    await screen.findAllByTestId('trigger-manager-runs-row')

    fireEvent.click(screen.getByTestId('trigger-manager-runs-filter'))
    fireEvent.click(screen.getByRole('option', { name: 'Failed' }))

    expect(await screen.findByTestId('trigger-manager-runs-empty-filter')).toBeDefined()
  })

  it('does not reload from the run-transition effect when the trigger changes', async () => {
    const harness = renderPanel({
      summary: summary({ running: 1, lastRunId: 'run-1' }),
      runs: [run()],
    })
    await screen.findAllByTestId('trigger-manager-runs-row')
    const before = harness.listRuns.mock.calls.length

    harness.view.rerender(
      <ServicesContext.Provider value={harness.instantiation}>
        <TriggerRunsPanel summary={summary({ key: 'ws\0other', id: 'other', running: 0 })} />
      </ServicesContext.Provider>,
    )

    await waitFor(() => expect(harness.listRuns.mock.calls.length).toBe(before + 1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.listRuns.mock.calls.length).toBe(before + 1)
  })

  it('reloads through the refresh button', async () => {
    const harness = renderPanel({ runs: [run()] })
    await screen.findAllByTestId('trigger-manager-runs-row')

    fireEvent.click(screen.getByTestId('trigger-manager-runs-refresh'))

    await waitFor(() => expect(harness.listRuns).toHaveBeenCalledTimes(2))
  })

  it('refreshes when a run finishes or a new lastRunId appears', async () => {
    const harness = renderPanel({ summary: summary({ running: 1, lastRunId: 'run-1' }) })
    await screen.findByTestId('trigger-manager-runs-empty')
    expect(harness.listRuns).toHaveBeenCalledTimes(1)

    harness.view.rerender(
      <ServicesContext.Provider value={harness.instantiation}>
        <TriggerRunsPanel summary={summary({ running: 0, lastRunId: 'run-1' })} />
      </ServicesContext.Provider>,
    )

    await waitFor(() => expect(harness.listRuns).toHaveBeenCalledTimes(2))

    harness.view.rerender(
      <ServicesContext.Provider value={harness.instantiation}>
        <TriggerRunsPanel summary={summary({ running: 0, lastRunId: 'run-2' })} />
      </ServicesContext.Provider>,
    )

    await waitFor(() => expect(harness.listRuns).toHaveBeenCalledTimes(3))
  })

  it('shows the empty state when no runs exist', async () => {
    renderPanel()
    expect(await screen.findByTestId('trigger-manager-runs-empty')).toBeDefined()
  })

  it('shows the error state when the history cannot be read', async () => {
    renderPanel({ error: new Error('history.jsonl is unreadable') })
    expect(await screen.findByTestId('trigger-manager-runs-error')).toBeDefined()
    expect(screen.getByText(/history\.jsonl is unreadable/)).toBeDefined()
  })

  it('opens the report tab for a row without a session', async () => {
    const harness = renderPanel({
      runs: [omit(run(), ['sessionId'])],
    })
    const row = await screen.findByTestId('trigger-manager-runs-row')

    fireEvent.click(row)

    expect(harness.openEditor).toHaveBeenCalledTimes(1)
    const input = harness.openEditor.mock.calls[0]?.[0]
    expect(input).toBeInstanceOf(TriggerReportEditorInput)
    expect((input as TriggerReportEditorInput).target.runId).toBe('run-1')
  })

  it('opens the report tab from the view-report button without activating the row', async () => {
    const harness = renderPanel({ runs: [omit(run(), ['sessionId'])] })
    await screen.findByTestId('trigger-manager-runs-row')

    fireEvent.click(screen.getByTestId('trigger-manager-runs-view-report'))

    expect(harness.openEditor).toHaveBeenCalledTimes(1)
  })
})
