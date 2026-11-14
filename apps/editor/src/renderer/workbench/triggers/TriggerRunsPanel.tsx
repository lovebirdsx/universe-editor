/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TriggerRunsPanel — the per-trigger run history table. Rows come from the
 *  machine-local `history.jsonl` (via ITriggerMainService.listRuns); every cell
 *  is plain text so a hand-edited history file cannot inject markup. A run that
 *  finishes while the panel is open refreshes the table through the summary
 *  transition (running > 0 → 0, or a new lastRunId).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IEditorGroupsService,
  IEditorService,
  IInstantiationService,
  REMOTE_SCHEME,
  localize,
} from '@universe-editor/platform'
import { Button, Select } from '@universe-editor/workbench-ui'
import { ITriggerMainService } from '../../../shared/ipc/triggerService.js'
import { parseWorkspaceUri } from '../../../shared/triggers/configParse.js'
import { formatTriggerDuration } from '../../../shared/triggers/triggerPresentation.js'
import type {
  TriggerRunHistoryEntry,
  TriggerRunOutcome,
  TriggerSummary,
} from '../../../shared/triggers/types.js'
import { relativeTime } from '../../relativeTime.js'
import { IAcpSessionService } from '../../services/acp/session/acpSessionService.js'
import { IAcpSessionHistoryService } from '../../services/acp/session/acpSessionHistory.js'
import { IAcpChatWidgetService } from '../../services/acp/session/acpChatWidgetService.js'
import { revealSessionChat } from '../../services/acp/session/revealSessionChat.js'
import { TriggerReportEditorInput } from '../../services/triggers/triggerReportEditorInput.js'
import { IWindowFocusService } from '../../services/windows/windowFocusService.js'
import { useService } from '../useService.js'
import { automationVerdictLabel, triggerRunOutcomeLabel } from '../agents/automationLabels.js'
import { errorText } from './triggerFormParts.js'
import styles from './TriggerManager.module.css'

export interface TriggerRunsPanelProps {
  readonly summary: TriggerSummary
}

const RUN_LIMIT = 100

type OutcomeFilter = TriggerRunOutcome | 'all'

const OUTCOMES: readonly TriggerRunOutcome[] = [
  'completed',
  'budget-exceeded',
  'timeout',
  'approval-timeout',
  'cancelled',
  'failed',
]

