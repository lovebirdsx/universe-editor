import { normalizePlatform } from '@universe-editor/platform'
import { UriIdentityService } from '@universe-editor/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IAcpSession } from '../../acp/session/acpSession.js'
import type {
  DeliveryGitInspectData,
  DeliveryGitPickData,
  ISessionDeliveryGit,
} from '../sessionDeliveryGit.js'
import type { SessionDeliveryRecord } from '../sessionDeliveryTypes.js'
import type { ISessionDeliveryStore } from '../sessionDeliveryStore.js'
import {
  DELIVERABLE_CHANGES_TIMEOUT_MS,
  DELIVERABLE_CHANGES_TTL_MS,
  SessionDeliveryService,
} from '../sessionDeliveryService.js'

const COMMIT = {
  sha: 'c1',
  shortSha: 'c1',
  subject: 'feat: deliver me',
  author: 'testuser',
  authoredAt: '2026-01-01T00:00:00.000Z',
}

function value<T>(current: T): { get(): T } {
  return { get: () => current }
}

type BeginResult = Awaited<ReturnType<ISessionDeliveryGit['begin']>>

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeSession(overrides: Partial<Record<keyof IAcpSession, unknown>> = {}): IAcpSession {
  return {
    id: 's1',
    agentId: 'claude',
    title: 'Task',
    cwd: '/repo/feature',
    readOnly: false,
    internal: false,
    status: value('idle'),
    isDormant: value(false),
    pendingPermission: value(undefined),
    pendingElicitation: value(undefined),
    forkSupported: value(true),
    sessionIdOnAgent: value('durable-1'),
    messages: value([]),
    sendPrompt: vi.fn(async () => {}),
    cancelTurn: vi.fn(async () => {}),
    ...overrides,
  } as unknown as IAcpSession
}

function inspectData(overrides: Partial<DeliveryGitInspectData> = {}): DeliveryGitInspectData {
  return {
    repository: {
      commonDir: '/repo/.git',
      mainWorktree: '/repo',
      mainBranch: 'main',
      targetBranch: 'main',
      remote: 'origin',
      remoteBranch: 'main',
      upstreamRef: 'origin/main',
      mainHead: 'm1',
      upstreamHead: 'u1',
      aheadOfUpstream: 0,
      behindUpstream: 0,
      canFastForward: true,
    },
    source: {
      worktree: '/repo/feature',
      branch: 'feature',
      head: 's1',
      dirty: false,
      changedFileCount: 0,
      untrackedCount: 0,
      isMainWorktree: false,
    },
    commits: [COMMIT],
    baseSha: 'm1',
    blockers: [],
    warnings: [],
    ...overrides,
  }
}

function pickData(overrides: Partial<DeliveryGitPickData> = {}): DeliveryGitPickData {
  return {
    status: 'picked',
    tempWorktree: '/repo/.delivery/wt',
    tempHead: 'picked1',
    picked: [COMMIT],
    skippedEmpty: [],
    remainingCommits: [],
    conflictFiles: [],
    ...overrides,
  }
}

function makeGit(overrides: Partial<ISessionDeliveryGit> = {}): ISessionDeliveryGit {
  return {
    inspect: vi.fn(async () => ({ ok: true, ...inspectData() })),
    hasPendingWork: vi.fn(async () => ({
      ok: true,
      pending: false,
      dirty: false,
      commitCount: 0,
    })),
    acquireLock: vi.fn(async () => ({ ok: true, acquired: true })),
    heartbeatLock: vi.fn(async () => ({ ok: true, heartbeatAt: 'now' })),
    releaseLock: vi.fn(async () => ({ ok: true, released: true })),
    begin: vi.fn(async () => ({
      ok: true,
      mainHeadBefore: 'm1',
      mainHeadAfter: 'm2',
      upstreamHead: 'u1',
      mainBranch: 'main',
      remote: 'origin',
      upstreamRef: 'origin/main',
      fetched: true,
    })),
    commitSource: vi.fn(async () => ({ ok: true, head: 's2', commit: COMMIT })),
    preparePick: vi.fn(async () => ({ ok: true, ...pickData() })),
    continuePick: vi.fn(async () => ({ ok: true, ...pickData() })),
    abortPick: vi.fn(async () => ({ ok: true, removed: true })),
    promoteAndPush: vi.fn(async () => ({
      ok: true,
      pushedSha: 'picked1',
      mainHead: 'picked1',
      remoteRef: 'origin/main',
    })),
    restoreMain: vi.fn(async () => ({ ok: true, head: 'm1' })),
    syncWorktrees: vi.fn(async () => ({
      ok: true,
      results: [
        {
          name: 'feature',
          path: '/repo/feature',
          branch: 'feature',
          status: 'synced',
        },
      ],
    })),
    undo: vi.fn(async () => ({
      ok: true,
      mainHead: 'm3',
      revertedShas: ['c1'],
      remoteRef: 'origin/main',
    })),
    changeContext: vi.fn(async () => ({
      ok: true,
      files: [{ path: 'src/a.ts', status: 'M', diff: '+a' }],
      totalFiles: 1,
      truncated: false,
      fingerprint: 'fp1',
      statusText: ' M src/a.ts',
    })),
    ...overrides,
  } as unknown as ISessionDeliveryGit
}

