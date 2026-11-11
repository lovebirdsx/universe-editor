import { describe, expect, it, vi } from 'vitest'
import type { IAcpSession } from '../../acp/session/acpSession.js'
import type { IAcpSessionService } from '../../acp/session/acpSessionService.js'
import type { ISessionDeliveryGit } from '../sessionDeliveryGit.js'
import type { ISessionDeliveryService } from '../sessionDeliveryService.js'
import { SessionBranchPushService } from '../sessionBranchPushService.js'

function value<T>(current: T): { get(): T } {
  return { get: () => current }
}

function makeSession(overrides: Partial<Record<keyof IAcpSession, unknown>> = {}): IAcpSession {
  return {
    id: 's1',
    agentId: 'claude',
    title: 'Task',
    cwd: '/repo/feature',
    readOnly: false,
    internal: false,
    authority: undefined,
    status: value('idle'),
    ...overrides,
  } as unknown as IAcpSession
}

function inspectData() {
  return {
    source: {
      worktree: '/repo/feature',
      branch: 'feature',
      head: 's1',
      dirty: true,
      changedFileCount: 1,
      untrackedCount: 1,
      isMainWorktree: false,
    },
    remote: {
      name: 'origin',
      branch: 'feature',
      exists: false,
      ahead: 0,
      behind: 0,
    },
    blockers: [],
    warnings: ['Uncommitted changes are not included; only commits are pushed.'],
    fetched: true,
  }
}

function makeGit(overrides: Partial<ISessionDeliveryGit> = {}): ISessionDeliveryGit {
  return {
    inspectPushBranch: vi.fn(async () => ({ ok: true as const, ...inspectData() })),
    pushBranch: vi.fn(async () => ({
      ok: true as const,
      branch: 'feature',
      head: 's1',
      remote: 'origin',
      remoteBranch: 'feature',
      published: true,
    })),
    ...overrides,
  } as unknown as ISessionDeliveryGit
}

function makeDelivery(overrides: Partial<ISessionDeliveryService> = {}): ISessionDeliveryService {
  return {
    isDeliveryBusyForSession: vi.fn(() => false),
    isDeliveryBusyForCwd: vi.fn(() => false),
    ...overrides,
  } as unknown as ISessionDeliveryService
}

function makeService(options: {
  session?: IAcpSession | undefined
  git?: ISessionDeliveryGit
  delivery?: ISessionDeliveryService
}): {
  service: SessionBranchPushService
  git: ISessionDeliveryGit
} {
  const sessions = {
    getById: vi.fn((id: string) =>
      id === (options.session?.id ?? 's1') ? options.session : undefined,
    ),
  } as unknown as IAcpSessionService
  const git = options.git ?? makeGit()
  const service = new SessionBranchPushService(sessions, git, options.delivery ?? makeDelivery())
  return { service, git }
}

describe('SessionBranchPushService', () => {
  it('turns the git preview into a pinned expectation', async () => {
    const { service } = makeService({ session: makeSession() })

    const result = await service.preview('s1')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.source.dirty).toBe(true)
    expect(result.value.expectation).toEqual({
      branch: 'feature',
      head: 's1',
      remote: 'origin',
      remoteBranch: 'feature',
    })
    expect(result.value.blockers).toEqual([])
  })

  it('rejects read-only sessions', async () => {
    const { service } = makeService({ session: makeSession({ readOnly: true }) })

    const result = await service.preview('s1')

    expect(result).toMatchObject({ ok: false, error: { code: 'unsupported' } })
  })

  it('rejects while a delivery is running for the repository', async () => {
    const delivery = makeDelivery({
      isDeliveryBusyForCwd: vi.fn(() => true),
    })
    const { service } = makeService({ session: makeSession(), delivery })

    const result = await service.preview('s1')

    expect(result).toMatchObject({ ok: false, error: { code: 'busy' } })
  })

  it('rejects a running session', async () => {
    const { service } = makeService({
      session: makeSession({ status: value('running') }),
    })

    const result = await service.preview('s1')

    expect(result).toMatchObject({ ok: false, error: { code: 'session_running' } })
  })

  it('maps git blocker codes', async () => {
    const git = makeGit({
      inspectPushBranch: vi.fn(async () => ({
        ok: true as const,
        ...inspectData(),
        blockers: [
          {
            code: 'remote_diverged' as const,
            message: 'The remote branch has commits you do not have.',
          },
        ],
      })),
    })
    const { service } = makeService({ session: makeSession(), git })

    const result = await service.preview('s1')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.blockers[0]?.code).toBe('remote_diverged')
  })

  it('forwards the pinned heads to git and returns the push result', async () => {
    const { service, git } = makeService({ session: makeSession() })

    const result = await service.push('s1', {
      branch: 'feature',
      head: 's1',
      remote: 'origin',
      remoteBranch: 'feature',
      remoteHead: 'r1',
    })

    expect(result.ok).toBe(true)
    expect(git.pushBranch).toHaveBeenCalledWith({
      sourceCwd: '/repo/feature',
      expectedBranch: 'feature',
      expectedHead: 's1',
      remote: 'origin',
      remoteBranch: 'feature',
      expectedRemoteHead: 'r1',
      fetch: true,
    })
  })

  it('maps a git push failure', async () => {
    const git = makeGit({
      pushBranch: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'remote_moved' as const, message: 'The remote branch moved.' },
      })),
    })
    const { service } = makeService({ session: makeSession(), git })

    const result = await service.push('s1', {
      branch: 'feature',
      head: 's1',
      remote: 'origin',
      remoteBranch: 'feature',
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'remote_moved' } })
  })
})
