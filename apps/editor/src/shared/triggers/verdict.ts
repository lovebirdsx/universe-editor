/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Parse and guard the agent-produced `<runDir>/result.json`. Actions are only ever
 *  executed for `auto-approve`, and one bad action downgrades the whole verdict.
 *  Design: docs/development/triggers-design.md §6
 *--------------------------------------------------------------------------------------------*/

import type {
  TriggerActionType,
  TriggerVerdict,
  TriggerVerdictAction,
  TriggerVerdictKind,
} from './types.js'

const VERDICT_KINDS: readonly TriggerVerdictKind[] = ['auto-approve', 'escalate', 'reject', 'info']

const MAX_SUMMARY_LENGTH = 200
const MAX_COMMENT_LENGTH = 4000

export type ParseVerdictResult =
  | { readonly ok: true; readonly verdict: TriggerVerdict }
  | { readonly ok: false; readonly error: string }

export interface ValidateActionsOptions {
  readonly allowedActions: readonly TriggerActionType[]
  /** For swarm sources, the only legal action target (the event's review id). */
  readonly eventTarget?: string
  readonly approveConfirmed?: boolean
}

export interface RejectedAction {
  readonly type: string
  readonly target: string
  readonly reason: string
}

export interface ValidateActionsResult {
  readonly verdict: TriggerVerdict
  readonly rejected: readonly RejectedAction[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Relative, forward/backward slash agnostic, no drive letters, no `..` segment. */
export function isSafeRelativePath(path: string): boolean {
  const value = path.trim()
  if (value.length === 0) return false
  if (value.includes('://')) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(value)) return false
  return value.split(/[\\/]/).every((segment) => segment !== '..')
}

function parseAction(
  raw: unknown,
  index: number,
): { ok: true; action: TriggerVerdictAction } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `actions[${index}] must be an object` }
  const type = raw['type']
  const target = raw['target']
  if (typeof type !== 'string' || type.trim().length === 0) {
    return { ok: false, error: `actions[${index}].type must be a non-empty string` }
  }
  if (typeof target !== 'string' || target.trim().length === 0) {
    return { ok: false, error: `actions[${index}].target must be a non-empty string` }
  }
  let detail: string | undefined
  if (raw['detail'] !== undefined) {
    if (typeof raw['detail'] !== 'string') {
      return { ok: false, error: `actions[${index}].detail must be a string` }
    }
    detail = raw['detail']
  }
  return { ok: true, action: detail === undefined ? { type, target } : { type, target, detail } }
}

export function parseVerdict(raw: string): ParseVerdictResult {
  const text = raw.replace(/^﻿/, '').trim()
  if (text.length === 0) return { ok: false, error: 'result.json is empty' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      error: `result.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!isRecord(parsed)) return { ok: false, error: 'result.json must contain a JSON object' }

  const kind = parsed['verdict']
  if (typeof kind !== 'string' || !VERDICT_KINDS.includes(kind as TriggerVerdictKind)) {
    return { ok: false, error: `"verdict" must be one of ${VERDICT_KINDS.join(' | ')}` }
  }

  let summary = ''
  if (parsed['summary'] !== undefined) {
    if (typeof parsed['summary'] !== 'string') {
      return { ok: false, error: '"summary" must be a string' }
    }
    summary = parsed['summary'].slice(0, MAX_SUMMARY_LENGTH)
  }

  let reportPath: string | undefined
  if (parsed['reportPath'] !== undefined) {
    if (typeof parsed['reportPath'] !== 'string' || !isSafeRelativePath(parsed['reportPath'])) {
      return { ok: false, error: '"reportPath" must be a relative path without ".."' }
    }
    reportPath = parsed['reportPath'].trim()
  }

  const actions: TriggerVerdictAction[] = []
  if (parsed['actions'] !== undefined) {
    if (!Array.isArray(parsed['actions'])) {
      return { ok: false, error: '"actions" must be an array' }
    }
    for (let index = 0; index < parsed['actions'].length; index++) {
      const result = parseAction(parsed['actions'][index], index)
      if (!result.ok) return result
      actions.push(result.action)
    }
  }

  return {
    ok: true,
    verdict: {
      verdict: kind as TriggerVerdictKind,
      summary,
      ...(reportPath === undefined ? {} : { reportPath }),
      actions,
    },
  }
}

function rejectionReason(
  action: TriggerVerdictAction,
  options: ValidateActionsOptions,
): string | undefined {
  if (!(options.allowedActions as readonly string[]).includes(action.type)) {
    return '动作类型不在允许列表内'
  }
  if (options.eventTarget !== undefined && action.target !== options.eventTarget) {
    return '动作目标与事件不匹配'
  }
  switch (action.type) {
    case 'swarm.vote':
      if (action.detail !== 'up' && action.detail !== 'down') {
        return '投票方向必须是 up 或 down'
      }
      return undefined
    case 'swarm.comment': {
      const body = action.detail?.trim() ?? ''
      if (body.length === 0) return '评论内容不能为空'
      if (body.length > MAX_COMMENT_LENGTH) return '评论内容超过 4000 字'
      return undefined
    }
    case 'swarm.approve':
      if (options.approveConfirmed !== true) return '未确认自动 approve'
      return undefined
    default:
      return undefined
  }
}

export function validateActions(
  verdict: TriggerVerdict,
  options: ValidateActionsOptions,
): ValidateActionsResult {
  // Non-auto-approve verdicts never execute actions; this is not a rejection.
  if (verdict.verdict !== 'auto-approve') {
    return { verdict: { ...verdict, actions: [] }, rejected: [] }
  }
  const rejected: RejectedAction[] = []
  for (const action of verdict.actions) {
    const reason = rejectionReason(action, options)
    if (reason !== undefined) rejected.push({ type: action.type, target: action.target, reason })
  }
  if (rejected.length === 0) return { verdict, rejected }
  const detail = rejected
    .map(
      (entry) =>
        `${entry.type}${entry.target.length > 0 ? `(${entry.target})` : ''}: ${entry.reason}`,
    )
    .join('；')
  const summary = `动作校验未通过，已降级为 escalate：${detail}${
    verdict.summary.length > 0 ? `。${verdict.summary}` : ''
  }`
  return {
    verdict: {
      ...verdict,
      verdict: 'escalate',
      summary: summary.slice(0, MAX_SUMMARY_LENGTH),
      actions: [],
    },
    rejected,
  }
}