function record(overrides: Partial<SessionDeliveryRecord> = {}): SessionDeliveryRecord {
  return {
    id: 'd1',
    repositoryKey: 'repo-key',
    commonDir: '/repo/.git',
    phase: 'awaiting_push',
    createdAt: 1,
    updatedAt: 2,
    attempt: 1,
    source: {
      sessionLocalId: 's1',
      sessionDurableId: 'durable-1',
      agentId: 'claude',
      cwd: '/repo/feature',
      worktree: '/repo/feature',
      head: 's1',
    },
    target: {
      mainWorktree: '/repo',
      mainBranch: 'main',
      targetBranch: 'main',
      remote: 'origin',
      remoteBranch: 'main',
      upstreamRef: 'origin/main',
      baseSha: 'm1',
      upstreamHead: 'u1',
      aheadOfUpstream: 0,
    },
    sourceDirty: false,
    commits: [COMMIT],
    skippedEmpty: [],
    tempWorktree: '/repo/.delivery/wt',
    tempHead: 'picked1',
    conflictFiles: [],
    mainHeadBefore: 'm1',
    mainHeadAfter: 'm2',
    syncResults: [],
    lockToken: 'token-1',
    ...overrides,
  }
}

function makeStore(records: readonly SessionDeliveryRecord[] = []): ISessionDeliveryStore {
  const state = { version: 1, records }
  return {
    listRepositoryKeys: vi.fn(async () => (records.length > 0 ? ['repo-key'] : [])),
    readRepository: vi.fn(async () => (records.length > 0 ? state : undefined)),
    writeRepository: vi.fn(async () => {}),
    rememberRepository: vi.fn(async () => {}),
  } as unknown as ISessionDeliveryStore
}

const sessionsService = (session: IAcpSession | undefined, extra: Record<string, unknown> = {}) =>
  ({
    getById: vi.fn((id: string) => (id === session?.id ? session : undefined)),
    createSession: vi.fn(),
    forkSideTask: vi.fn(),
    resumeSession: vi.fn(),
    ...extra,
  }) as never

function makeService(
  options: {
    session?: IAcpSession | undefined
    git?: ISessionDeliveryGit
    store?: ISessionDeliveryStore
    sessions?: Record<string, unknown>
  } = {},
): SessionDeliveryService {
  const session = options.session ?? makeSession()
  return new SessionDeliveryService(
    sessionsService(session, options.sessions),
    { get: vi.fn(() => undefined) } as never,
    options.git ?? makeGit(),
    options.store ?? makeStore(),
    { openFolder: vi.fn(async () => {}) } as never,
    new UriIdentityService(normalizePlatform('linux')),
    {
      createLogger: () => ({
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        error: vi.fn(),
      }),
    } as never,
  )
}

async function previewOf(service: SessionDeliveryService) {
  const preview = await service.preview('s1')
  if (!preview.ok) throw new Error(`preview failed: ${preview.error.code}`)
  return preview.preview
}

let active: SessionDeliveryService | undefined

afterEach(() => {
  active?.dispose()
  active = undefined
})

