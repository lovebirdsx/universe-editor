/*---------------------------------------------------------------------------------------------
 *  Tests for AgentNotificationContribution — verifies OS notifications fire on the
 *  right session edges (permission / question / completion / error), de-dupe per
 *  turn, respect the enable flag, and jump to the session when clicked.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  observableValue,
  type ISettableObservable,
  type ISystemNotificationResult,
} from '@universe-editor/platform'
import { AgentNotificationContribution } from '../AgentNotificationContribution.js'
import type {
  IAcpSessionService,
  IAcpSession,
} from '../../services/acp/session/acpSessionService.js'
import type {
  AcpSessionStatus,
  AcpPlanEntry,
  AcpPendingPermission,
  AcpPendingElicitation,
} from '../../services/acp/session/acpSession.js'

interface FakeSession {
  id: string
  title: string
  status: ISettableObservable<AcpSessionStatus>
  pendingPermission: ISettableObservable<AcpPendingPermission | undefined>
  pendingElicitation: ISettableObservable<AcpPendingElicitation | undefined>
  plan: ISettableObservable<readonly AcpPlanEntry[]>
  isDormant: ISettableObservable<boolean>
  backgroundTaskCount: ISettableObservable<number>
}

function makeSession(id: string, title = id): FakeSession {
  return {
    id,
    title,
    status: observableValue<AcpSessionStatus>(`status.${id}`, 'idle'),
    pendingPermission: observableValue<AcpPendingPermission | undefined>(`perm.${id}`, undefined),
    pendingElicitation: observableValue<AcpPendingElicitation | undefined>(`eli.${id}`, undefined),
    plan: observableValue<readonly AcpPlanEntry[]>(`plan.${id}`, []),
    isDormant: observableValue<boolean>(`dormant.${id}`, false),
    backgroundTaskCount: observableValue<number>(`bg.${id}`, 0),
  }
}

function planEntry(status: AcpPlanEntry['status']): AcpPlanEntry {
  return { content: 'step', status } as AcpPlanEntry
}

function setup(opts?: { enabled?: boolean; clicked?: boolean; workspaceName?: string }) {
  const enabled = opts?.enabled ?? true
  const sessionsObs = observableValue<readonly IAcpSession[]>('sessions', [])
  const notify = vi.fn(
    async (_opts: {
      title: string
      body: string
      onlyWhenBlurred?: boolean
    }): Promise<ISystemNotificationResult> => ({
      shown: true,
      clicked: opts?.clicked ?? false,
    }),
  )
  const focusWindow = vi.fn(async () => {})
  const setActive = vi.fn()
  const openEditor = vi.fn()
  const focusSessionInput = vi.fn()

  const sessions = {
    sessions: sessionsObs,
    setActive,
    // The clicked session is always live — the watcher is fed from the same list.
    getById: (id: string) => ({ id, agentId: 'fake' }) as unknown as IAcpSession,
  } as unknown as IAcpSessionService
  const host = { notify, focusWindow } as never
  const config = { get: () => enabled } as never
  const activeGroup = { openEditor }
  const groups = { groups: [], activeGroup, activeGroupForOpen: activeGroup } as never
  const inst = { createInstance: vi.fn((id: string) => ({ id })) } as never
  const widgets = { focusSessionInput } as never
  const workspace = {
    current: opts?.workspaceName !== undefined ? { name: opts.workspaceName } : null,
  } as never

  const contribution = new AgentNotificationContribution(
    sessions,
    host,
    config,
    groups,
    inst,
    widgets,
    workspace,
  )

  return {
    contribution,
    sessionsObs,
    notify,
    focusWindow,
    setActive,
    openEditor,
    focusSessionInput,
    addSession: (s: FakeSession) =>
      sessionsObs.set(
        [...(sessionsObs.get() as IAcpSession[]), s as unknown as IAcpSession],
        undefined,
      ),
  }
}

describe('AgentNotificationContribution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // revealSessionChat schedules a second focus pass on the next frame; the
    // node environment has no rAF, and the sync pass is what these tests assert.
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 0),
    )
  })

  it('fires a completion notification when status goes running → idle', () => {
    const t = setup()
    const s = makeSession('a')
    t.addSession(s)
    s.status.set('running', undefined)
    s.status.set('idle', undefined)
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: 'a' })
  })

  it('fires an error notification when status goes → errored', () => {
    const t = setup()
    const s = makeSession('a')
    t.addSession(s)
    s.status.set('running', undefined)
    s.status.set('errored', undefined)
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it('fires once on permission rising edge, not again while pending', () => {
    const t = setup()
    const s = makeSession('a')
    t.addSession(s)
    s.pendingPermission.set({ toolCallId: 't', title: 'x', options: [] } as never, undefined)
    // An unrelated change re-runs the autorun but must not re-notify.
    s.status.set('running', undefined)
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it('skips the permission notification when the plan card auto-executes', () => {
    const t = setup()
    const s = makeSession('a')
    t.addSession(s)
    s.status.set('running', undefined)
    // `acp.plan.autoExecute` 非 off 时 service 给 plan 审查卡附 autoResolve：
    // 卡片自己倒计时继续，用户无需介入，不该被拉回窗口。
    s.pendingPermission.set(
      {
        toolCallId: 't',
        title: 'Ready to code?',
        kind: 'switch_mode',
        options: [],
        autoResolve: { optionId: 'bypassPermissions', delayMs: 3000 },
      } as never,
      undefined,
    )
    expect(t.notify).not.toHaveBeenCalled()
    // 自动继续后回 idle 仍照常通知任务完成。
    s.pendingPermission.set(undefined, undefined)
    s.status.set('idle', undefined)
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it('still fires for a plan card that waits for a manual choice', () => {
    const t = setup()
    const s = makeSession('a')
    t.addSession(s)
    s.pendingPermission.set(
      { toolCallId: 't', title: 'Ready to code?', kind: 'switch_mode', options: [] } as never,
      undefined,
    )
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it('fires once on elicitation rising edge', () => {
    const t = setup()
    const s = makeSession('a')
    t.addSession(s)
    s.pendingElicitation.set({ request: {} } as never, undefined)
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it('de-dupes completion: plan all-complete while running does not fire; idle fires only once', () => {
    const t = setup()
    const s = makeSession('a')
    t.addSession(s)
    s.status.set('running', undefined)
    s.plan.set([planEntry('in_progress')], undefined)
    s.plan.set([planEntry('completed')], undefined)
    // Plan check-off lands mid-turn; only the idle edge announces completion.
    expect(t.notify).not.toHaveBeenCalled()
    s.status.set('idle', undefined)
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it('does not fire completion while the plan is all-complete but the turn is still running', () => {
    const t = setup()
    const s = makeSession('a')
    t.addSession(s)
    s.status.set('running', undefined)
    s.plan.set([planEntry('completed')], undefined)
    expect(t.notify).not.toHaveBeenCalled()
    s.status.set('idle', undefined)
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it('does not notify when acp.notifications.enabled is false', () => {
    const t = setup({ enabled: false })
    const s = makeSession('a')
    t.addSession(s)
    s.status.set('running', undefined)
    s.status.set('idle', undefined)
    expect(t.notify).not.toHaveBeenCalled()
  })

  it('on click: activates the session and reveals its chat with the input focused', async () => {
    const t = setup({ clicked: true })
    const s = makeSession('a')
    t.addSession(s)
    s.status.set('running', undefined)
    s.status.set('idle', undefined)
    // Let the notify promise resolve and the click handler run.
    await Promise.resolve()
    await Promise.resolve()
    // Window focus happens main-side inside the click handler, not here.
    expect(t.setActive).toHaveBeenCalledWith('a')
    expect(t.focusSessionInput).toHaveBeenCalledWith('a')
    // No tab was open for it yet, so the chat is opened in the active group.
    expect(t.openEditor).toHaveBeenCalledTimes(1)
  })

  it('includes the workspace folder name on a second body line when a folder is open', () => {
    const t = setup({ workspaceName: 'universe-editor4' })
    const s = makeSession('a', 'fix the login spinner')
    t.addSession(s)
    s.status.set('running', undefined)
    s.status.set('idle', undefined)
    expect(t.notify.mock.calls[0]![0]).toMatchObject({
      body: 'fix the login spinner\nuniverse-editor4',
    })
  })

  it('does not announce completion while background tasks outlive the turn', () => {
    const t = setup()
    const s = makeSession('a')
    t.addSession(s)
    s.status.set('running', undefined)
    // `run_in_background` 任务在 turn 结束的瞬间仍在跑：prompt RPC 已 settle
    // （核心状态落到 idle），但派生状态是 'background' —— 报"已完成"是假信号。
    s.backgroundTaskCount.set(1, undefined)
    s.status.set('idle', undefined)
    expect(t.notify).not.toHaveBeenCalled()
    // 后台任务真正跑完，此刻才算完成——旧逻辑在这里反而一声不吭。
    s.backgroundTaskCount.set(0, undefined)
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: 'a' })
  })

  // The regression this pins: every new, resumed or woken session settles from
  // the handshake straight to 'idle' with no turn ever having run. Reading
  // 'connecting' as the prior state announced a completion for work that never
  // happened — once per session, on the most ordinary path there is.
  it('does not announce completion when a fresh session settles from the handshake', () => {
    const t = setup()
    const s = makeSession('a')
    s.status.set('connecting', undefined)
    t.addSession(s)
    s.status.set('idle', undefined)
    expect(t.notify).not.toHaveBeenCalled()
  })

  it('re-arms the completion latch for a background task started after the turn settled', () => {
    // Defensive rather than a real timeline: a background task is reported by
    // the agent as it starts, so its count is already 1 by the time the prompt
    // RPC settles (that path is the test above). This pins the latch re-arming
    // on the background edge itself, in case a task ever surfaces late.
    const t = setup()
    const s = makeSession('a')
    t.addSession(s)
    s.status.set('running', undefined)
    s.status.set('idle', undefined)
    expect(t.notify).toHaveBeenCalledTimes(1)
    // A later background task keeps the session working; its finish is the next
    // completion edge, not a second announcement of the same turn.
    s.backgroundTaskCount.set(1, undefined)
    expect(t.notify).toHaveBeenCalledTimes(1)
    s.backgroundTaskCount.set(0, undefined)
    expect(t.notify).toHaveBeenCalledTimes(2)
  })

  it('stops watching a session once it leaves the list', () => {
    const t = setup()
    const s = makeSession('a')
    t.addSession(s)
    t.sessionsObs.set([], undefined)
    s.status.set('running', undefined)
    s.status.set('idle', undefined)
    expect(t.notify).not.toHaveBeenCalled()
  })
})
