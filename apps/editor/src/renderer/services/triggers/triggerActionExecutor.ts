/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Turns an automated run's `result.json` into a verdict and executes the
 *  whitelisted Swarm actions. Actions run in the editor, never in the agent's
 *  session; one rejected / failed action downgrades the whole verdict to
 *  `escalate`. Design §6.
 *--------------------------------------------------------------------------------------------*/

import type { ICommandService, ILogger } from '@universe-editor/platform'
import { SwarmCommands, type SwarmReviewDetailDto } from '@universe-editor/extensions-common'
import type {
  TriggerActionAudit,
  TriggerRunRequest,
  TriggerVerdictAction,
} from '../../../shared/triggers/types.js'
import { parseVerdict, validateActions } from '../../../shared/triggers/verdict.js'
import { canApproveReview } from '../swarm/swarmReviewFilter.js'
import type { AutomatedVerdictResolution, AutomatedVerdictResolver } from './automatedRunWatcher.js'

const MAX_SUMMARY_LENGTH = 200

export interface TriggerActionExecutorOptions {
  readonly commands: ICommandService
  readonly logger?: ILogger
}

/** `[由触发器 <name> 自动生成] ` is prepended so reviewers can tell an
 *  automated comment from a human one. */
export function automatedCommentBody(triggerName: string, detail: string): string {
  return `[由触发器 ${triggerName} 自动生成] ${detail}`
}

/** Latest version number of a review detail, when the list is non-empty. */
export function latestReviewVersion(detail: SwarmReviewDetailDto | undefined): number | undefined {
  const last = detail?.versions[detail.versions.length - 1]
  return last?.version
}

export function createTriggerActionExecutor(
  options: TriggerActionExecutorOptions,
): AutomatedVerdictResolver {
  return async (raw, request) => executeTriggerVerdict(raw, request, options)
}

export async function executeTriggerVerdict(
  raw: string | undefined,
  request: TriggerRunRequest,
  options: TriggerActionExecutorOptions,
): Promise<AutomatedVerdictResolution> {
  const { logger } = options
  if (raw === undefined || raw.trim().length === 0) {
    return { verdict: 'escalate', summary: '未产出结构化结果', actions: [] }
  }
  const parsed = parseVerdict(raw)
  if (!parsed.ok) {
    logger?.debug(`trigger verdict parse failed: ${parsed.error}`)
    return {
      verdict: 'escalate',
      summary: clampSummary(`未产出结构化结果：${parsed.error}`),
      actions: [],
    }
  }

  // Swarm actions target the event's review; a schedule / poll / manual run has
  // no such target, so the whole action batch is rejected before any guard runs.
  if (parsed.verdict.verdict === 'auto-approve' && request.sourceType !== 'swarm-review') {
    const swarmActions = parsed.verdict.actions.filter((action) => action.type.startsWith('swarm.'))
    if (swarmActions.length > 0) {
      const reason = '仅 swarm-review 触发器可执行 Swarm 动作'
      logger?.debug(`trigger actions rejected: ${reason}`)
      return {
        verdict: 'escalate',
        summary: clampSummary(`动作未执行，已降级为 escalate：${reason}`),
        actions: swarmActions.map((action) => ({
          type: action.type,
          target: action.target,
          result: 'rejected' as const,
          reason,
        })),
      }
    }
  }

  const reviewId = request.payload['reviewId']
  const eventTarget = reviewId === undefined ? undefined : String(reviewId)
  const validated = validateActions(parsed.verdict, {
    allowedActions: request.allowedActions,
    ...(eventTarget !== undefined ? { eventTarget } : {}),
    approveConfirmed: request.approveConfirmed,
  })
  const audits: TriggerActionAudit[] = validated.rejected.map((entry) => ({
    type: entry.type,
    target: entry.target,
    result: 'rejected',
    reason: entry.reason,
  }))
  if (validated.verdict.verdict !== 'auto-approve') {
    logger?.debug(`trigger verdict ${validated.verdict.verdict}: no actions executed`)
    return {
      verdict: validated.verdict.verdict,
      summary: validated.verdict.summary,
      actions: audits,
    }
  }

  const version = payloadVersion(request)
  const approveCheck = await checkApproveGuard(
    validated.verdict.actions,
    version,
    payloadUpdated(request),
    options,
  )
  if (approveCheck !== undefined) {
    audits.push({
      type: 'swarm.approve',
      target: approveCheck.target,
      result: 'rejected',
      reason: approveCheck.reason,
    })
    logger?.debug(`trigger action swarm.approve rejected: ${approveCheck.reason}`)
    return {
      verdict: 'escalate',
      summary: clampSummary(`动作未执行，已降级为 escalate：${approveCheck.reason}`),
      actions: audits,
    }
  }

  for (const action of validated.verdict.actions) {
    let outcome: ActionOutcome
    try {
      outcome = await executeAction(action, request, version, options)
    } catch (err) {
      outcome = failed(err instanceof Error ? err.message : String(err))
    }
    if (outcome.ok) {
      audits.push({ type: action.type, target: action.target, result: 'ok' })
      continue
    }
    audits.push({
      type: action.type,
      target: action.target,
      result: outcome.kind,
      reason: outcome.reason,
    })
    logger?.debug(`trigger action ${action.type} ${outcome.kind}: ${outcome.reason}`)
    // Actions are not transactional: what already ran stays applied, so the
    // escalation must state exactly which side effects the user now owns.
    const executed = audits
      .filter((audit) => audit.result === 'ok')
      .map((audit) => `${audit.type}@${audit.target}`)
    const executedNote = executed.length > 0 ? `。已执行：${executed.join(',')}（不可回滚）` : ''
    return {
      verdict: 'escalate',
      summary: clampSummary(
        outcome.kind === 'rejected'
          ? `动作未执行，已降级为 escalate：${outcome.reason}${executedNote}`
          : `动作执行失败，已降级为 escalate：${outcome.reason}${executedNote}`,
      ),
      actions: audits,
    }
  }

  return { verdict: 'auto-approve', summary: validated.verdict.summary, actions: audits }
}

type ActionOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'rejected' | 'failed'; readonly reason: string }

function rejected(reason: string): ActionOutcome {
  return { ok: false, kind: 'rejected', reason }
}

function failed(reason: string): ActionOutcome {
  return { ok: false, kind: 'failed', reason }
}

function payloadVersion(request: TriggerRunRequest): number | undefined {
  const value = request.payload['version']
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function payloadUpdated(request: TriggerRunRequest): number | undefined {
  const value = request.payload['updated']
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Validates the approve TOCTOU guard before ANY action runs.
 *
 * Checking inside `swarm.approve` would misread our own vote / comment as an
 * author re-shelve: both bump the review's `updated` stamp. Running approve
 * first to dodge that is not an option either — Swarm only exposes the approval
 * transition once the required reviewer's own vote landed, so the agent's
 * declared order matters. One pre-flight check keeps that order and still
 * catches changes made during the analysis, which is what the guard is for;
 * the remaining window is the few RPCs spent executing our own actions.
 */
async function checkApproveGuard(
  actions: readonly TriggerVerdictAction[],
  version: number | undefined,
  updated: number | undefined,
  options: TriggerActionExecutorOptions,
): Promise<{ readonly target: string; readonly reason: string } | undefined> {
  const approve = actions.find((action) => action.type === 'swarm.approve')
  if (approve === undefined) return undefined
  const rejected = (reason: string) => ({ target: approve.target, reason })
  if (version === undefined) return rejected('事件缺少审核版本号，无法确认审核未被更新')
  if (updated === undefined) return rejected('事件缺少审核更新时间，无法确认审核未被更新')
  // Re-fetch before approving: the author may have re-shelved between the
  // analysis and this action (TOCTOU), which invalidates the agent's verdict.
  const detail = await options.commands.executeCommand<SwarmReviewDetailDto | undefined>(
    SwarmCommands.getReview,
    { reviewId: approve.target },
    true,
  )
  if (detail === undefined) return rejected('重新拉取审核失败')
  if (!canApproveReview(detail.transitions)) return rejected('当前审核已不可 approve')
  if (latestReviewVersion(detail) !== version) return rejected('审核版本已变化')
  // A re-shelve of an unapproved review keeps the version but moves `updated`.
  if (detail.updated !== updated) return rejected('审核已更新，分析之后作者又提交了改动')
  return undefined
}

async function executeAction(
  action: TriggerVerdictAction,
  request: TriggerRunRequest,
  version: number | undefined,
  options: TriggerActionExecutorOptions,
): Promise<ActionOutcome> {
  const { commands } = options
  switch (action.type) {
    case 'swarm.vote': {
      const vote = action.detail
      if (vote !== 'up' && vote !== 'down') return rejected('投票方向必须是 up 或 down')
      const result = await commands.executeCommand<boolean>(SwarmCommands.vote, {
        reviewId: action.target,
        vote,
        ...(version !== undefined ? { version } : {}),
      })
      return result === true ? { ok: true } : failed('投票命令返回失败')
    }
    case 'swarm.comment': {
      const body = automatedCommentBody(request.origin.triggerName, action.detail ?? '')
      const comment = await commands.executeCommand<{ readonly id?: string } | undefined>(
        SwarmCommands.addComment,
        { reviewId: action.target, body },
      )
      return comment !== undefined ? { ok: true } : failed('评论命令返回失败')
    }
    case 'swarm.approve':
      return executeApprove(action.target, options)
    default:
      return rejected(`不支持的动作类型 ${action.type}`)
  }
}

async function executeApprove(
  reviewId: string,
  options: TriggerActionExecutorOptions,
): Promise<ActionOutcome> {
  // The TOCTOU guard already re-fetched the review for the whole action batch.
  const result = await options.commands.executeCommand<boolean>(SwarmCommands.transition, {
    reviewId,
    state: 'approved',
    // Never commit: automatic approval may not land the change in the depot.
    commit: false,
  })
  return result === true ? { ok: true } : failed('approve 命令返回失败')
}

function clampSummary(summary: string): string {
  return summary.length > MAX_SUMMARY_LENGTH ? summary.slice(0, MAX_SUMMARY_LENGTH) : summary
}
