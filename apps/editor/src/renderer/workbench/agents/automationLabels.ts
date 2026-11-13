/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Human labels for trigger automation fields shared by the Sessions list and
 *  the run report tab.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import type { TriggerRunOutcome, TriggerVerdictKind } from '../../../shared/triggers/types.js'

export function automationVerdictLabel(
  verdict: TriggerVerdictKind | undefined,
): string | undefined {
  switch (verdict) {
    case 'auto-approve':
      return localize('acp.sessions.verdict.autoApprove', 'Auto-approved')
    case 'escalate':
      return localize('acp.sessions.verdict.escalate', 'Needs review')
    case 'reject':
      return localize('acp.sessions.verdict.reject', 'Rejected')
    case 'info':
      return localize('acp.sessions.verdict.info', 'Info')
    default:
      return undefined
  }
}

export function triggerRunOutcomeLabel(outcome: TriggerRunOutcome | undefined): string | undefined {
  switch (outcome) {
    case 'completed':
      return localize('trigger.report.outcome.completed', 'Completed')
    case 'budget-exceeded':
      return localize('trigger.report.outcome.budgetExceeded', 'Budget exceeded')
    case 'timeout':
      return localize('trigger.report.outcome.timeout', 'Timed out')
    case 'approval-timeout':
      return localize('trigger.report.outcome.approvalTimeout', 'Approval timed out')
    case 'cancelled':
      return localize('trigger.report.outcome.cancelled', 'Cancelled')
    case 'failed':
      return localize('trigger.report.outcome.failed', 'Failed')
    default:
      return undefined
  }
}
