/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for AgentBinaryPrefetchContribution — idle maintenance of the Claude /
 *  codex-acp binaries now follows the remote workspace:
 *    - local workspace: local cleanup always runs once, local prefetch runs once
 *      when `acp.prefetchBinaries` is on and the per-agent source is "download".
 *    - remote workspace: the current authority's managed store is swept and
 *      prefetched (once), without running local prefetch; the local source
 *      setting is never consulted across the tunnel.
 *    - remote maintenance is gated on `connected`: a not-yet-connected authority
 *      never triggers a remote call (which would lazily bring up the connection).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  IConfigurationService,
  ILoggerService,
  IWorkspaceService,
  InstantiationService,
  NullLogger,
  REMOTE_SCHEME,
  ServiceCollection,
  URI,
  type IWorkspace,
} from '@universe-editor/platform'
import { IClaudeBinaryService } from '../../../shared/ipc/claudeBinaryService.js'
import { ICodexBinaryService } from '../../../shared/ipc/codexBinaryService.js'
import {
  IRemoteStatusService,
  type RemoteConnectionStatusDto,
} from '../../../shared/ipc/remoteStatusService.js'
import { AgentBinaryPrefetchContribution } from '../AgentBinaryPrefetchContribution.js'

const AUTHORITY = 'myhost'

function makeBinaryService() {
  return {
    _serviceBrand: undefined,
    prefetch: vi.fn().mockResolvedValue(undefined),
    cleanupStaleVersions: vi.fn().mockResolvedValue(undefined),
  }
}

function makeConfig(values: Record<string, unknown> = {}) {
  return {
    _serviceBrand: undefined,
    get: vi.fn((key: string) => values[key]),
  }
}

function makeWorkspace(folder: URI) {
  const emitter = new Emitter<IWorkspace | null>()
  let current: IWorkspace | null = { folder, name: folder.authority || 'local' }
  return {
    _serviceBrand: undefined,
    get current() {
      return current
    },
    setCurrent(next: IWorkspace | null) {
      current = next
      emitter.fire(current)
    },
    onDidChangeWorkspace: emitter.event,
    _emitter: emitter,
  }
}

function makeRemoteStatus() {
  const emitter = new Emitter<RemoteConnectionStatusDto>()
  return {
    _serviceBrand: undefined,
    getConnections: vi.fn().mockResolvedValue([]),
    onDidChangeState: emitter.event,
    _emitter: emitter,
  }
}

interface Harness {
  claude: ReturnType<typeof makeBinaryService>
  codex: ReturnType<typeof makeBinaryService>
  workspace: ReturnType<typeof makeWorkspace>
  remoteStatus: ReturnType<typeof makeRemoteStatus>
  contribution: AgentBinaryPrefetchContribution
}

function setup(opts?: {
  remote?: string
  config?: Record<string, unknown>
  getConnections?: () => Promise<readonly RemoteConnectionStatusDto[]>
}): Harness {
  const claude = makeBinaryService()
  const codex = makeBinaryService()
  const config = makeConfig(opts?.config)
  const folder = opts?.remote
    ? URI.from({ scheme: REMOTE_SCHEME, authority: opts.remote, path: '/' })
    : URI.file('C:/local-project')
  const workspace = makeWorkspace(folder)
  const remoteStatus = makeRemoteStatus()
  if (opts?.getConnections) remoteStatus.getConnections.mockImplementation(opts.getConnections)

  const services = new ServiceCollection()
  services.set(IClaudeBinaryService, claude as never)
  services.set(ICodexBinaryService, codex as never)
  services.set(IConfigurationService, config as never)
  services.set(IWorkspaceService, workspace as never)
  services.set(IRemoteStatusService, remoteStatus as never)
  services.set(ILoggerService, { createLogger: () => new NullLogger() } as never)
  const inst = new InstantiationService(services)
  const contribution = inst.createInstance(AgentBinaryPrefetchContribution)
  return { claude, codex, workspace, remoteStatus, contribution }
}

function fireConnected(remoteStatus: ReturnType<typeof makeRemoteStatus>): void {
  remoteStatus._emitter.fire({ authority: AUTHORITY, state: 'connected' })
}

