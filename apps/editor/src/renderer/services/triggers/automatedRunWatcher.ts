/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Budget and lifecycle watchdog for one automated trigger run. Owns exactly one
 *  terminal outcome per run: cost ceiling, active-time limit (time parked on a
 *  permission / question card is excluded), per-card approval timeout, normal
 *  turn completion, session error / close, and explicit cancel. Design §5.
 *
 *  The clock and timers are injectable so the whole matrix runs under a fake
 *  clock without sleeping.
 *--------------------------------------------------------------------------------------------*/

import { autorun, type IDisposable, type IReader } from '@universe-editor/platform'
import type { IAcpSession } from '../acp/session/acpSessionModel.js'
import type {
  TriggerActionAudit,
  TriggerRunEnd,
  TriggerRunOutcome,
  TriggerRunRequest,
  TriggerVerdictKind,
} from '../../../shared/triggers/types.js'

/** What a result-file parser may contribute to a run's end report. */
export interface AutomatedVerdictResolution {
  readonly verdict?: TriggerVerdictKind
  readonly summary?: string
  readonly actions: readonly TriggerActionAudit[]
}

/**
 * Extension point for the P2 verdict parser + action executor. `raw` is the
 * literal text of `<runDir>/result.json`, or undefined when the agent produced
 * no readable file. The default implementation contributes nothing.
 */
export type AutomatedVerdictResolver = (
  raw: string | undefined,
  request: TriggerRunRequest,
) => AutomatedVerdictResolution

export const defaultAutomatedVerdictResolver: AutomatedVerdictResolver = () => ({ actions: [] })

export type AutomatedTimerHandle = unknown

export interface AutomatedRunWatcherOptions {
  readonly request: TriggerRunRequest
  readonly session: IAcpSession
  /** Reads `<runDir>/result.json` verbatim; resolves undefined when absent/unreadable. */
  readonly readResultFile: (runDir: string) => Promise<string | undefined>
  readonly resolveVerdict?: AutomatedVerdictResolver
  readonly onRunEnd: (end: TriggerRunEnd, resolution: AutomatedVerdictResolution) => void
  /** Injected for tests. */
  readonly now?: () => number
  readonly setTimeout?: (handler: () => void, ms: number) => AutomatedTimerHandle
  readonly clearTimeout?: (handle: AutomatedTimerHandle) => void
}

export class AutomatedRunWatcher {
  private readonly _request: TriggerRunRequest
  private readonly _session: IAcpSession
  private readonly _readResultFile: (runDir: string) => Promise<string | undefined>
  private readonly _resolveVerdict: AutomatedVerdictResolver
  private readonly _onRunEnd: AutomatedRunWatcherOptions['onRunEnd']
  private readonly _now: () => number
  private readonly _setTimeout: (handler: () => void, ms: number) => AutomatedTimerHandle
  private readonly _clearTimeout: (handle: AutomatedTimerHandle) => void

  private _subscription: IDisposable | undefined
  private _started = false
  private _finished = false
  private _turnSettled = false
  private _activeMs = 0
  private _activeSince: number | undefined
  private _budgetTimer: AutomatedTimerHandle | undefined
  private _approvalTimer: AutomatedTimerHandle | undefined
  private _cardOpen = false