export function TriggerRunsPanel({ summary }: TriggerRunsPanelProps) {
  const triggers = useService(ITriggerMainService)
  const editors = useService(IEditorService)
  const sessions = useService(IAcpSessionService)
  const history = useService(IAcpSessionHistoryService)
  const groups = useService(IEditorGroupsService)
  const instantiation = useService(IInstantiationService)
  const widgets = useService(IAcpChatWidgetService)
  const windowFocus = useService(IWindowFocusService)

  const [runs, setRuns] = useState<readonly TriggerRunHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [outcome, setOutcome] = useState<OutcomeFilter>('all')
  const requestRef = useRef(0)

  const load = useCallback(async () => {
    const token = ++requestRef.current
    setLoading(true)
    setLoadError(undefined)
    try {
      const next = await triggers.listRuns({
        triggerKey: summary.key,
        ...(outcome === 'all' ? {} : { outcome }),
        limit: RUN_LIMIT,
      })
      if (token !== requestRef.current) return
      setRuns(next)
      setLoading(false)
    } catch (err) {
      if (token !== requestRef.current) return
      setLoadError(errorText(err))
      setLoading(false)
    }
  }, [outcome, summary.key, triggers])

  // Switching triggers resets the filter and the "a new row exists" baseline
  // synchronously, so the transition effect below does not fire a second load.
  const summaryKeyRef = useRef(summary.key)
  const previous = useRef({
    running: summary.running,
    lastRunId: summary.lastRunId,
  })
  useEffect(() => {
    if (summaryKeyRef.current === summary.key) return
    summaryKeyRef.current = summary.key
    previous.current = { running: summary.running, lastRunId: summary.lastRunId }
    setRuns([])
    setOutcome('all')
    requestRef.current += 1
  }, [summary.key, summary.running, summary.lastRunId])

  // The parent pushes a fresh summary when a run ends. Refresh exactly on the
  // transitions that mean "a new row exists", not on every summary update.
  useEffect(() => {
    const before = previous.current
    previous.current = { running: summary.running, lastRunId: summary.lastRunId }
    const finished = before.running > 0 && summary.running === 0
    if (finished || before.lastRunId !== summary.lastRunId) void load()
  }, [load, summary.lastRunId, summary.running])

  useEffect(() => {
    void load()
    return () => {
      requestRef.current += 1
    }
  }, [load])

  const revealSession = useCallback(
    (entry: TriggerRunHistoryEntry) => {
      const sessionId = entry.sessionId
      if (sessionId === undefined) return
      const live = sessions.getById(sessionId)
      const durable = history.get(sessionId)
      revealSessionChat(
        { groups, inst: instantiation, widgets, windowFocus },
        live?.id ?? sessionId,
        live !== undefined
          ? { agentId: live.agentId }
          : durable !== undefined
            ? { agentId: durable.agentId }
            : undefined,
      )
    },
    [groups, history, instantiation, sessions, widgets, windowFocus],
  )

  const openReport = useCallback(
    (entry: TriggerRunHistoryEntry) => {
      const workspace = parseWorkspaceUri(entry.workspace)
      const authority =
        workspace !== undefined && workspace.scheme === REMOTE_SCHEME
          ? workspace.authority
          : undefined
      const snapshot = {
        outcome: entry.outcome,
        ...(entry.verdict !== undefined ? { verdict: entry.verdict } : {}),
        ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
      }
      void editors.openEditor(
        new TriggerReportEditorInput({
          runId: entry.runId,
          triggerName: entry.triggerName,
          ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
          ...(authority !== undefined ? { authority } : {}),
          snapshot,
        }),
        { pinned: true },
      )
    },
    [editors],
  )

  return (
    <div className={styles['runs']} data-testid="trigger-manager-runs">
      <div className={styles['runsToolbar']}>
        <Select<OutcomeFilter>
          value={outcome}
          options={[
            { value: 'all', label: localize('trigger.manager.runs.filter.all', 'All outcomes') },
            ...OUTCOMES.map((value) => ({
              value,
              label: triggerRunOutcomeLabel(value) ?? value,
            })),
          ]}
          onChange={setOutcome}
          aria-label={localize('trigger.manager.runs.filter', 'Filter by outcome')}
          data-testid="trigger-manager-runs-filter"
        />
        <Button
          size="sm"
          busy={loading}
          onClick={() => void load()}
          data-testid="trigger-manager-runs-refresh"
        >
          {localize('trigger.manager.runs.refresh', 'Refresh')}
        </Button>
      </div>

      {loading && runs.length === 0 && (
        <div className={styles['state']} data-testid="trigger-manager-runs-loading">
          {localize('trigger.manager.runs.loading', 'Loading run history…')}
        </div>
      )}
      {loadError !== undefined && (
        <div className={styles['state']} data-testid="trigger-manager-runs-error">
          {localize('trigger.manager.runs.loadFailed', 'Failed to load run history: {error}', {
            error: loadError,
          })}
        </div>
      )}
      {!loading && loadError === undefined && runs.length === 0 && outcome === 'all' && (
        <div className={styles['state']} data-testid="trigger-manager-runs-empty">
          {localize(
            'trigger.manager.runs.empty',
            'No runs have been recorded for this trigger yet.',
          )}
        </div>
      )}
      {!loading && loadError === undefined && runs.length === 0 && outcome !== 'all' && (
        <div className={styles['state']} data-testid="trigger-manager-runs-empty-filter">
          {localize('trigger.manager.runs.emptyFilter', 'No runs match this outcome.')}
        </div>
      )}
      {runs.length > 0 && (
        <table className={styles['runsTable']} data-testid="trigger-manager-runs-table">
          <thead>
            <tr>
              <th>{localize('trigger.manager.runs.column.time', 'Time')}</th>
              <th>{localize('trigger.manager.runs.column.outcome', 'Outcome')}</th>
              <th>{localize('trigger.manager.runs.column.verdict', 'Verdict')}</th>
              <th>{localize('trigger.manager.runs.column.summary', 'Summary')}</th>
              <th>{localize('trigger.manager.runs.column.duration', 'Duration')}</th>
              <th>{localize('trigger.manager.runs.column.cost', 'Cost')}</th>
              <th>{localize('trigger.manager.runs.column.session', 'Session')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((entry) => {
              const outcomeLabel = triggerRunOutcomeLabel(entry.outcome) ?? entry.outcome
              const verdictLabel = automationVerdictLabel(entry.verdict)
              return (
                <tr
                  key={entry.runId}
                  className={styles['runsRow']}
                  data-testid="trigger-manager-runs-row"
                  data-run-id={entry.runId}
                  tabIndex={0}
                  onClick={() => {
                    if (entry.sessionId !== undefined) revealSession(entry)
                    else openReport(entry)
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    if (entry.sessionId !== undefined) revealSession(entry)
                    else openReport(entry)
                  }}
                >
                  <td className={styles['runsTime']} data-tooltip={absoluteTime(entry.endedAt)}>
                    {relativeTime(entry.endedAt)}
                  </td>
                  <td>{outcomeLabel}</td>
                  <td>{verdictLabel ?? '—'}</td>
                  <td className={styles['runsSummary']}>
                    {entry.summary !== undefined && entry.summary.length > 0
                      ? entry.summary
                      : entry.error !== undefined && entry.error.length > 0
                        ? entry.error
                        : '—'}
                  </td>
                  <td>
                    {entry.durationMs !== undefined ? formatTriggerDuration(entry.durationMs) : '—'}
                  </td>
                  <td>{entry.costUsd !== undefined ? `$${entry.costUsd.toFixed(2)}` : '—'}</td>
                  <td>
                    <div className={styles['runsActions']}>
                      {entry.sessionId !== undefined && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(event) => {
                            event.stopPropagation()
                            revealSession(entry)
                          }}
                          data-testid="trigger-manager-runs-open-session"
                        >
                          {localize('trigger.manager.runs.openSession', 'Open session')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(event) => {
                          event.stopPropagation()
                          openReport(entry)
                        }}
                        data-testid="trigger-manager-runs-view-report"
                      >
                        {localize('trigger.manager.runs.viewReport', 'View report')}
                      </Button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

function absoluteTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}