describe('SessionDeliveryService preview', () => {
  it('projects commits, heads and the pinned expectation', async () => {
    active = makeService()
    const preview = await previewOf(active)

    expect(preview.commits).toEqual([COMMIT])
    expect(preview.expectation).toMatchObject({
      mainHead: 'm1',
      upstreamHead: 'u1',
      sourceHead: 's1',
      baseSha: 'm1',
      commits: ['c1'],
    })
    expect(preview.blockers).toEqual([])
  })

  it('blocks a commit range larger than the phone protocol accepts', async () => {
    const commits = Array.from({ length: 201 }, (_, index) => ({
      ...COMMIT,
      sha: `c${index}`,
      shortSha: `c${index}`,
    }))
    const git = makeGit({
      inspect: vi.fn(async () => ({ ok: true, ...inspectData({ commits }) }) as const),
    })
    active = makeService({ git })

    const preview = await previewOf(active)
    expect(preview.blockers.map((blocker) => blocker.code)).toContain('unsupported')
    expect(preview.blockers.some((blocker) => blocker.message.includes('201'))).toBe(true)
  })

  it('blocks a dirty source when the agent cannot fork a message side task', async () => {
    const git = makeGit({
      inspect: vi.fn(
        async () =>
          ({
            ok: true,
            ...inspectData({ source: { ...inspectData().source, dirty: true } }),
          }) as const,
      ),
    } as never)
    active = makeService({ git, session: makeSession({ forkSupported: value(false) }) })

    const preview = await previewOf(active)
    expect(preview.forkSupported).toBe(false)
    expect(preview.blockers.map((blocker) => blocker.code)).toContain('unsupported')
  })

  it('reports its own running delivery instead of another one', async () => {
    const git = makeGit()
    active = makeService({ git })
    const preview = await previewOf(active)
    await active.start('s1', preview.expectation)

    const blocked = await active.preview('s1')
    expect(blocked.ok).toBe(true)
    if (blocked.ok) {
      expect(blocked.preview.blockers).toContainEqual(
        expect.objectContaining({
          code: 'busy',
          message: 'This session already has an active delivery.',
        }),
      )
    }
  })

  it('blocks preview while another session delivers the same repository', async () => {
    const first = makeSession()
    const second = makeSession({
      id: 's2',
      cwd: '/repo/other',
      sessionIdOnAgent: value('durable-2'),
    })
    const git = makeGit({
      inspect: vi.fn(async (input: { sourceCwd: string }) => {
        const base = inspectData()
        return {
          ok: true,
          ...inspectData({
            source:
              input.sourceCwd === '/repo/other'
                ? { ...base.source, worktree: '/repo/other', branch: 'other', head: 'o1' }
                : base.source,
          }),
        } as const
      }),
    })
    active = makeService({
      session: first,
      git,
      sessions: {
        getById: vi.fn((id: string) => (id === 's1' ? first : id === 's2' ? second : undefined)),
      },
    })

    const otherPreview = await active.preview('s2')
    if (!otherPreview.ok) throw new Error('preview failed')
    const started = await active.start('s2', otherPreview.preview.expectation)
    expect(started.ok).toBe(true)

    const blocked = await active.preview('s1')
    expect(blocked.ok).toBe(true)
    if (blocked.ok) {
      expect(blocked.preview.blockers).toContainEqual(
        expect.objectContaining({
          code: 'busy',
          message: 'Another delivery is already running for this repository.',
        }),
      )
    }
  })
})

describe('SessionDeliveryService start', () => {
  it('reaches awaiting_push with a clean source worktree', async () => {
    const git = makeGit()
    active = makeService({ git })
    const preview = await previewOf(active)

    const started = await active.start('s1', preview.expectation)
    expect(started.ok).toBe(true)
    if (!started.ok) return

    expect(git.begin).toHaveBeenCalledTimes(1)
    expect(git.preparePick).toHaveBeenCalledTimes(1)
    const summary = active.getSummaryForSession('s1', 'durable-1')
    expect(summary).toMatchObject({ phase: 'awaiting_push', commitCount: 1, canConfirmPush: true })
    expect(active.getDetail(started.value.deliveryId)?.target.mainWorktreeName).toBe('repo')
    expect(active.listActiveContexts()).toHaveLength(1)
  })

  it('aborts the temp worktree when preparePick fails without a path', async () => {
    const git = makeGit({
      preparePick: vi.fn(
        async () =>
          ({
            ok: false,
            error: { code: 'git_failed', message: 'extension host disconnected' },
          }) as const,
      ),
    })
    active = makeService({ git })
    const preview = await previewOf(active)

    const started = await active.start('s1', preview.expectation)

    expect(started.ok).toBe(false)
    if (!started.ok) expect(started.error.code).toBe('git_failed')
    // Prepare died before reporting a path; the abort must still be issued so
    // the git extension can derive it from the delivery id.
    expect(git.abortPick).toHaveBeenCalledWith({
      commonDir: '/repo/.git',
      deliveryId: expect.any(String),
      token: expect.any(String),
      mainWorktree: '/repo',
    })
    expect(active.getSummaryForSession('s1')?.phase).toBe('failed')
  })

  it('commits dirty changes with the side-task message before picking', async () => {
    const sideTask = makeSession({
      id: 'side-1',
      internal: true,
      messages: value([{ role: 'agent', text: 'feat: generated subject\n\nbody' }]),
    })
    const session = makeSession()
    const git = makeGit({
      inspect: vi.fn(
        async () =>
          ({
            ok: true,
            ...inspectData({
              source: { ...inspectData().source, dirty: true, changedFileCount: 1 },
            }),
          }) as const,
      ),
    })
    const forkSideTask = vi.fn(async () => sideTask)
    active = makeService({
      session,
      git,
      sessions: {
        forkSideTask,
        getById: vi.fn((id: string) => (id === 's1' ? session : undefined)),
      },
    })
    const preview = await previewOf(active)

    const started = await active.start('s1', preview.expectation)
    expect(started.ok).toBe(true)
    expect(forkSideTask).toHaveBeenCalledWith('s1', undefined, { internal: true })
    expect(sideTask.sendPrompt).toHaveBeenCalledTimes(1)
    expect(git.commitSource).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'feat: generated subject\n\nbody',
        expectedSourceHead: 's1',
      }),
    )
    expect(git.preparePick).toHaveBeenCalledWith(
      expect.objectContaining({ sourceHead: 's2', commits: ['c1', 'c1'] }),
    )
    expect(active.getSummaryForSession('s1')?.phase).toBe('awaiting_push')
  })

  it('fails and restores main when the side task returns an empty message', async () => {
    const sideTask = makeSession({ id: 'side-1', internal: true, messages: value([]) })
    const session = makeSession()
    const git = makeGit({
      inspect: vi.fn(
        async () =>
          ({
            ok: true,
            ...inspectData({ source: { ...inspectData().source, dirty: true } }),
          }) as const,
      ),
    })
    active = makeService({
      session,
      git,
      sessions: { forkSideTask: vi.fn(async () => sideTask), getById: vi.fn(() => session) },
    })
    const preview = await previewOf(active)

    const started = await active.start('s1', preview.expectation)
    expect(started.ok).toBe(false)
    if (!started.ok) expect(started.error.code).toBe('invalid_message')
    expect(git.commitSource).not.toHaveBeenCalled()
    expect(git.restoreMain).toHaveBeenCalledTimes(1)
    expect(active.getSummaryForSession('s1')?.phase).toBe('failed')
  })
})

