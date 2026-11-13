/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TriggerReportEditor — read-only view of one trigger run's report.md. The
 *  summary bar comes from the session's persisted automation metadata; the body
 *  is untrusted Markdown rendered by the shared MarkdownView.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react'
import {
  IEditorGroupsService,
  IEditorInput,
  IInstantiationService,
  localize,
  URI,
} from '@universe-editor/platform'
import type {
  TriggerRunOutcome,
  TriggerRunReportReadResult,
  TriggerVerdictKind,
} from '../../../shared/triggers/types.js'
import { MAX_TRIGGER_REPORT_BYTES } from '../../../shared/triggers/types.js'
import { ITriggerMainService } from '../../../shared/ipc/triggerService.js'
import { IAcpSessionService } from '../../services/acp/session/acpSessionService.js'
import { IAcpSessionHistoryService } from '../../services/acp/session/acpSessionHistory.js'
import { IAcpChatWidgetService } from '../../services/acp/session/acpChatWidgetService.js'
import { revealSessionChat } from '../../services/acp/session/revealSessionChat.js'
import { IAutomatedSessionService } from '../../services/triggers/automatedSessionService.js'
import {
  fallbackTriggerName,
  TriggerReportEditorInput,
} from '../../services/triggers/triggerReportEditorInput.js'
import { IWindowFocusService } from '../../services/windows/windowFocusService.js'
import { relativeTime } from '../../relativeTime.js'
import { useObservable, useService } from '../useService.js'
import { automationVerdictLabel, triggerRunOutcomeLabel } from '../agents/automationLabels.js'
import { MarkdownView } from '../markdown/MarkdownView.js'
import styles from './TriggerReportEditor.module.css'

type ReportState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready'
      readonly text: string
      readonly runDir: string
      readonly modifiedAt: number
    }
  | { readonly status: 'empty' }
  | { readonly status: 'running' }
  | { readonly status: 'missing' }
  | { readonly status: 'too-large' }
  | { readonly status: 'error' }

