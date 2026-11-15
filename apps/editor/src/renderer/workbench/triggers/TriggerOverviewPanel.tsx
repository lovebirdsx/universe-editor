/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TriggerOverviewPanel — the selected trigger's state, gates and action buttons.
 *  Everything shown here comes from TriggerSummary; session / budget details are
 *  not part of the summary and are edited in the JSON configuration instead.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import { Badge, Button } from '@universe-editor/workbench-ui'
import { workspaceDisplayPath } from '../../../shared/triggers/configParse.js'
import {
  formatTriggerDuration,
  summarizeTriggerSource,
  triggerCanRun,
  triggerNeedsConfirmation,
  triggerSourceFacts,
  triggerSourceLabel,
  triggerStatusBadge,
} from '../../services/triggers/triggerPresentation.js'
import type { TriggerSummary } from '../../../shared/triggers/types.js'
import { relativeTime } from '../../relativeTime.js'
import { automationVerdictLabel, triggerRunOutcomeLabel } from '../agents/automationLabels.js'
import styles from './TriggerOverviewPanel.module.css'
import type { TriggerManagerActions } from './useTriggerActions.js'

export interface TriggerOverviewPanelProps {
  readonly summary: TriggerSummary
  readonly actions: TriggerManagerActions
}

export function TriggerOverviewPanel({ summary, actions }: TriggerOverviewPanelProps) {
  const invalid = summary.status === 'invalid'
  const needsActivation = !summary.activationConfirmed && !invalid
  const pausedAll = summary.pausedAll
  const canRun = triggerCanRun(summary)
  const badge = triggerStatusBadge(summary)
  const facts = triggerSourceFacts(summary.source)
  const outcomeLabel = triggerRunOutcomeLabel(summary.lastRunOutcome)
  const verdictLabel = automationVerdictLabel(summary.lastRunVerdict)
  const errors = [...(summary.errors ?? [])]
  if (summary.lastError !== undefined && summary.lastError.length > 0) {
    errors.unshift(summary.lastError)
  }

  return (
    <div className={styles['overview']} data-testid="trigger-manager-overview">
      <header className={styles['overviewHeader']}>
        <div className={styles['overviewHeading']}>
          <h2 className={styles['overviewTitle']} data-testid="trigger-manager-overview-name">
            {summary.name}
          </h2>
          <span className={styles['overviewSubtitle']}>
            {summary.id} · {summary.workspaceName}
          </span>
        </div>
        <Badge tone={badge.attention ? 'accent' : 'default'}>{badge.label}</Badge>
      </header>

      {needsActivation && (
        <div className={styles['notice']} data-testid="trigger-manager-gate-activation">
          {localize(
            'trigger.manager.overview.gate.activation',
            'This trigger comes from the workspace configuration. Confirm it on this machine before it can run — editing any field invalidates the confirmation.',
          )}
        </div>
      )}
      {summary.offline === true && (
        <div className={styles['notice']} data-testid="trigger-manager-gate-offline">
          {localize(
            'trigger.manager.overview.gate.offline',
            'The remote host is disconnected; this trigger will not run until it reconnects.',
          )}
        </div>
      )}
      {summary.autoPaused && (
        <div className={styles['notice']} data-testid="trigger-manager-gate-auto-paused">
          {localize(
            'trigger.manager.overview.autoPaused',
            'Paused automatically after repeated failures. Resume it once the cause is fixed.',
          )}
        </div>
      )}
      {summary.paused && !summary.autoPaused && !pausedAll && (
        <div className={styles['notice']} data-testid="trigger-manager-gate-paused">
          {localize(
            'trigger.manager.overview.paused',
            'New triggers start paused on this machine. It schedules automatically again once resumed; until then you can still run it now to try it.',
          )}
        </div>
      )}

      <section className={styles['section']}>
        <h3 className={styles['sectionTitle']}>
          {localize('trigger.manager.overview.actions', 'Actions')}
        </h3>
        <div className={styles['actions']}>
          <Button
            variant="primary"
            size="sm"
            disabled={!canRun}
            onClick={() => void actions.runNow(summary)}
            data-testid="trigger-manager-run-now"
          >
            {localize('trigger.manager.action.runNow', 'Run now')}
          </Button>
          <Button
            size="sm"
            disabled={invalid || pausedAll}
            onClick={() => void actions.setPaused(summary, !summary.paused)}
            data-testid={summary.paused ? 'trigger-manager-resume' : 'trigger-manager-pause'}
          >
            {summary.paused
              ? localize('trigger.manager.action.resume', 'Resume')
              : localize('trigger.manager.action.pause', 'Pause')}
          </Button>
          {needsActivation && (
            <Button
              size="sm"
              onClick={() => void actions.confirmActivation(summary)}
              data-testid="trigger-manager-confirm-activation"
            >
              {localize('trigger.manager.action.confirmActivation', 'Confirm trigger')}
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => void actions.showLog()}
            data-testid="trigger-manager-view-log"
          >
            {localize('trigger.manager.action.showLog', 'View log')}
          </Button>
          <Button
            size="sm"
            onClick={() => void actions.revealInJson(summary)}
            data-testid="trigger-manager-reveal-json"
          >
            {localize('trigger.manager.action.revealJson', 'Reveal in JSON')}
          </Button>
        </div>
      </section>

      <section className={styles['section']}>
        <h3 className={styles['sectionTitle']}>
          {localize('trigger.manager.overview.definition', 'Definition')}
        </h3>
        <dl className={styles['facts']}>
          <Fact
            label={localize('trigger.manager.overview.workspace', 'Workspace')}
            value={workspaceDisplayPath(summary.workspace)}
          />
          <Fact
            label={localize('trigger.manager.overview.source', 'Source')}
            value={
              summary.source === undefined
                ? triggerSourceLabel(summary.sourceType)
                : summarizeTriggerSource(summary.source)
            }
          />
          {facts.map((fact) => (
            <Fact key={fact.label} label={fact.label} value={fact.value} />
          ))}
          <Fact
            label={localize('trigger.manager.overview.activation', 'Workspace confirmation')}
            value={
              invalid
                ? triggerSourceLabel('unknown')
                : summary.activationConfirmed
                  ? localize('trigger.manager.overview.confirmed', 'Confirmed')
                  : localize('trigger.manager.overview.notConfirmed', 'Not confirmed')
            }
          />
          <Fact
            label={localize('trigger.manager.overview.elevated', 'High-privilege mode')}
            value={
              summary.elevatedMode
                ? localize(
                    'trigger.manager.overview.elevatedConfigured',
                    '⚠ Configured — the agent runs without per-step approval',
                  )
                : localize('trigger.manager.overview.notConfigured', 'Not configured')
            }
          />
          <Fact
            label={localize('trigger.manager.overview.enabledState', 'Enabled')}
            value={
              summary.enabled
                ? localize('trigger.manager.overview.enabled', 'Enabled')
                : localize('trigger.manager.overview.disabled', 'Disabled')
            }
          />
          <Fact
            label={localize('trigger.manager.overview.runCounts', 'Runs')}
            value={localize(
              'trigger.manager.overview.runningQueued',
              'Running: {running} · Queued: {queued}',
              {
                running: summary.running,
                queued: summary.queued,
              },
            )}
          />
          {summary.consecutiveFailures > 0 && (
            <Fact
              label={localize('trigger.manager.overview.failures', 'Consecutive failures')}
              value={String(summary.consecutiveFailures)}
            />
          )}
        </dl>
        <p className={styles['note']}>
          {localize(
            'trigger.manager.overview.configNote',
            'Session and budget settings live in triggers.json.',
          )}
        </p>
      </section>

      <section className={styles['section']}>
        <h3 className={styles['sectionTitle']}>
          {localize('trigger.manager.overview.lastRun', 'Last run')}
        </h3>
        {summary.lastRunAt === undefined ? (
          <p className={styles['note']} data-testid="trigger-manager-no-last-run">
            {localize('trigger.manager.overview.noLastRun', 'This trigger has not run yet.')}
          </p>
        ) : (
          <dl className={styles['facts']} data-testid="trigger-manager-last-run">
            <Fact
              label={localize('trigger.manager.overview.lastRunTime', 'When')}
              value={relativeTime(summary.lastRunAt)}
            />
            {outcomeLabel !== undefined && (
              <Fact
                label={localize('trigger.manager.overview.outcome', 'Outcome')}
                value={outcomeLabel}
              />
            )}
            {verdictLabel !== undefined && (
              <Fact
                label={localize('trigger.manager.overview.verdict', 'Verdict')}
                value={verdictLabel}
              />
            )}
            {summary.lastRunCostUsd !== undefined && (
              <Fact
                label={localize('trigger.manager.overview.cost', 'Cost')}
                value={`$${summary.lastRunCostUsd.toFixed(2)}`}
              />
            )}
            {summary.lastRunDurationMs !== undefined && (
              <Fact
                label={localize('trigger.manager.overview.duration', 'Duration')}
                value={formatTriggerDuration(summary.lastRunDurationMs)}
              />
            )}
            {summary.lastRunSummary !== undefined && summary.lastRunSummary.length > 0 && (
              <Fact
                label={localize('trigger.manager.overview.lastRunSummary', 'Summary')}
                value={summary.lastRunSummary}
              />
            )}
          </dl>
        )}
      </section>

      {errors.length > 0 && (
        <section className={styles['section']} data-testid="trigger-manager-errors">
          <h3 className={styles['sectionTitle']}>
            {localize('trigger.manager.overview.errors', 'Errors')}
          </h3>
          <ul className={styles['errorList']}>
            {errors.map((error, index) => (
              <li key={`${index}:${error}`} className={styles['errorItem']}>
                {error}
              </li>
            ))}
          </ul>
        </section>
      )}

      {triggerNeedsConfirmation(summary) && (
        <p className={styles['note']} data-testid="trigger-manager-needs-confirmation">
          {localize(
            'trigger.manager.overview.needsConfirmation',
            'This trigger will not run until the workspace confirmation above is granted.',
          )}
        </p>
      )}
    </div>
  )
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className={styles['factRow']}>
      <dt className={styles['factLabel']}>{label}</dt>
      <dd className={styles['factValue']}>{value}</dd>
    </div>
  )
}
