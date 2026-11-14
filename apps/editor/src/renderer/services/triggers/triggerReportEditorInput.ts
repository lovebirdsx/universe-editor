/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TriggerReportEditorInput — a virtual, read-only tab for one trigger run's
 *  report.md. Identity is the run id, so re-opening the same run reuses the tab.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, localize, URI } from '@universe-editor/platform'
import type { TriggerRunOutcome, TriggerVerdictKind } from '../../../shared/triggers/types.js'

const SCHEMA = 1

const OUTCOMES: readonly TriggerRunOutcome[] = [
  'completed',
  'budget-exceeded',
  'timeout',
  'approval-timeout',
  'cancelled',
  'failed',
]

const VERDICTS: readonly TriggerVerdictKind[] = ['auto-approve', 'escalate', 'reject', 'info']

export interface TriggerReportSnapshot {
  readonly outcome?: TriggerRunOutcome
  readonly verdict?: TriggerVerdictKind
  readonly summary?: string
}

export interface TriggerReportTarget {
  readonly runId: string
  readonly triggerName: string
  /** Durable or local session id; used for the summary and "Open Session". */
  readonly sessionId?: string
  /** Host owning the run directory (remote-ssh authority); undefined = local. */
  readonly authority?: string
  readonly eventKey?: string
  /** Last known automation fields, used before history hydrates. */
  readonly snapshot?: TriggerReportSnapshot
}

interface SerializedTriggerReport {
  readonly schema: number
  readonly runId: string
  readonly triggerName: string
  readonly sessionId?: string
  readonly authority?: string
  readonly eventKey?: string
  readonly snapshot?: TriggerReportSnapshot
}

export class TriggerReportEditorInput extends EditorInput {
  static readonly TYPE_ID = 'trigger.report'

  constructor(readonly target: TriggerReportTarget) {
    super()
  }

  override get typeId(): string {
    return TriggerReportEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return URI.from({ scheme: 'trigger-report', path: `/${this.target.runId}` })
  }

  override get id(): string {
    return `trigger-report:${this.target.runId}`
  }

  override getName(): string {
    return localize('trigger.report.tabTitle', 'Run Report · {0}', { 0: this.target.triggerName })
  }

  override serialize(): SerializedTriggerReport {
    const target = this.target
    return {
      schema: SCHEMA,
      runId: target.runId,
      triggerName: target.triggerName,
      ...(target.sessionId !== undefined ? { sessionId: target.sessionId } : {}),
      ...(target.authority !== undefined ? { authority: target.authority } : {}),
      ...(target.eventKey !== undefined ? { eventKey: target.eventKey } : {}),
      ...(target.snapshot !== undefined ? { snapshot: target.snapshot } : {}),
    }
  }

  static deserialize(data: unknown): TriggerReportEditorInput | null {
    if (data === null || typeof data !== 'object') return null
    const value = data as Partial<SerializedTriggerReport>
    if (
      value.schema !== SCHEMA ||
      typeof value.runId !== 'string' ||
      value.runId.length === 0 ||
      typeof value.triggerName !== 'string'
    ) {
      return null
    }
    const snapshot = readSnapshot(value.snapshot)
    return new TriggerReportEditorInput({
      runId: value.runId,
      triggerName: value.triggerName.length > 0 ? value.triggerName : fallbackTriggerName(),
      ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
      ...(typeof value.authority === 'string' && value.authority.length > 0
        ? { authority: value.authority }
        : {}),
      ...(typeof value.eventKey === 'string' ? { eventKey: value.eventKey } : {}),
      ...(snapshot !== undefined ? { snapshot } : {}),
    })
  }
}

export function fallbackTriggerName(): string {
  return localize('trigger.report.unknownTrigger', 'Trigger')
}

function readSnapshot(value: unknown): TriggerReportSnapshot | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const snapshot = value as Record<string, unknown>
  const outcome =
    typeof snapshot['outcome'] === 'string' &&
    (OUTCOMES as readonly string[]).includes(snapshot['outcome'])
      ? (snapshot['outcome'] as TriggerRunOutcome)
      : undefined
  const verdict =
    typeof snapshot['verdict'] === 'string' &&
    (VERDICTS as readonly string[]).includes(snapshot['verdict'])
      ? (snapshot['verdict'] as TriggerVerdictKind)
      : undefined
  const summary = typeof snapshot['summary'] === 'string' ? snapshot['summary'] : undefined
  if (outcome === undefined && verdict === undefined && summary === undefined) return undefined
  return {
    ...(outcome !== undefined ? { outcome } : {}),
    ...(verdict !== undefined ? { verdict } : {}),
    ...(summary !== undefined ? { summary } : {}),
  }
}
