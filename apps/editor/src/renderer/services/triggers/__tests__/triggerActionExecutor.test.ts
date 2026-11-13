/*---------------------------------------------------------------------------------------------
 *  Tests for the trigger verdict → Swarm action executor: parse failures, action
 *  whitelisting, the per-action guards (vote direction, comment prefix, approve
 *  TOCTOU + forced commit:false), failure downgrades and the audit trail.
 *--------------------------------------------------------------------------------------------*/

import type { ICommandService } from '@universe-editor/platform'
import { SwarmCommands, type SwarmReviewDetailDto } from '@universe-editor/extensions-common'
import { describe, expect, it, vi } from 'vitest'
import type { TriggerRunRequest } from '../../../../shared/triggers/types.js'
import { automatedCommentBody, executeTriggerVerdict } from '../triggerActionExecutor.js'

type Handler = (...args: unknown[]) => unknown

function makeCommands(handlers: Record<string, Handler> = {}) {
  const executeCommand = vi.fn(async (id: string, ...args: unknown[]) => handlers[id]?.(...args))
  return { commands: { executeCommand } as unknown as ICommandService, executeCommand }
}

function makeRequest(overrides: Partial<TriggerRunRequest> = {}): TriggerRunRequest {
  return {
    origin: {
      triggerId: 'swarm-triage',
      triggerName: 'Swarm 分诊',
      eventKey: 'swarm:1001',
      runId: 'run-1',
    },
    cwd: 'X:/workspace',
    allowElevatedMode: false,
    prompt: 'triage it',
    runDir: 'X:/workspace/.runs/run-1',
    budget: { maxCostUsd: 1, timeoutMin: 30, approvalTimeoutMin: 1440 },
    allowedActions: ['swarm.vote', 'swarm.comment', 'swarm.approve'],
    approveConfirmed: true,
    payload: { reviewId: '1001', version: 2, updated: 100 },
    ...overrides,
  }
}

function reviewDetail(overrides: Partial<SwarmReviewDetailDto> = {}): SwarmReviewDetailDto {
  return {
    id: '1001',
    state: 'needsReview',
    stateLabel: 'Needs Review',
    author: 'alice',
    description: 'fix stuff',
    updated: 100,
    versions: [{ version: 2, change: '12', pending: true, time: 1 }],
    participants: [],
    transitions: [{ state: 'approved', label: 'Approve' }],
    commentCount: 0,
    openTaskCount: 0,
    testStatus: 'none',
    ...overrides,
  }
}

const voteUp = JSON.stringify({
  verdict: 'auto-approve',
  summary: 'looks good',
  actions: [{ type: 'swarm.vote', target: '1001', detail: 'up' }],
})