describe('SessionDeliveryService background start', () => {
  const beginData = {
    ok: true as const,
    mainHeadBefore: 'm1',
    mainHeadAfter: 'm2',
    upstreamHead: 'u1',
    mainBranch: 'main',
    remote: 'origin',
    upstreamRef: 'origin/main',
    fetched: true,
  }

  it('returns before the git pipeline finishes and continues in the background', async () => {
    const pending = deferred<BeginResult>()
    const git = makeGit({ begin: vi.fn(() => pending.promise) })
    const service = makeService({ git })
    active = service
    const preview = await previewOf(service)

    const started = await service.startInBackground('s1', preview.expectation)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(git.begin).toHaveBeenCalledTimes(1)
    expect(git.preparePick).not.toHaveBeenCalled()
    expect(service.getSummaryForSession('s1')?.phase).toBe('preflighting')

    pending.resolve(beginData)
    await vi.waitFor(() => {
      expect(service.getSummaryForSession('s1')?.phase).toBe('awaiting_push')
    })
    expect(service.getSummaryForSession('s1')?.deliveryId).toBe(started.value.deliveryId)
  })

  it('marks the delivery failed and cleans up when the background pipeline throws', async () => {
    const git = makeGit({
      preparePick: vi.fn(async () => {
        throw new Error('extension host disconnected')
      }),
    })
    const service = makeService({ git })
    active = service
    const preview = await previewOf(service)

    const started = await service.startInBackground('s1', preview.expectation)
    expect(started.ok).toBe(true)
    if (!started.ok) return

    await vi.waitFor(() => {
      expect(service.getSummaryForSession('s1')?.phase).toBe('failed')
    })
    expect(service.getSummaryForSession('s1')?.error?.message).toBe(
      'The delivery stopped unexpectedly.',
    )
    expect(git.abortPick).toHaveBeenCalled()
    expect(git.restoreMain).toHaveBeenCalledTimes(1)
    expect(git.releaseLock).toHaveBeenCalledTimes(1)
    expect(service.listActiveContexts()).toHaveLength(0)
  })

  it('fails a dirty background delivery and releases the lock when the message is empty', async () => {
    const sideTask = makeSession({ id: 'side-1', internal: true, messages: value([]) })
    const session = makeSession()
    const git = makeGit({
      inspect: vi.fn(
        async () =>
          ({
            ok: true,
            ...inspectData({ source: { ...inspectData().source, dirty: true } }),
          }) as const,
      ),
    })
    const service = makeService({
      session,
      git,
      sessions: { forkSideTask: vi.fn(async () => sideTask), getById: vi.fn(() => session) },
    })
    active = service
    const preview = await previewOf(service)

    const started = await service.startInBackground('s1', preview.expectation)
    expect(started.ok).toBe(true)
    if (!started.ok) return

    await vi.waitFor(() => {
      expect(service.getSummaryForSession('s1')?.phase).toBe('failed')
    })
    expect(git.commitSource).not.toHaveBeenCalled()
    expect(git.restoreMain).toHaveBeenCalledTimes(1)
    expect(git.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('rejects a second background start for the same session', async () => {
    const pending = deferred<BeginResult>()
    const git = makeGit({ begin: vi.fn(() => pending.promise) })
    const service = makeService({ git })
    active = service
    const preview = await previewOf(service)

    const first = await service.startInBackground('s1', preview.expectation)
    expect(first.ok).toBe(true)
    const second = await service.startInBackground('s1', preview.expectation)
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.error.code).toBe('busy')
      expect(second.error.message).toBe('This session already has an active delivery.')
    }
    expect(git.begin).toHaveBeenCalledTimes(1)

    pending.resolve(beginData)
    await vi.waitFor(() => {
      expect(service.getSummaryForSession('s1')?.phase).toBe('awaiting_push')
    })
  })

  it('restarts a failed delivery in the background from retry', async () => {
    let sideTaskMessages: { role: string; text: string }[] = []
    const sideTask = makeSession({
      id: 'side-1',
      internal: true,
      messages: { get: () => sideTaskMessages },
    })
    const session = makeSession()
    const pending = deferred<BeginResult>()
    const begin = vi
      .fn()
      .mockResolvedValueOnce(beginData)
      .mockImplementationOnce(() => pending.promise)
    const git = makeGit({
      inspect: vi.fn(
        async () =>
          ({
            ok: true,
            ...inspectData({ source: { ...inspectData().source, dirty: true } }),
          }) as const,
      ),
      begin: begin as unknown as ISessionDeliveryGit['begin'],
    })
    const service = makeService({
      session,
      git,
      sessions: { forkSideTask: vi.fn(async () => sideTask), getById: vi.fn(() => session) },
    })
    active = service
    const preview = await previewOf(service)

    const failed = await service.start('s1', preview.expectation)
    expect(failed.ok).toBe(false)
    const failedSummary = service.getSummaryForSession('s1')
    expect(failedSummary?.phase).toBe('failed')
    if (failedSummary === undefined) return

    sideTaskMessages = [{ role: 'agent', text: 'feat: retried subject' }]
    const retried = await service.retry(failedSummary.deliveryId)
    expect(retried.ok).toBe(true)
    expect(service.getSummaryForSession('s1')?.phase).toBe('preflighting')

    pending.resolve(beginData)
    await vi.waitFor(() => {
      expect(service.getSummaryForSession('s1')?.phase).toBe('awaiting_push')
    })
    expect(begin).toHaveBeenCalledTimes(2)
    expect(service.getSummaryForSession('s1')?.deliveryId).not.toBe(failedSummary.deliveryId)
  })
})

describe('SessionDeliveryService confirmPush / undo', () => {
  it('promotes, pushes and reports synced worktrees', async () => {
    const git = makeGit()
    active = makeService({ git })
    const preview = await previewOf(active)
    const started = await active.start('s1', preview.expectation)
    expect(started.ok).toBe(true)
    if (!started.ok) return

    const pushed = await active.confirmPush(started.value.deliveryId)
    expect(pushed.ok).toBe(true)
    expect(git.promoteAndPush).toHaveBeenCalledTimes(1)
    expect(git.syncWorktrees).toHaveBeenCalledTimes(1)
    expect(active.getSummaryForSession('s1')).toMatchObject({
      phase: 'synced',
      canUndo: true,
      sync: { synced: 1, upToDate: 0, skipped: 0, failed: 0 },
    })
  })

  it('restores main when undoing an unpushed delivery', async () => {
    const git = makeGit()
    active = makeService({ git })
    const preview = await previewOf(active)
    const started = await active.start('s1', preview.expectation)
    expect(started.ok).toBe(true)
    if (!started.ok) return

    const undone = await active.undo(started.value.deliveryId)
    expect(undone.ok).toBe(true)
    expect(git.abortPick).toHaveBeenCalledTimes(1)
    expect(git.restoreMain).toHaveBeenCalledWith({
      mainWorktree: '/repo',
      expectedCurrentHead: 'm2',
      restoreToHead: 'm1',
      targetBranch: 'main',
    })
    expect(active.getSummaryForSession('s1')?.phase).toBe('undone')
  })

  it('reverts a pushed delivery and syncs again', async () => {
    const git = makeGit()
    active = makeService({ git })
    const preview = await previewOf(active)
    const started = await active.start('s1', preview.expectation)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await active.confirmPush(started.value.deliveryId)

    const undone = await active.undo(started.value.deliveryId)
    expect(undone.ok).toBe(true)
    expect(git.undo).toHaveBeenCalledWith(
      expect.objectContaining({ pushedSha: 'picked1', deliveredShas: ['c1'] }),
    )
    expect(git.syncWorktrees).toHaveBeenCalledTimes(2)
    expect(vi.mocked(git.syncWorktrees).mock.calls[1]?.[0]).toMatchObject({
      newHead: 'm3',
      expectedSourceHead: 'picked1',
    })
    expect(active.getSummaryForSession('s1')).toMatchObject({ phase: 'undone', canUndo: false })
  })

  it('retries a failed undo instead of treating it as a sync failure', async () => {
    let attempts = 0
    const git = makeGit({
      undo: vi.fn(async () => {
        attempts++
        if (attempts === 1) {
          return { ok: false, error: { code: 'push_failed', message: 'push failed' } } as const
        }
        return {
          ok: true,
          mainHead: 'm3',
          revertedShas: ['c1'],
          remoteRef: 'origin/main',
        } as const
      }),
    })
    active = makeService({ git })
    const preview = await previewOf(active)
    const started = await active.start('s1', preview.expectation)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await active.confirmPush(started.value.deliveryId)

    const failed = await active.undo(started.value.deliveryId)
    expect(failed.ok).toBe(false)
    expect(active.getSummaryForSession('s1')?.phase).toBe('failed')

    const retried = await active.retry(started.value.deliveryId)
    expect(retried.ok).toBe(true)
    expect(git.undo).toHaveBeenCalledTimes(2)
    expect(active.getSummaryForSession('s1')?.phase).toBe('undone')
  })
})

describe('SessionDeliveryService conflict resolution', () => {
  it('runs one internal resolver session and continues the pick', async () => {
    const resolver = makeSession({
      id: 'resolver-1',
      internal: true,
      messages: value([{ role: 'agent', text: 'resolved' }]),
    })
    const session = makeSession()
    const git = makeGit({
      preparePick: vi.fn(
        async () =>
          ({
            ok: true,
            ...pickData({
              status: 'conflict',
              picked: [],
              remainingCommits: ['c1'],
              conflictFiles: ['src/a.ts'],
              conflictedCommit: COMMIT,
            }),
          }) as const,
      ),
      continuePick: vi.fn(async () => ({ ok: true, ...pickData() }) as const),
    })
    const createSession = vi.fn(async () => resolver)
    active = makeService({
      session,
      git,
      sessions: {
        getById: vi.fn(() => session),
        createSession,
      },
    })
    const preview = await previewOf(active)

    const started = await active.start('s1', preview.expectation)
    expect(started.ok).toBe(true)
    expect(createSession).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({
        cwd: '/repo/.delivery/wt',
        internal: true,
        activate: false,
      }),
    )
    expect(resolver.sendPrompt).toHaveBeenCalledTimes(1)
    expect(git.continuePick).toHaveBeenCalledTimes(1)
    expect(active.getSummaryForSession('s1')?.phase).toBe('awaiting_push')
  })

  it('aborts and restores main when the resolver fails', async () => {
    const resolver = makeSession({
      id: 'resolver-1',
      internal: true,
      sendPrompt: vi.fn(async () => {
        throw new Error('agent failed')
      }),
    })
    const session = makeSession()
    const git = makeGit({
      preparePick: vi.fn(
        async () =>
          ({
            ok: true,
            ...pickData({
              status: 'conflict',
              picked: [],
              remainingCommits: ['c1'],
              conflictFiles: ['src/a.ts'],
              conflictedCommit: COMMIT,
            }),
          }) as const,
      ),
    })
    active = makeService({
      session,
      git,
      sessions: { getById: vi.fn(() => session), createSession: vi.fn(async () => resolver) },
    })
    const preview = await previewOf(active)

    const started = await active.start('s1', preview.expectation)
    expect(started.ok).toBe(false)
    expect(git.abortPick).toHaveBeenCalled()
    expect(git.restoreMain).toHaveBeenCalledTimes(1)
    expect(active.getSummaryForSession('s1')?.phase).toBe('failed')
  })
})

