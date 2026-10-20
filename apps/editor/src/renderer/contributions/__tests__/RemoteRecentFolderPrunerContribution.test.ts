/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/contributions/RemoteRecentFolderPrunerContribution.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  URI,
  type IFileService,
  type IWorkspace,
  type IWorkspaceService,
} from '@universe-editor/platform'
import {
  isMissingRemoteFolderError,
  RemoteRecentFolderPrunerContribution,
} from '../RemoteRecentFolderPrunerContribution.js'

const REMOTE = URI.parse('remote-ssh://e2e-local/home/dev/gone')
const LOCAL = URI.file('/tmp/local')

function errno(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

interface FakeWorkspace {
  readonly service: IWorkspaceService
  readonly removeRecent: ReturnType<typeof vi.fn>
  readonly emitter: Emitter<IWorkspace | null>
  setCurrent(workspace: IWorkspace | null): void
}

function makeWorkspace(
  initial: URI | null,
  whenReady: Promise<void> = Promise.resolve(),
): FakeWorkspace {
  const emitter = new Emitter<IWorkspace | null>()
  const removeRecent = vi.fn().mockResolvedValue(undefined)
  let current: IWorkspace | null = initial ? { folder: initial, name: 'ws' } : null
  const service = {
    _serviceBrand: undefined,
    get current() {
      return current
    },
    onDidChangeWorkspace: emitter.event,
    recent: [],
    onDidChangeRecent: emitter.event,
    whenReady,
    openFolder: vi.fn(),
    closeFolder: vi.fn(),
    removeRecent,
    clearRecent: vi.fn(),
  } as unknown as IWorkspaceService
  return {
    service,
    removeRecent,
    emitter,
    setCurrent(workspace) {
      current = workspace
    },
  }
}

function makeFileService(stat: (folder: URI) => Promise<unknown>): {
  service: IFileService
  stat: ReturnType<typeof vi.fn>
} {
  const statFn = vi.fn(stat)
  return { service: { stat: statFn } as unknown as IFileService, stat: statFn }
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('RemoteRecentFolderPrunerContribution', () => {
  it('removes the current remote folder from recents on an authoritative ENOENT', async () => {
    const workspace = makeWorkspace(REMOTE)
    const files = makeFileService(async () => {
      throw errno('ENOENT')
    })
    const contribution = new RemoteRecentFolderPrunerContribution(workspace.service, files.service)

    await vi.waitFor(() => expect(workspace.removeRecent).toHaveBeenCalledWith(REMOTE))
    contribution.dispose()
  })

  it.each(['ENOTDIR', 'EACCES'])('keeps the entry on %s', async (code) => {
    const workspace = makeWorkspace(REMOTE)
    const files = makeFileService(async () => {
      throw errno(code)
    })
    const contribution = new RemoteRecentFolderPrunerContribution(workspace.service, files.service)

    await flush()
    expect(files.stat).toHaveBeenCalledTimes(1)
    expect(workspace.removeRecent).not.toHaveBeenCalled()
    contribution.dispose()
  })

  it('keeps the entry when the error carries no code', async () => {
    const workspace = makeWorkspace(REMOTE)
    const files = makeFileService(async () => {
      throw new Error('connection lost')
    })
    const contribution = new RemoteRecentFolderPrunerContribution(workspace.service, files.service)

    await flush()
    expect(workspace.removeRecent).not.toHaveBeenCalled()
    contribution.dispose()
  })

  it('keeps the entry when stat succeeds', async () => {
    const workspace = makeWorkspace(REMOTE)
    const files = makeFileService(async () => ({ isDirectory: true }))
    const contribution = new RemoteRecentFolderPrunerContribution(workspace.service, files.service)

    await flush()
    expect(workspace.removeRecent).not.toHaveBeenCalled()
    contribution.dispose()
  })

  it('never probes local workspaces', async () => {
    const workspace = makeWorkspace(LOCAL)
    const files = makeFileService(async () => {
      throw errno('ENOENT')
    })
    const contribution = new RemoteRecentFolderPrunerContribution(workspace.service, files.service)

    await flush()
    expect(files.stat).not.toHaveBeenCalled()
    contribution.dispose()
  })

  it('prunes after a same-window switch to a remote workspace', async () => {
    const workspace = makeWorkspace(LOCAL)
    const files = makeFileService(async () => {
      throw errno('ENOENT')
    })
    const contribution = new RemoteRecentFolderPrunerContribution(workspace.service, files.service)

    const remote = { folder: REMOTE, name: 'gone' }
    workspace.setCurrent(remote)
    workspace.emitter.fire(remote)

    await vi.waitFor(() => expect(workspace.removeRecent).toHaveBeenCalledWith(REMOTE))
    contribution.dispose()
  })

  it('does not remove when the user switched away while a missing folder was in flight', async () => {
    const workspace = makeWorkspace(REMOTE)
    const pending = deferred()
    const files = makeFileService(() => pending.promise)
    const contribution = new RemoteRecentFolderPrunerContribution(workspace.service, files.service)

    await vi.waitFor(() => expect(files.stat).toHaveBeenCalledTimes(1))
    workspace.setCurrent({ folder: LOCAL, name: 'local' })
    pending.reject(errno('ENOENT'))
    await flush()

    expect(workspace.removeRecent).not.toHaveBeenCalled()
    contribution.dispose()
  })

  it('does not remove after the contribution is disposed while stat was in flight', async () => {
    const workspace = makeWorkspace(REMOTE)
    const pending = deferred()
    const files = makeFileService(() => pending.promise)
    const contribution = new RemoteRecentFolderPrunerContribution(workspace.service, files.service)

    await vi.waitFor(() => expect(files.stat).toHaveBeenCalledTimes(1))
    contribution.dispose()
    pending.reject(errno('ENOENT'))
    await flush()

    expect(workspace.removeRecent).not.toHaveBeenCalled()
  })

  it('does not probe after being disposed before startup settles', async () => {
    const workspace = makeWorkspace(REMOTE)
    const files = makeFileService(async () => {
      throw errno('ENOENT')
    })
    const contribution = new RemoteRecentFolderPrunerContribution(workspace.service, files.service)

    contribution.dispose()
    await flush()

    expect(files.stat).not.toHaveBeenCalled()
  })

  it('coalesces concurrent checks of the same remote folder', async () => {
    const workspace = makeWorkspace(REMOTE)
    const pending = deferred()
    const files = makeFileService(() => pending.promise)
    const contribution = new RemoteRecentFolderPrunerContribution(workspace.service, files.service)

    await vi.waitFor(() => expect(files.stat).toHaveBeenCalledTimes(1))
    const current = { folder: REMOTE, name: 'gone' }
    workspace.setCurrent(current)
    workspace.emitter.fire(current)
    await flush()

    expect(files.stat).toHaveBeenCalledTimes(1)
    pending.resolve({ isDirectory: true })
    contribution.dispose()
  })
})

describe('isMissingRemoteFolderError', () => {
  it('only accepts ENOENT', () => {
    expect(isMissingRemoteFolderError(errno('ENOENT'))).toBe(true)
    expect(isMissingRemoteFolderError(errno('ENOTDIR'))).toBe(false)
    expect(isMissingRemoteFolderError(errno('EACCES'))).toBe(false)
    expect(isMissingRemoteFolderError(new Error('boom'))).toBe(false)
    expect(isMissingRemoteFolderError(null)).toBe(false)
  })
})