  constructor(options: AutomatedRunWatcherOptions) {
    this._request = options.request
    this._session = options.session
    this._readResultFile = options.readResultFile
    this._resolveVerdict = options.resolveVerdict ?? defaultAutomatedVerdictResolver
    this._onRunEnd = options.onRunEnd
    this._now = options.now ?? Date.now
    this._setTimeout =
      options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms) as AutomatedTimerHandle)
    this._clearTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle as never))
  }

  /** Start observing. Idempotent; the caller should invoke this before sendPrompt. */
  start(): void {
    if (this._started || this._finished) return
    this._started = true
    this._subscription = autorun((r) => this._evaluate(r))
  }

  /** The prompt RPC settled (the turn is over). Completion waits for any open card. */
  notifyTurnSettled(): void {
    if (this._finished) return
    this._turnSettled = true
    this._evaluate()
  }

  /** Explicit `cancelRun`: one terminal outcome, then cancel the turn. */
  cancel(): void {
    if (this._finished) return
    this._finish('cancelled')
    void this._session.cancelTurn().catch(() => undefined)
  }

  dispose(): void {
    this._disposeTimers()
    this._subscription?.dispose()
    this._subscription = undefined
  }

  private _evaluate(r?: IReader): void {
    if (this._finished) return
    const status = this._session.status.read(r)
    const usage = this._session.usage.read(r)
    const permission = this._session.pendingPermission.read(r)
    const elicitation = this._session.pendingElicitation.read(r)
    const nowMs = this._now()
    const cardOpen = permission !== undefined || elicitation !== undefined
    const active = status === 'running' && !cardOpen
    this._accumulate(active, nowMs)

    if (cardOpen && !this._cardOpen) {
      this._armApprovalTimer()
    } else if (!cardOpen && this._cardOpen) {
      this._clearApprovalTimer()
    }
    this._cardOpen = cardOpen

    const maxCostUsd = this._request.budget.maxCostUsd
    const spent = usage?.cost?.amount
    if (spent !== undefined && Number.isFinite(spent) && spent >= maxCostUsd) {
      this._finish('budget-exceeded')
      void this._session.cancelTurn().catch(() => undefined)
      return
    }

    if (status === 'errored') {
      this._finish('failed')
      return
    }
    if (status === 'closed') {
      this._finish('cancelled')
      return
    }

    if (this._turnSettled && !cardOpen) {
      this._finish('completed')
      return
    }

    this._scheduleBudgetTimer(active, nowMs)
  }

  private _accumulate(active: boolean, nowMs: number): void {
    if (active) {
      this._activeSince ??= nowMs
      return
    }
    if (this._activeSince !== undefined) {
      this._activeMs += Math.max(0, nowMs - this._activeSince)
      this._activeSince = undefined
    }
  }

  private _activeTotal(nowMs: number): number {
    return this._activeMs + (this._activeSince !== undefined ? nowMs - this._activeSince : 0)
  }

  private _scheduleBudgetTimer(active: boolean, nowMs: number): void {
    this._clearBudgetTimer()
    if (!active) return
    const remaining = this._request.budget.timeoutMin * 60_000 - this._activeTotal(nowMs)
    if (remaining <= 0) {
      this._finish('timeout')
      void this._session.cancelTurn().catch(() => undefined)
      return
    }
    this._budgetTimer = this._setTimeout(() => {
      this._budgetTimer = undefined
      if (this._finished) return
      // Re-evaluate through the same path so a pending card that paused the
      // clock is honored (it re-arms on resume).
      this._evaluate()
    }, remaining)
  }

  private _armApprovalTimer(): void {
    this._clearApprovalTimer()
    this._approvalTimer = this._setTimeout(() => {
      this._approvalTimer = undefined
      if (this._finished) return
      this._finish('approval-timeout')
      void this._session.cancelTurn().catch(() => undefined)
    }, this._request.budget.approvalTimeoutMin * 60_000)
  }

  private _finish(outcome: TriggerRunOutcome): void {
    if (this._finished) return
    this._finished = true
    this._disposeTimers()
    void this._finalize(outcome)
  }

  private async _finalize(outcome: TriggerRunOutcome): Promise<void> {
    let raw: string | undefined
    try {
      raw = await this._readResultFile(this._request.runDir)
    } catch {
      raw = undefined
    }
    const resolution = this._resolveVerdict(raw, this._request)
    const sessionId = this._session.sessionIdOnAgent.get() ?? this._session.id
    const end: TriggerRunEnd = {
      runId: this._request.origin.runId,
      triggerId: this._request.origin.triggerId,
      sessionId,
      outcome,
      ...(resolution.verdict !== undefined ? { verdict: resolution.verdict } : {}),
      ...(resolution.summary !== undefined ? { summary: resolution.summary } : {}),
      actions: resolution.actions,
    }
    this._subscription?.dispose()
    this._subscription = undefined
    this._onRunEnd(end, resolution)
  }

  private _clearBudgetTimer(): void {
    if (this._budgetTimer === undefined) return
    this._clearTimeout(this._budgetTimer)
    this._budgetTimer = undefined
  }

  private _clearApprovalTimer(): void {
    if (this._approvalTimer === undefined) return
    this._clearTimeout(this._approvalTimer)
    this._approvalTimer = undefined
  }

  private _disposeTimers(): void {
    this._clearBudgetTimer()
    this._clearApprovalTimer()
  }
}
