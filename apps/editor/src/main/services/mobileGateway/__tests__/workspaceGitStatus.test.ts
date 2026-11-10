/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/mobileGateway/workspaceGitStatus.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_GIT_STATUS_CACHE_TTL_MS,
  WORKSPACE_GIT_STATUS_TIMEOUT_MS,
  WorkspaceGitStatusService,
  type GitStatusRunner,
} from '../workspaceGitStatus.js'

function deferred<T>(): {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function runnerFor(stdout: string): GitStatusRunner & ReturnType<typeof vi.fn> {
  return vi.fn(async () => stdout) as GitStatusRunner & ReturnType<typeof vi.fn>
}

describe('WorkspaceGitStatusService', () => {
  it('reports clean and dirty workspaces from stdout', async () => {
    const clean = runnerFor('')
    const dirty = runnerFor('?? new-file\n')
    const service = new WorkspaceGitStatusService({
      runner: clean,
      platform: 'linux',
    })

    await expect(service.isDirty('/repo')).resolves.toBe(false)
    expect(clean).toHaveBeenCalledWith({
      root: '/repo',
      timeoutMs: WORKSPACE_GIT_STATUS_TIMEOUT_MS,
      signal: expect.any(AbortSignal),
    })

    service.dispose()
    const dirtyService = new WorkspaceGitStatusService({
      runner: dirty,
      platform: 'linux',
    })
    await expect(dirtyService.isDirty('/repo')).resolves.toBe(true)
    dirtyService.dispose()
  })

  it('maps failures to undefined and caches them', async () => {
    const runner = vi.fn(async () => {
      throw new Error('not a git repository')
    })
    const service = new WorkspaceGitStatusService({ runner, platform: 'linux' })

    await expect(service.isDirty('/repo')).resolves.toBeUndefined()
    await expect(service.isDirty('/repo')).resolves.toBeUndefined()
    expect(runner).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('refreshes the cache after the TTL', async () => {
    let now = 1_000
    const runner = runnerFor('')
    const service = new WorkspaceGitStatusService({
      runner,
      now: () => now,
      platform: 'linux',
    })

    await service.isDirty('/repo')
    now += WORKSPACE_GIT_STATUS_CACHE_TTL_MS - 1
    await service.isDirty('/repo')
    expect(runner).toHaveBeenCalledTimes(1)

    now += 1
    await service.isDirty('/repo')
    expect(runner).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('deduplicates concurrent probes for the same path', async () => {
    const pending = deferred<string>()
    const runner = vi.fn(() => pending.promise)
    const service = new WorkspaceGitStatusService({ runner, platform: 'linux' })

    const first = service.isDirty('/repo')
    const second = service.isDirty('/repo')
    expect(runner).toHaveBeenCalledTimes(1)

    pending.resolve('M  tracked.ts\n')
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    service.dispose()
  })

  it('lets one caller abort without cancelling another caller or the cache', async () => {
    const pending = deferred<string>()
    const runner = vi.fn(() => pending.promise)
    const service = new WorkspaceGitStatusService({ runner, platform: 'linux' })
    const abort = new AbortController()

    const cancelled = service.isDirty('/repo', abort.signal)
    const kept = service.isDirty('/repo')
    abort.abort()

    await expect(cancelled).resolves.toBeUndefined()
    pending.resolve('?? new-file\n')
    await expect(kept).resolves.toBe(true)
    await expect(service.isDirty('/repo')).resolves.toBe(true)
    expect(runner).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('rejects relative paths without spawning git', async () => {
    const runner = runnerFor('')
    const service = new WorkspaceGitStatusService({ runner, platform: 'linux' })

    await expect(service.isDirty('relative/repo')).resolves.toBeUndefined()
    expect(runner).not.toHaveBeenCalled()
    service.dispose()
  })

  it('keys cache entries case-insensitively on win32', async () => {
    const runner = runnerFor('')
    const service = new WorkspaceGitStatusService({ runner, platform: 'win32' })

    await service.isDirty('C:/Repo')
    await service.isDirty('c:\\repo')
    expect(runner).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('aborts in-flight probes on dispose without caching the abort', async () => {
    const runner: GitStatusRunner = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    const service = new WorkspaceGitStatusService({ runner, platform: 'linux' })

    const probe = service.isDirty('/repo')
    service.dispose()
    await expect(probe).resolves.toBeUndefined()
  })
})
