/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Budget and lifecycle watchdog for one automated trigger run. Owns exactly one
 *  terminal outcome per run: cost ceiling, active-time limit (time parked on a
 *  permission / question card is excluded), per-card approval timeout, normal
 *  turn completion, session error / close, and explicit cancel.
 *  Docs: docs/development/triggers.md
 *
 *  The clock and timers are injectable so the whole matrix runs under a fake
 *  clock without sleeping.
 *--------------------------------------------------------------------------------------------*/

import { autorun, type IDisposable, type IReader } from '@universe-editor/platform'
import { parseVerdict } from '../../../shared/triggers/verdict.js'
import type { AcpUsage, IAcpSession } from '../acp/session/acpSessionModel.js'
import type {
  TriggerRunEnd,
  TriggerRunOutcome,
  TriggerRunRequest,
} from '../../../shared/triggers/types.js'

const MAX_SUMMARY_LENGTH = 200

function clampSummary(summary: string): string {
  return summary.length > MAX_SUMMARY_LENGTH ? summary.slice(0, MAX_SUMMARY_LENGTH) : summary
}

/** Missing or unparseable result.json escalates: the user should look at it. */
function resolveResultVerdict(raw: string | undefined): Pick<TriggerRunEnd, 'verdict' | 'summary'> {
  if (raw === undefined || raw.trim().length === 0) {
    return { verdict: 'escalate', summary: '未产出结构化结果' }
  }
  const parsed = parseVerdict(raw)
  if (!parsed.ok) {
    return { verdict: 'escalate', summary: clampSummary(`未产出结构化结果：${parsed.error}`) }
  }
  return { verdict: parsed.verdict.verdict, summary: parsed.verdict.summary }
}

export type AutomatedTimerHandle = unknown

export interface AutomatedRunWatcherOptions {
  readonly request: TriggerRunRequest
  readonly session: IAcpSession
  /**
   * Reads `result.json` from the run's directory verbatim; resolves undefined
   * when absent/unreadable. Takes the whole request so the reader can resolve
   * `runDir` on the run's own host (`authority` for remote runs).
   */
  readonly readResultFile: (request: TriggerRunRequest) => Promise<string | undefined>
  readonly onRunEnd: (end: TriggerRunEnd) => void
  /** Warns once when the agent reports cost in a currency the budget cannot compare. */
  readonly logger?: { warn(message: string): void }
  /** Injected for tests. */
  readonly now?: () => number
  readonly setTimeout?: (handler: () => void, ms: number) => AutomatedTimerHandle
  readonly clearTimeout?: (handle: AutomatedTimerHandle) => void
}

export class AutomatedRunWatcher {
  private readonly _request: TriggerRunRequest
  private readonly _session: IAcpSession
  private readonly _readResultFile: (request: TriggerRunRequest) => Promise<string | undefined>
  private readonly _onRunEnd: AutomatedRunWatcherOptions['onRunEnd']
  private readonly _logger: { warn(message: string): void } | undefined
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
  private _warnedNonUsdCurrency = false

  constructor(options: AutomatedRunWatcherOptions) {
    this._request = options.request
    this._session = options.session
    this._readResultFile = options.readResultFile
    this._onRunEnd = options.onRunEnd
    this._logger = options.logger
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

  /**
   * The prompt RPC rejected: the turn did not run to completion. Reported as
   * `failed` with the error, unless a terminal outcome already won the race.
   */
  notifyTurnFailed(error: string): void {
    if (this._finished) return
    this._turnSettled = true
    this._finish('failed', error)
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
    const cost = usage?.cost
    if (maxCostUsd !== null && cost !== undefined && Number.isFinite(cost.amount)) {
      // The budget is denominated in USD; comparing another currency's amount
      // would trip the ceiling at an arbitrary exchange rate. Timeouts still apply.
      const currency = cost.currency?.trim()
      if (currency === undefined || currency.length === 0 || currency.toLowerCase() === 'usd') {
        if (cost.amount >= maxCostUsd) {
          this._finish('budget-exceeded')
          void this._session.cancelTurn().catch(() => undefined)
          return
        }
      } else if (!this._warnedNonUsdCurrency) {
        this._warnedNonUsdCurrency = true
        this._logger?.warn(
          `cost ceiling skipped: agent reports ${currency}, budget is in USD (cost will not stop this run)`,
        )
      }
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

  private _finish(outcome: TriggerRunOutcome, error?: string): void {
    if (this._finished) return
    this._finished = true
    // Snapshot at the terminal moment: the session may report more usage while
    // the async result-file read below is in flight.
    const durationMs = Math.max(0, Math.round(this._activeTotal(this._now())))
    const costUsd = usdCost(this._session.usage.get())
    this._disposeTimers()
    // Terminal bookkeeping must never leave an unhandled rejection: the run is
    // already finished and its outcome is the only signal main receives.
    void this._finalize(outcome, error, durationMs, costUsd).catch((err: unknown) => {
      this._logger?.warn(
        `failed to finalize run ${this._request.origin.runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    })
  }

  private async _finalize(
    outcome: TriggerRunOutcome,
    error: string | undefined,
    durationMs: number,
    costUsd: number | undefined,
  ): Promise<void> {
    // Only a completed turn has a result contract to read; a cancelled / timed-out
    // / failed run must not surface whatever partial file happened to exist.
    let resolution: Pick<TriggerRunEnd, 'verdict' | 'summary'> = {}
    if (outcome === 'completed') {
      let raw: string | undefined
      try {
        raw = await this._readResultFile(this._request)
      } catch {
        raw = undefined
      }
      resolution = resolveResultVerdict(raw)
    }
    const sessionId = this._session.sessionIdOnAgent.get() ?? this._session.id
    const end: TriggerRunEnd = {
      runId: this._request.origin.runId,
      triggerId: this._request.origin.triggerId,
      sessionId,
      outcome,
      ...(resolution.verdict !== undefined ? { verdict: resolution.verdict } : {}),
      ...(resolution.summary !== undefined ? { summary: resolution.summary } : {}),
      ...(error !== undefined ? { error } : {}),
      durationMs,
      ...(costUsd === undefined ? {} : { costUsd }),
    }
    try {
      this._onRunEnd(end)
    } finally {
      this._subscription?.dispose()
      this._subscription = undefined
    }
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

/** The budget is USD-denominated; another currency's amount is not comparable. */
function usdCost(usage: AcpUsage | undefined): number | undefined {
  const cost = usage?.cost
  if (cost === undefined || !Number.isFinite(cost.amount)) return undefined
  const currency = cost.currency?.trim() ?? ''
  if (currency.length > 0 && currency.toLowerCase() !== 'usd') return undefined
  return cost.amount
}