export function TriggerReportEditor({ input }: { input: IEditorInput }) {
  const reportInput = input instanceof TriggerReportEditorInput ? input : undefined
  const target = reportInput?.target
  const runId = target?.runId
  const sessionId = target?.sessionId

  const triggers = useService(ITriggerMainService)
  const sessions = useService(IAcpSessionService)
  const history = useService(IAcpSessionHistoryService)
  const automated = useService(IAutomatedSessionService)
  const groups = useService(IEditorGroupsService)
  const inst = useService(IInstantiationService)
  const widgets = useService(IAcpChatWidgetService)
  const windowFocus = useService(IWindowFocusService)

  useObservable(sessions.sessions)
  useObservable(history.entries)

  const live = sessionId !== undefined ? sessions.getById(sessionId) : undefined
  const durableId = live?.sessionIdOnAgent.get() ?? sessionId
  const historyEntry = durableId !== undefined ? history.get(durableId) : undefined
  const automation = live?.automation ?? historyEntry?.automation
  const triggerName = automation?.triggerName ?? target?.triggerName ?? fallbackTriggerName()
  const eventKey = automation?.eventKey ?? target?.eventKey
  const outcome: TriggerRunOutcome | undefined =
    historyEntry?.automation?.outcome ?? target?.snapshot?.outcome
  const verdict: TriggerVerdictKind | undefined =
    historyEntry?.automation?.verdict ?? target?.snapshot?.verdict
  const summary = historyEntry?.automation?.summary ?? target?.snapshot?.summary

  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<ReportState>({ status: 'loading' })

  useEffect(() => {
    if (runId === undefined) {
      setState({ status: 'error' })
      return
    }
    let cancelled = false
    setState({ status: 'loading' })
    void triggers.readRunReport(runId).then(
      (result) => {
        if (!cancelled) setState(reportStateFrom(result, outcome))
      },
      () => {
        if (!cancelled) setState({ status: 'error' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [attempt, outcome, runId, triggers])

  useEffect(() => {
    if (runId === undefined) return
    const disposable = automated.onDidEndRun((end) => {
      if (end.runId === runId) setAttempt((value) => value + 1)
    })
    return () => disposable.dispose()
  }, [automated, runId])

  const openSession = useCallback(() => {
    if (sessionId === undefined) return
    revealSessionChat(
      { groups, inst, widgets, windowFocus },
      live?.id ?? sessionId,
      live !== undefined
        ? { agentId: live.agentId }
        : historyEntry !== undefined
          ? { agentId: historyEntry.agentId }
          : undefined,
    )
  }, [groups, inst, widgets, windowFocus, sessionId, live, historyEntry])

  if (reportInput === undefined) return null

  const outcomeLabel = triggerRunOutcomeLabel(outcome)
  const verdictLabel = automationVerdictLabel(verdict)
  const modifiedAt = state.status === 'ready' ? state.modifiedAt : undefined

  return (
    <div className={styles['root']} data-testid="trigger-report">
      <header className={styles['header']}>
        <div className={styles['heading']}>
          <div className={styles['titleRow']}>
            <span className={styles['trigger']} data-testid="trigger-report-trigger">
              {`⚡ ${triggerName}`}
            </span>
            {eventKey !== undefined && eventKey.length > 0 && (
              <span className={styles['eventKey']} data-testid="trigger-report-event">
                {eventKey}
              </span>
            )}
            {modifiedAt !== undefined && (
              <span className={styles['time']} data-testid="trigger-report-time">
                {relativeTime(modifiedAt)}
              </span>
            )}
          </div>
          <div className={styles['metaRow']} data-testid="trigger-report-meta">
            {outcomeLabel !== undefined && <span>{outcomeLabel}</span>}
            {verdictLabel !== undefined && <span>{verdictLabel}</span>}
            {summary !== undefined && summary.length > 0 && (
              <span className={styles['summary']}>{summary}</span>
            )}
          </div>
        </div>
        <div className={styles['actions']}>
          {sessionId !== undefined && (
            <button
              type="button"
              className={styles['action']}
              data-testid="trigger-report-open-session"
              onClick={openSession}
            >
              {localize('trigger.report.openSession', 'Open Session')}
            </button>
          )}
          <button
            type="button"
            className={styles['action']}
            data-testid="trigger-report-refresh"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {localize('trigger.report.refresh', 'Refresh')}
          </button>
        </div>
      </header>
      <div className={styles['body']} data-testid="trigger-report-body">
        {renderState(state)}
      </div>
    </div>
  )
}

function reportStateFrom(
  result: TriggerRunReportReadResult,
  outcome: TriggerRunOutcome | undefined,
): ReportState {
  switch (result.kind) {
    case 'ok':
      return result.text.trim() === ''
        ? { status: 'empty' }
        : {
            status: 'ready',
            text: result.text,
            runDir: result.runDir,
            modifiedAt: result.modifiedAt,
          }
    case 'too-large':
      return { status: 'too-large' }
    case 'not-found':
      return outcome === undefined ? { status: 'running' } : { status: 'missing' }
  }
}

function renderState(state: ReportState) {
  switch (state.status) {
    case 'loading':
      return (
        <div className={styles['state']} data-testid="trigger-report-loading">
          {localize('trigger.report.loading', 'Loading report…')}
        </div>
      )
    case 'ready':
      return (
        <MarkdownView
          text={state.text}
          className={styles['markdown'] ?? ''}
          baseUri={URI.file(state.runDir)}
          testId="trigger-report-markdown"
        />
      )
    case 'empty':
      return (
        <div className={styles['state']} data-testid="trigger-report-empty">
          {localize('trigger.report.empty', 'The report is empty.')}
        </div>
      )
    case 'running':
      return (
        <div className={styles['state']} data-testid="trigger-report-running">
          {localize(
            'trigger.report.running',
            'The run is still in progress or the report has not been written yet.',
          )}
        </div>
      )
    case 'missing':
      return (
        <div className={styles['state']} data-testid="trigger-report-missing">
          {localize(
            'trigger.report.missing',
            'The report was not generated or has already been cleaned up.',
          )}
        </div>
      )
    case 'too-large':
      return (
        <div className={styles['state']} data-testid="trigger-report-too-large">
          {localize(
            'trigger.report.tooLarge',
            'The report exceeds the {kb} KB limit and cannot be opened.',
            { kb: MAX_TRIGGER_REPORT_BYTES / 1024 },
          )}
        </div>
      )
    case 'error':
      return (
        <div className={styles['state']} data-testid="trigger-report-error">
          {localize('trigger.report.error', 'Failed to read the report.')}
        </div>
      )
  }
}
