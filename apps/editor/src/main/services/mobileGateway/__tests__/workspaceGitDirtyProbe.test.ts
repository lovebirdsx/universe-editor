/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/mobileGateway/workspaceGitDirtyProbe.ts
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IMobileBridgeService } from '../../../../shared/ipc/mobileGatewayService.js'
import {
  WORKSPACE_GIT_BRIDGE_TIMEOUT_MS,
  createWorkspaceGitDirtyProbe,
} from '../workspaceGitDirtyProbe.js'

function bridgeWith(result: Promise<boolean | undefined>): {
  readonly bridge: IMobileBridgeService
  readonly calls: ReturnType<typeof vi.fn>
} {
  const calls = vi.fn(() => result)
  return { bridge: { getWorkspaceGitDirty: calls } as unknown as IMobileBridgeService, calls }
}

describe('createWorkspaceGitDirtyProbe', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('probes local file workspaces through git', async () => {
    const isDirty = vi.fn(async () => true)
    const probe = createWorkspaceGitDirtyProbe({ isDirty })
    const signal = new AbortController().signal

    await expect(probe({ folder: 'file:///repo', name: 'repo' }, undefined, signal)).resolves.toBe(
      true,
    )
    expect(isDirty).toHaveBeenCalledWith('/repo', signal)
  })

  it('treats a UNC file workspace as local', async () => {
    const isDirty = vi.fn(async () => false)
    const probe = createWorkspaceGitDirtyProbe({ isDirty })
    const folder = 'file://server/share/repo'

    await expect(
      probe({ folder, name: 'repo' }, undefined, new AbortController().signal),
    ).resolves.toBe(false)
    expect(isDirty).toHaveBeenCalledWith(URI.parse(folder).fsPath, expect.any(AbortSignal))
  })

  it('uses the open window bridge for remote workspaces', async () => {
    const isDirty = vi.fn(async () => undefined)
    const { bridge, calls } = bridgeWith(Promise.resolve(true))
    const probe = createWorkspaceGitDirtyProbe({ isDirty })

    await expect(
      probe(
        { folder: 'remote-ssh://host/repo', name: 'repo', authority: 'host' },
        bridge,
        new AbortController().signal,
      ),
    ).resolves.toBe(true)
    expect(calls).toHaveBeenCalledTimes(1)
    expect(isDirty).not.toHaveBeenCalled()
  })

  it('leaves a recent-only remote workspace unknown', async () => {
    const isDirty = vi.fn(async () => true)
    const probe = createWorkspaceGitDirtyProbe({ isDirty })

    await expect(
      probe(
        { folder: 'remote-ssh://host/repo', name: 'repo', authority: 'host' },
        undefined,
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined()
    expect(isDirty).not.toHaveBeenCalled()
  })

  it('returns undefined for a string without a scheme', async () => {
    const isDirty = vi.fn(async () => true)
    const probe = createWorkspaceGitDirtyProbe({ isDirty })

    await expect(
      probe({ folder: 'not-a-uri', name: 'bad' }, undefined, new AbortController().signal),
    ).resolves.toBeUndefined()
    expect(isDirty).not.toHaveBeenCalled()
  })

  it('swallows bridge failures', async () => {
    const { bridge } = bridgeWith(Promise.reject(new Error('renderer gone')))
    const probe = createWorkspaceGitDirtyProbe({ isDirty: async () => undefined })

    await expect(
      probe(
        { folder: 'remote-ssh://host/repo', name: 'repo', authority: 'host' },
        bridge,
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined()
  })

  it('times out a hanging bridge call', async () => {
    vi.useFakeTimers()
    const { bridge } = bridgeWith(new Promise(() => undefined))
    const probe = createWorkspaceGitDirtyProbe({ isDirty: async () => undefined })

    const result = probe(
      { folder: 'remote-ssh://host/repo', name: 'repo', authority: 'host' },
      bridge,
      new AbortController().signal,
    )
    await vi.advanceTimersByTimeAsync(WORKSPACE_GIT_BRIDGE_TIMEOUT_MS)
    await expect(result).resolves.toBeUndefined()
  })

  it('skips the bridge when the signal is already aborted', async () => {
    const { bridge, calls } = bridgeWith(Promise.resolve(true))
    const probe = createWorkspaceGitDirtyProbe({ isDirty: async () => undefined })
    const abort = new AbortController()
    abort.abort()

    await expect(
      probe(
        { folder: 'remote-ssh://host/repo', name: 'repo', authority: 'host' },
        bridge,
        abort.signal,
      ),
    ).resolves.toBeUndefined()
    expect(calls).not.toHaveBeenCalled()
  })
})