/** Flush the fire-and-forget async maintenance chains (each method awaits twice). */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('AgentBinaryPrefetchContribution', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs local cleanup and prefetch exactly once for a local workspace', async () => {
    const { claude, codex, workspace, contribution } = setup({
      config: {
        'acp.prefetchBinaries': true,
        'acp.claude.source': 'download',
        'acp.codex.source': 'download',
      },
    })

    // Workspace events fire repeatedly; the Set must dedupe.
    workspace.setCurrent(workspace.current)
    workspace.setCurrent(workspace.current)
    await settle()

    expect(claude.cleanupStaleVersions).toHaveBeenCalledTimes(1)
    expect(codex.cleanupStaleVersions).toHaveBeenCalledTimes(1)
    expect(claude.prefetch).toHaveBeenCalledTimes(1)
    expect(codex.prefetch).toHaveBeenCalledTimes(1)
    // Local prefetch is called without an authority argument.
    expect(claude.prefetch).toHaveBeenCalledWith()

    contribution.dispose()
  })

  it('skips local prefetch for a non-download source while still cleaning up', async () => {
    const { claude, codex, workspace, contribution } = setup({
      config: {
        'acp.prefetchBinaries': true,
        'acp.claude.source': 'system',
        'acp.codex.source': 'custom',
      },
    })

    workspace.setCurrent(workspace.current)
    await settle()

    expect(claude.cleanupStaleVersions).toHaveBeenCalledTimes(1)
    expect(codex.cleanupStaleVersions).toHaveBeenCalledTimes(1)
    expect(claude.prefetch).not.toHaveBeenCalled()
    expect(codex.prefetch).not.toHaveBeenCalled()

    contribution.dispose()
  })

  it('runs cleanup but not prefetch when acp.prefetchBinaries is false', async () => {
    const { claude, codex, workspace, contribution } = setup({
      config: {
        'acp.prefetchBinaries': false,
        'acp.claude.source': 'download',
        'acp.codex.source': 'download',
      },
    })

    workspace.setCurrent(workspace.current)
    await settle()

    expect(claude.cleanupStaleVersions).toHaveBeenCalledTimes(1)
    expect(codex.cleanupStaleVersions).toHaveBeenCalledTimes(1)
    expect(claude.prefetch).not.toHaveBeenCalled()
    expect(codex.prefetch).not.toHaveBeenCalled()

    contribution.dispose()
  })

  it('sweeps and prefetches the remote store (not the local one) for a connected remote workspace', async () => {
    const { claude, codex, remoteStatus, contribution } = setup({
      remote: AUTHORITY,
      config: {
        'acp.prefetchBinaries': true,
        // Local source must not gate the remote prefetch: remote is managed download.
        'acp.claude.source': 'system',
        'acp.codex.source': 'custom',
      },
    })

    fireConnected(remoteStatus)
    fireConnected(remoteStatus)
    await settle()

    // Local sweep once (no authority); remote sweep once per authority.
    expect(claude.cleanupStaleVersions).toHaveBeenCalledTimes(2)
    expect(claude.cleanupStaleVersions).toHaveBeenCalledWith(AUTHORITY)
    expect(codex.cleanupStaleVersions).toHaveBeenCalledTimes(2)
    expect(codex.cleanupStaleVersions).toHaveBeenCalledWith(AUTHORITY)
    // Remote prefetch ran once with the authority; local prefetch never ran.
    expect(claude.prefetch).toHaveBeenCalledTimes(1)
    expect(claude.prefetch).toHaveBeenCalledWith(AUTHORITY)
    expect(codex.prefetch).toHaveBeenCalledTimes(1)
    expect(codex.prefetch).toHaveBeenCalledWith(AUTHORITY)
    expect(claude.prefetch).not.toHaveBeenCalledWith(undefined)

    contribution.dispose()
  })

  it('does not run remote maintenance until the authority is connected', async () => {
    const { claude, codex, workspace, contribution } = setup({ remote: AUTHORITY })

    workspace.setCurrent(workspace.current)
    await settle()

    // Local sweep still ran (no network); no remote call before `connected`.
    expect(claude.cleanupStaleVersions).toHaveBeenCalledTimes(1)
    expect(claude.cleanupStaleVersions).not.toHaveBeenCalledWith(AUTHORITY)
    expect(codex.cleanupStaleVersions).not.toHaveBeenCalledWith(AUTHORITY)
    expect(claude.prefetch).not.toHaveBeenCalled()
    expect(codex.prefetch).not.toHaveBeenCalled()

    contribution.dispose()
  })

  it('maintains exactly once when the connection comes up after the workspace', async () => {
    const { claude, codex, workspace, remoteStatus, contribution } = setup({
      remote: AUTHORITY,
      config: { 'acp.prefetchBinaries': true },
    })

    // Not connected yet: local sweep only, no remote call.
    workspace.setCurrent(workspace.current)
    await settle()
    expect(claude.cleanupStaleVersions).toHaveBeenCalledTimes(1)
    expect(claude.cleanupStaleVersions).not.toHaveBeenCalledWith(AUTHORITY)
    expect(claude.prefetch).not.toHaveBeenCalled()

    // The connection comes up → exactly one remote maintenance, never doubled.
    fireConnected(remoteStatus)
    fireConnected(remoteStatus)
    await settle()
    expect(claude.cleanupStaleVersions).toHaveBeenCalledTimes(2)
    expect(claude.cleanupStaleVersions).toHaveBeenCalledWith(AUTHORITY)
    expect(codex.cleanupStaleVersions).toHaveBeenCalledWith(AUTHORITY)
    expect(claude.prefetch).toHaveBeenCalledTimes(1)
    expect(claude.prefetch).toHaveBeenCalledWith(AUTHORITY)
    expect(codex.prefetch).toHaveBeenCalledTimes(1)
    expect(codex.prefetch).toHaveBeenCalledWith(AUTHORITY)

    contribution.dispose()
  })

  it('runs remote maintenance for each distinct authority exactly once', async () => {
    const { claude, remoteStatus, workspace, contribution } = setup({
      remote: AUTHORITY,
      config: { 'acp.prefetchBinaries': true },
    })

    fireConnected(remoteStatus)
    // Switch to a second remote authority and connect it too.
    workspace.setCurrent({
      folder: URI.from({ scheme: REMOTE_SCHEME, authority: 'other-host', path: '/' }),
      name: 'other-host',
    })
    remoteStatus._emitter.fire({ authority: 'other-host', state: 'connected' })
    // Refire — must stay deduped.
    remoteStatus._emitter.fire({ authority: 'other-host', state: 'connected' })
    await settle()

    expect(claude.cleanupStaleVersions).toHaveBeenCalledWith(AUTHORITY)
    expect(claude.cleanupStaleVersions).toHaveBeenCalledWith('other-host')
    expect(claude.cleanupStaleVersions).toHaveBeenCalledTimes(3) // local + 2 remote
    expect(claude.prefetch).toHaveBeenCalledTimes(2) // remote only, one per authority

    contribution.dispose()
  })

  it('bounds connection-state re-seeding when getConnections keeps failing', async () => {
    const getConnections = vi.fn().mockRejectedValue(new Error('boom'))
    const { claude, codex, workspace, remoteStatus, contribution } = setup({
      remote: AUTHORITY,
      config: { 'acp.prefetchBinaries': true },
      getConnections,
    })

    // Repeated workspace/state events keep re-entering the remote branch, but a
    // non-connected authority must not turn into an unbounded re-seed loop.
    for (let i = 0; i < 5; i++) {
      workspace.setCurrent(workspace.current)
      remoteStatus._emitter.fire({ authority: AUTHORITY, state: 'failed' })
    }
    await settle()

    // Initial seed + exactly one on-demand retry, regardless of event count.
    expect(getConnections).toHaveBeenCalledTimes(2)
    // No remote maintenance ever ran.
    expect(claude.cleanupStaleVersions).not.toHaveBeenCalledWith(AUTHORITY)
    expect(claude.prefetch).not.toHaveBeenCalled()
    expect(codex.cleanupStaleVersions).not.toHaveBeenCalledWith(AUTHORITY)
    expect(codex.prefetch).not.toHaveBeenCalled()

    contribution.dispose()
  })
})