describe('SessionDeliveryService guards', () => {
  it('reports the source worktree as busy during a delivery', async () => {
    const git = makeGit()
    active = makeService({ git })
    const preview = await previewOf(active)
    await active.start('s1', preview.expectation)

    expect(active.isDeliveryBusyForCwd('/repo/feature', undefined)).toBe(true)
    expect(active.isDeliveryBusyForCwd('/repo', undefined)).toBe(true)
    expect(active.isDeliveryBusyForCwd('/other', undefined)).toBe(false)
  })

  it('offers delivery for idle or idle-reaped dormant sessions', () => {
    active = makeService()
    expect(active.isAvailable(makeSession())).toBe(true)
    expect(
      active.isAvailable(makeSession({ status: value('closed'), isDormant: value(true) })),
    ).toBe(true)
    expect(
      active.isAvailable(makeSession({ status: value('closed'), isDormant: value(false) })),
    ).toBe(false)
    expect(active.isAvailable(makeSession({ status: value('running') }))).toBe(false)
    expect(active.isAvailable(makeSession({ status: value('errored') }))).toBe(false)
    expect(active.isAvailable(makeSession({ internal: true }))).toBe(false)
    expect(active.isAvailable(makeSession({ readOnly: true }))).toBe(false)
  })
})

describe('SessionDeliveryService pending work probe', () => {
  type PendingResult = Awaited<ReturnType<ISessionDeliveryGit['hasPendingWork']>>
  const pendingResult = {
    ok: true,
    pending: true,
    dirty: false,
    commitCount: 1,
  } as const
  const cleanResult = {
    ok: true,
    pending: false,
    dirty: false,
    commitCount: 0,
  } as const

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((settle) => {
      resolve = settle
    })
    return { promise, resolve }
  }

  it('caches the probe and only exposes a confirmed true', async () => {
    const git = makeGit({ hasPendingWork: vi.fn(async () => pendingResult) })
    active = makeService({ git })
    const session = makeSession()

    expect(active.hasDeliverableChanges(session)).toBe(false)
    await expect(active.refreshDeliverableChanges(session)).resolves.toBe(true)
    expect(active.hasDeliverableChanges(session)).toBe(true)
  })

  it('does not treat an unknown false as a visible change', async () => {
    active = makeService()

    await expect(active.refreshDeliverableChanges(makeSession())).resolves.toBe(false)
    expect(active.hasDeliverableChanges(makeSession())).toBe(false)
  })

  it('reports true to false as a visible change', async () => {
    const git = makeGit({ hasPendingWork: vi.fn(async () => pendingResult) })
    active = makeService({ git })
    const session = makeSession()
    await active.refreshDeliverableChanges(session)

    vi.mocked(git.hasPendingWork).mockResolvedValue(cleanResult)
    await expect(active.refreshDeliverableChanges(session, { force: true })).resolves.toBe(true)
    expect(active.hasDeliverableChanges(session)).toBe(false)
  })

  it('reuses the cache within the TTL and re-probes afterwards', async () => {
    vi.useFakeTimers()
    try {
      const git = makeGit({ hasPendingWork: vi.fn(async () => pendingResult) })
      active = makeService({ git })
      const session = makeSession()

      await active.refreshDeliverableChanges(session)
      await active.refreshDeliverableChanges(session)
      expect(git.hasPendingWork).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(DELIVERABLE_CHANGES_TTL_MS)
      await active.refreshDeliverableChanges(session)
      expect(git.hasPendingWork).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('forces past the TTL', async () => {
    const git = makeGit({ hasPendingWork: vi.fn(async () => pendingResult) })
    active = makeService({ git })
    const session = makeSession()

    await active.refreshDeliverableChanges(session)
    await active.refreshDeliverableChanges(session, { force: true })

    expect(git.hasPendingWork).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent probes for the same worktree', async () => {
    const probe = deferred<PendingResult>()
    const git = makeGit({ hasPendingWork: vi.fn(() => probe.promise) })
    active = makeService({ git })
    const session = makeSession()

    const first = active.refreshDeliverableChanges(session)
    const second = active.refreshDeliverableChanges(session)
    expect(git.hasPendingWork).toHaveBeenCalledTimes(1)

    probe.resolve(pendingResult)
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
  })

  it('lets a forced probe supersede an older in-flight one', async () => {
    const normal = deferred<PendingResult>()
    const forced = deferred<PendingResult>()
    const git = makeGit({
      hasPendingWork: vi
        .fn()
        .mockReturnValueOnce(normal.promise)
        .mockReturnValueOnce(forced.promise),
    })
    active = makeService({ git })
    const session = makeSession()

    const first = active.refreshDeliverableChanges(session)
    const second = active.refreshDeliverableChanges(session, { force: true })

    forced.resolve(pendingResult)
    await expect(second).resolves.toBe(true)
    normal.resolve(cleanResult)
    await expect(first).resolves.toBe(false)

    expect(active.hasDeliverableChanges(session)).toBe(true)
  })

  it('times out a stuck probe and recovers on the next forced refresh', async () => {
    vi.useFakeTimers()
    try {
      const git = makeGit({ hasPendingWork: vi.fn(() => new Promise<never>(() => {})) })
      active = makeService({ git })
      const session = makeSession()

      const refresh = active.refreshDeliverableChanges(session)
      await vi.advanceTimersByTimeAsync(DELIVERABLE_CHANGES_TIMEOUT_MS)
      await expect(refresh).resolves.toBe(false)
      expect(active.hasDeliverableChanges(session)).toBe(false)

      vi.mocked(git.hasPendingWork).mockResolvedValue(pendingResult)
      await expect(active.refreshDeliverableChanges(session, { force: true })).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats probe failures as not deliverable', async () => {
    const git = makeGit({
      hasPendingWork: vi.fn(
        async () =>
          ({ ok: false, error: { code: 'git_failed', message: 'boom' } }) as PendingResult,
      ),
    })
    active = makeService({ git })

    await expect(active.refreshDeliverableChanges(makeSession())).resolves.toBe(false)
    expect(active.hasDeliverableChanges(makeSession())).toBe(false)
  })

  it('skips sessions without a cwd', async () => {
    const git = makeGit()
    active = makeService({ git })

    await expect(active.refreshDeliverableChanges(makeSession({ cwd: undefined }))).resolves.toBe(
      false,
    )
    expect(git.hasPendingWork).not.toHaveBeenCalled()
  })

  it('keeps caches separate per authority', async () => {
    const git = makeGit({ hasPendingWork: vi.fn(async () => pendingResult) })
    active = makeService({ git })

    await active.refreshDeliverableChanges(makeSession({ authority: 'remote-a' }))
    expect(active.hasDeliverableChanges(makeSession({ authority: 'remote-a' }))).toBe(true)
    expect(active.hasDeliverableChanges(makeSession({ authority: 'remote-b' }))).toBe(false)
  })

  it('ignores probe results after dispose', async () => {
    const probe = deferred<PendingResult>()
    const git = makeGit({ hasPendingWork: vi.fn(() => probe.promise) })
    const service = makeService({ git })
    const refresh = service.refreshDeliverableChanges(makeSession())

    service.dispose()
    probe.resolve(pendingResult)

    await expect(refresh).resolves.toBe(false)
  })
})

describe('SessionDeliveryService restart recovery', () => {
  it('re-acquires the lock for a persisted awaiting_push delivery', async () => {
    const git = makeGit()
    active = makeService({ git, store: makeStore([record()]) })

    await active.initialize()

    // The token was persisted by an earlier process; a fresh window must not
    // reuse it without proving the old owner is gone.
    expect(git.heartbeatLock).not.toHaveBeenCalled()
    expect(git.acquireLock).toHaveBeenCalledWith(
      expect.objectContaining({ commonDir: '/repo/.git' }),
    )
    expect(active.getSummaryForSession('s1')?.phase).toBe('awaiting_push')
    expect(active.getDetail('d1')?.summary.phase).toBe('awaiting_push')
    expect(active.listActiveContexts()).toHaveLength(1)
  })

  it('leaves a delivery alone when another live window owns its lock', async () => {
    const git = makeGit({
      acquireLock: vi.fn(
        async () =>
          ({
            ok: true,
            acquired: false,
            owner: {
              token: 'token-1',
              pid: 1,
              hostname: 'other-host',
              startedAt: new Date(0).toISOString(),
              heartbeatAt: new Date().toISOString(),
            },
          }) as const,
      ),
    })
    active = makeService({ git, store: makeStore([record({ phase: 'awaiting_push' })]) })

    await active.initialize()

    expect(active.getSummaryForSession('s1')?.phase).toBe('awaiting_push')
    expect(git.abortPick).not.toHaveBeenCalled()
    expect(git.restoreMain).not.toHaveBeenCalled()
  })

  it('waits for confirmation when main moved but the remote did not', async () => {
    const git = makeGit({
      inspect: vi.fn(
        async () =>
          ({
            ok: true,
            ...inspectData({
              repository: {
                ...inspectData().repository,
                mainHead: 'picked1',
                upstreamHead: 'u1',
              },
            }),
          }) as const,
      ),
    })
    active = makeService({ git, store: makeStore([record({ phase: 'pushing' })]) })

    await active.initialize()

    expect(active.getSummaryForSession('s1')?.phase).toBe('awaiting_push')
    expect(git.promoteAndPush).not.toHaveBeenCalled()
    expect(git.syncWorktrees).not.toHaveBeenCalled()
  })

  it('syncs when the remote already has the pushed delivery', async () => {
    const git = makeGit({
      inspect: vi.fn(
        async () =>
          ({
            ok: true,
            ...inspectData({
              repository: {
                ...inspectData().repository,
                mainHead: 'picked1',
                upstreamHead: 'picked1',
              },
            }),
          }) as const,
      ),
    })
    active = makeService({ git, store: makeStore([record({ phase: 'pushing' })]) })

    await active.initialize()

    expect(git.syncWorktrees).toHaveBeenCalledTimes(1)
    expect(active.getSummaryForSession('s1')?.phase).toBe('synced')
  })

  it('aborts a mid-flight delivery, restores main and marks it failed', async () => {
    const git = makeGit()
    active = makeService({ git, store: makeStore([record({ phase: 'cherry_picking' })]) })

    await active.initialize()

    expect(git.abortPick).toHaveBeenCalled()
    expect(git.restoreMain).toHaveBeenCalledWith({
      mainWorktree: '/repo',
      expectedCurrentHead: 'm2',
      restoreToHead: 'm1',
      targetBranch: 'main',
    })
    expect(active.getSummaryForSession('s1')?.phase).toBe('failed')
    expect(active.listActiveContexts()).toHaveLength(0)
  })
})