describe('executeTriggerVerdict', () => {
  it('escalates when the agent produced no result file', async () => {
    const { commands, executeCommand } = makeCommands()
    const resolution = await executeTriggerVerdict(undefined, makeRequest(), { commands })
    expect(resolution).toEqual({
      verdict: 'escalate',
      summary: '未产出结构化结果',
      actions: [],
    })
    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('escalates with the parse error when result.json is invalid', async () => {
    const { commands } = makeCommands()
    const resolution = await executeTriggerVerdict('{ not json', makeRequest(), { commands })
    expect(resolution.verdict).toBe('escalate')
    expect(resolution.summary).toContain('未产出结构化结果')
    expect(resolution.summary).toContain('not valid JSON')
    expect(resolution.actions).toEqual([])
  })

  it('keeps non-auto-approve verdicts and never executes actions', async () => {
    const { commands, executeCommand } = makeCommands()
    const raw = JSON.stringify({ verdict: 'info', summary: 'nothing to do' })
    const resolution = await executeTriggerVerdict(raw, makeRequest(), { commands })
    expect(resolution).toMatchObject({ verdict: 'info', summary: 'nothing to do', actions: [] })
    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('executes a whitelisted vote with the event version', async () => {
    const { commands, executeCommand } = makeCommands({
      [SwarmCommands.vote]: () => true,
    })
    const resolution = await executeTriggerVerdict(voteUp, makeRequest(), { commands })
    expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.vote, {
      reviewId: '1001',
      vote: 'up',
      version: 2,
    })
    expect(resolution).toEqual({
      verdict: 'auto-approve',
      summary: 'looks good',
      actions: [{ type: 'swarm.vote', target: '1001', result: 'ok' }],
    })
  })

  it('omits the version when the event carries none', async () => {
    const { commands, executeCommand } = makeCommands({ [SwarmCommands.vote]: () => true })
    await executeTriggerVerdict(voteUp, makeRequest({ payload: { reviewId: '1001' } }), {
      commands,
    })
    expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.vote, {
      reviewId: '1001',
      vote: 'up',
    })
  })

  it('prefixes comments with the trigger provenance', async () => {
    const raw = JSON.stringify({
      verdict: 'auto-approve',
      summary: '',
      actions: [{ type: 'swarm.comment', target: '1001', detail: 'please fix the test' }],
    })
    const { commands, executeCommand } = makeCommands({
      [SwarmCommands.addComment]: () => ({ id: 'c-1' }),
    })
    const resolution = await executeTriggerVerdict(raw, makeRequest(), { commands })
    expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.addComment, {
      reviewId: '1001',
      body: automatedCommentBody('Swarm 分诊', 'please fix the test'),
    })
    expect(resolution.actions).toEqual([{ type: 'swarm.comment', target: '1001', result: 'ok' }])
  })

  it('approves only after re-fetching a still-approvable, unchanged review', async () => {
    const raw = JSON.stringify({
      verdict: 'auto-approve',
      summary: '',
      actions: [{ type: 'swarm.approve', target: '1001' }],
    })
    const { commands, executeCommand } = makeCommands({
      [SwarmCommands.getReview]: () => reviewDetail(),
      [SwarmCommands.transition]: () => true,
    })
    const resolution = await executeTriggerVerdict(raw, makeRequest(), { commands })
    expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.getReview, { reviewId: '1001' }, true)
    expect(executeCommand).toHaveBeenCalledWith(SwarmCommands.transition, {
      reviewId: '1001',
      state: 'approved',
      commit: false,
    })
    expect(resolution.verdict).toBe('auto-approve')
  })

  it('refuses to approve when the event has no updated stamp', async () => {
    const raw = JSON.stringify({
      verdict: 'auto-approve',
      summary: '',
      actions: [{ type: 'swarm.approve', target: '1001' }],
    })
    const { commands, executeCommand } = makeCommands({
      [SwarmCommands.getReview]: () => reviewDetail(),
      [SwarmCommands.transition]: () => true,
    })
    const resolution = await executeTriggerVerdict(
      raw,
      makeRequest({ payload: { reviewId: '1001', version: 2 } }),
      { commands },
    )
    expect(executeCommand).not.toHaveBeenCalled()
    expect(resolution.verdict).toBe('escalate')
    expect(resolution.summary).toContain('更新时间')
    expect(resolution.actions).toEqual([
      { type: 'swarm.approve', target: '1001', result: 'rejected', reason: expect.any(String) },
    ])
  })

  // A re-shelve of an unapproved review keeps the same version, so the version
  // check alone would approve changes the agent never saw.
  it('refuses to approve when the review was re-shelved without a version bump', async () => {
    const raw = JSON.stringify({
      verdict: 'auto-approve',
      summary: '',
      actions: [{ type: 'swarm.approve', target: '1001' }],
    })
    const { commands, executeCommand } = makeCommands({
      [SwarmCommands.getReview]: () => reviewDetail({ updated: 101 }),
      [SwarmCommands.transition]: () => true,
    })
    const resolution = await executeTriggerVerdict(raw, makeRequest(), { commands })
    expect(executeCommand).not.toHaveBeenCalledWith(SwarmCommands.transition, expect.anything())
    expect(resolution.verdict).toBe('escalate')
    expect(resolution.summary).toContain('审核已更新')
  })

  // The guard runs before any action: our own vote / comment bumps the review's
  // updated stamp, so a per-action check would reject a legitimate batch.
  it('runs the approve guard before its own vote in the same batch', async () => {
    const raw = JSON.stringify({
      verdict: 'auto-approve',
      summary: '',
      actions: [
        { type: 'swarm.vote', target: '1001', detail: 'up' },
        { type: 'swarm.approve', target: '1001' },
      ],
    })
    const { commands, executeCommand } = makeCommands({
      [SwarmCommands.getReview]: () => reviewDetail(),
      [SwarmCommands.vote]: () => true,
      [SwarmCommands.transition]: () => true,
    })
    const resolution = await executeTriggerVerdict(raw, makeRequest(), { commands })
    expect(executeCommand.mock.calls.map((call) => call[0])).toEqual([
      SwarmCommands.getReview,
      SwarmCommands.vote,
      SwarmCommands.transition,
    ])
    expect(resolution.verdict).toBe('auto-approve')
    expect(resolution.actions).toEqual([
      { type: 'swarm.vote', target: '1001', result: 'ok' },
      { type: 'swarm.approve', target: '1001', result: 'ok' },
    ])
  })

  it('executes no action when the pre-flight approve guard fails', async () => {
    const raw = JSON.stringify({
      verdict: 'auto-approve',
      summary: '',
      actions: [
        { type: 'swarm.vote', target: '1001', detail: 'up' },
        { type: 'swarm.approve', target: '1001' },
      ],
    })
    const { commands, executeCommand } = makeCommands({
      [SwarmCommands.getReview]: () => reviewDetail({ transitions: [] }),
      [SwarmCommands.vote]: () => true,
      [SwarmCommands.transition]: () => true,
    })
    const resolution = await executeTriggerVerdict(raw, makeRequest(), { commands })
    expect(executeCommand).not.toHaveBeenCalledWith(SwarmCommands.vote, expect.anything())
    expect(resolution.verdict).toBe('escalate')
    expect(resolution.actions).toEqual([
      {
        type: 'swarm.approve',
        target: '1001',
        result: 'rejected',
        reason: '当前审核已不可 approve',
      },
    ])
  })

  it('refuses to approve when the event has no version', async () => {
    const raw = JSON.stringify({
      verdict: 'auto-approve',
      summary: '',
      actions: [{ type: 'swarm.approve', target: '1001' }],
    })
    const { commands, executeCommand } = makeCommands({
      [SwarmCommands.getReview]: () => reviewDetail(),
      [SwarmCommands.transition]: () => true,
    })
    const resolution = await executeTriggerVerdict(
      raw,
      makeRequest({ payload: { reviewId: '1001' } }),
      { commands },
    )
    expect(executeCommand).not.toHaveBeenCalled()
    expect(resolution.verdict).toBe('escalate')
    expect(resolution.summary).toContain('版本号')
    expect(resolution.actions).toEqual([
      { type: 'swarm.approve', target: '1001', result: 'rejected', reason: expect.any(String) },
    ])
  })

  it('refuses to approve when the review moved past the event version', async () => {
    const raw = JSON.stringify({
      verdict: 'auto-approve',
      summary: '',
      actions: [{ type: 'swarm.approve', target: '1001' }],
    })
    const { commands, executeCommand } = makeCommands({
      [SwarmCommands.getReview]: () =>
        reviewDetail({ versions: [{ version: 3, change: '13', pending: true, time: 2 }] }),
      [SwarmCommands.transition]: () => true,
    })
    const resolution = await executeTriggerVerdict(raw, makeRequest(), { commands })
    expect(executeCommand).not.toHaveBeenCalledWith(SwarmCommands.transition, expect.anything())
    expect(resolution.verdict).toBe('escalate')
    expect(resolution.summary).toContain('版本已变化')
  })

  it('refuses to approve when the review is no longer approvable', async () => {
    const raw = JSON.stringify({
      verdict: 'auto-approve',
      summary: '',
      actions: [{ type: 'swarm.approve', target: '1001' }],
    })
    const { commands, executeCommand } = makeCommands({
      [SwarmCommands.getReview]: () => reviewDetail({ transitions: [] }),
      [SwarmCommands.transition]: () => true,
    })
    const resolution = await executeTriggerVerdict(raw, makeRequest(), { commands })
    expect(executeCommand).not.toHaveBeenCalledWith(SwarmCommands.transition, expect.anything())
    expect(resolution.verdict).toBe('escalate')
    expect(resolution.summary).toContain('不可 approve')
  })

  it('downgrades to escalate and audits a rejected action', async () => {
    const raw = JSON.stringify({
      verdict: 'auto-approve',
      summary: 'ok',
      actions: [{ type: 'swarm.vote', target: '9999', detail: 'up' }],
    })
    const { commands, executeCommand } = makeCommands({ [SwarmCommands.vote]: () => true })
    const resolution = await executeTriggerVerdict(raw, makeRequest(), { commands })
    expect(executeCommand).not.toHaveBeenCalled()
    expect(resolution.verdict).toBe('escalate')
    expect(resolution.summary).toContain('动作校验未通过')
    expect(resolution.actions).toEqual([
      { type: 'swarm.vote', target: '9999', result: 'rejected', reason: '动作目标与事件不匹配' },
    ])
  })

  it('rejects actions outside the allowed list', async () => {
    const raw = JSON.stringify({
      verdict: 'auto-approve',
      summary: '',
      actions: [{ type: 'swarm.approve', target: '1001' }],
    })
    const { commands, executeCommand } = makeCommands()
    const resolution = await executeTriggerVerdict(
      raw,
      makeRequest({ allowedActions: ['swarm.vote'] }),
      { commands },
    )
    expect(executeCommand).not.toHaveBeenCalled()
    expect(resolution.verdict).toBe('escalate')
    expect(resolution.actions[0]).toMatchObject({
      result: 'rejected',
      reason: '动作类型不在允许列表内',
    })
  })

  it('stops at the first failed command and downgrades the verdict', async () => {
    const raw = JSON.stringify({
      verdict: 'auto-approve',
      summary: '',
      actions: [
        { type: 'swarm.vote', target: '1001', detail: 'up' },
        { type: 'swarm.comment', target: '1001', detail: 'hello' },
      ],
    })
    const { commands } = makeCommands({
      [SwarmCommands.vote]: () => false,
      [SwarmCommands.addComment]: () => ({ id: 'c-1' }),
    })
    const resolution = await executeTriggerVerdict(raw, makeRequest(), { commands })
    expect(resolution.verdict).toBe('escalate')
    expect(resolution.actions).toEqual([
      { type: 'swarm.vote', target: '1001', result: 'failed', reason: '投票命令返回失败' },
    ])
  })

  it('treats a thrown command as a failed action', async () => {
    const raw = JSON.stringify({
      verdict: 'auto-approve',
      summary: '',
      actions: [{ type: 'swarm.vote', target: '1001', detail: 'down' }],
    })
    const { commands } = makeCommands({
      [SwarmCommands.vote]: () => {
        throw new Error('swarm offline')
      },
    })
    const resolution = await executeTriggerVerdict(raw, makeRequest(), { commands })
    expect(resolution.verdict).toBe('escalate')
    expect(resolution.actions).toEqual([
      { type: 'swarm.vote', target: '1001', result: 'failed', reason: 'swarm offline' },
    ])
  })

  it('executes multiple actions in order and audits each', async () => {
    const raw = JSON.stringify({
      verdict: 'auto-approve',
      summary: 'ship it',
      actions: [
        { type: 'swarm.vote', target: '1001', detail: 'up' },
        { type: 'swarm.comment', target: '1001', detail: 'LGTM' },
      ],
    })
    const { commands, executeCommand } = makeCommands({
      [SwarmCommands.vote]: () => true,
      [SwarmCommands.addComment]: () => ({ id: 'c-1' }),
    })
    const resolution = await executeTriggerVerdict(raw, makeRequest(), { commands })
    expect(executeCommand.mock.calls.map((call) => call[0])).toEqual([
      SwarmCommands.vote,
      SwarmCommands.addComment,
    ])
    expect(resolution).toEqual({
      verdict: 'auto-approve',
      summary: 'ship it',
      actions: [
        { type: 'swarm.vote', target: '1001', result: 'ok' },
        { type: 'swarm.comment', target: '1001', result: 'ok' },
      ],
    })
  })
})
