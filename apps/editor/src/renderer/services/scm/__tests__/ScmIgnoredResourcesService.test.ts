/*---------------------------------------------------------------------------------------------
 *  Tests for ScmIgnoredResourcesService — pull-style git-ignored cache with batch
 *  check-ignore resolution, negative caching, invalidation and failure fallback.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Emitter, observableValue, REMOTE_SCHEME, URI } from '@universe-editor/platform'
import type {
  ICommandService,
  IFileChangeEvent,
  IFileWatcherService,
  ILoggerService,
  IWorkspace,
  IWorkspaceService,
} from '@universe-editor/platform'
import type { IScmService, IScmSourceControlModel } from '../../extensions/ScmService.js'
import { ScmIgnoredResourcesService } from '../ScmIgnoredResourcesService.js'

const ROOT = 'D:/repo'
const REMOTE_AUTHORITY = 'myhost'
const REMOTE_ROOT = '/home/u/repo'

/** `remote-ssh://<authority>/<path>`. */
function remote(path: string, authority = REMOTE_AUTHORITY): URI {
  return URI.from({ scheme: REMOTE_SCHEME, authority, path })
}

function gitSourceControl(rootUri = ROOT): IScmSourceControlModel {
  return { id: 'git', rootUri } as unknown as IScmSourceControlModel
}

function scmOf(controls: readonly IScmSourceControlModel[]): IScmService {
  return { sourceControls: observableValue('sc', controls) } as unknown as IScmService
}

interface Harness {
  service: ScmIgnoredResourcesService
  executeCommand: ReturnType<typeof vi.fn>
  fileEvents: Emitter<readonly IFileChangeEvent[]>
  workspaceEvents: Emitter<IWorkspace | null>
  logger: { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> }
}

function makeService(
  executeCommand: ReturnType<typeof vi.fn>,
  scm?: IScmService,
  /** Workspace folder; a remote folder makes the window remote-scoped. */
  folder: URI = URI.file(ROOT),
): Harness {
  const fileEvents = new Emitter<readonly IFileChangeEvent[]>()
  const workspaceEvents = new Emitter<IWorkspace | null>()
  const watcher = { onDidChangeFiles: fileEvents.event } as unknown as IFileWatcherService
  const workspace = {
    onDidChangeWorkspace: workspaceEvents.event,
    current: { folder },
  } as unknown as IWorkspaceService
  const logger = { warn: vi.fn(), debug: vi.fn() }
  const loggerService = { createLogger: () => logger } as unknown as ILoggerService
  const commands = { executeCommand } as unknown as ICommandService
  const service = new ScmIgnoredResourcesService(
    scm ?? scmOf([gitSourceControl()]),
    commands,
    watcher,
    workspace,
    loggerService,
  )
  return { service, executeCommand, fileEvents, workspaceEvents, logger }
}

describe('ScmIgnoredResourcesService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('dedupes a batch, resolves via check-ignore and caches answers', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValue(['D:/repo/node_modules', 'D:/repo/node_modules/x.js'])
    const { service, executeCommand: exec } = makeService(executeCommand)

    expect(service.isIgnored(URI.file(`${ROOT}/a.txt`))).toBeUndefined()
    expect(service.isIgnored(URI.file(`${ROOT}/a.txt`))).toBeUndefined()
    expect(service.isIgnored(URI.file(`${ROOT}/node_modules`))).toBeUndefined()
    expect(service.isIgnored(URI.file(`${ROOT}/node_modules/x.js`))).toBeUndefined()

    await vi.advanceTimersByTimeAsync(200)

    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith('git.checkIgnore', [
      `${ROOT}/a.txt`,
      `${ROOT}/node_modules`,
      `${ROOT}/node_modules/x.js`,
    ])
    expect(service.isIgnored(URI.file(`${ROOT}/a.txt`))).toBe(false)
    expect(service.isIgnored(URI.file(`${ROOT}/node_modules`))).toBe(true)
    expect(service.isIgnored(URI.file(`${ROOT}/node_modules/x.js`))).toBe(true)

    // Cache hit: no further enqueue / command.
    service.isIgnored(URI.file(`${ROOT}/a.txt`))
    service.isIgnored(URI.file(`${ROOT}/node_modules`))
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('caches negative answers and paths outside any repo as not ignored', async () => {
    const executeCommand = vi.fn().mockResolvedValue(['D:/repo/dist'])
    const { service, executeCommand: exec } = makeService(executeCommand)

    service.isIgnored(URI.file(`${ROOT}/src.ts`))
    service.isIgnored(URI.file('D:/elsewhere/file.ts'))
    await vi.advanceTimersByTimeAsync(200)

    // Only the repo-owned path goes through the command; the outside path is
    // resolved as not-ignored without a provider.
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith('git.checkIgnore', [`${ROOT}/src.ts`])
    expect(service.isIgnored(URI.file(`${ROOT}/src.ts`))).toBe(false)
    expect(service.isIgnored(URI.file('D:/elsewhere/file.ts'))).toBe(false)
  })

  it('invalidates and re-queries when a .gitignore changes', async () => {
    const executeCommand = vi.fn().mockResolvedValue(['D:/repo/cache'])
    const { service, fileEvents, executeCommand: exec } = makeService(executeCommand)

    service.isIgnored(URI.file(`${ROOT}/cache`))
    await vi.advanceTimersByTimeAsync(200)
    expect(service.isIgnored(URI.file(`${ROOT}/cache`))).toBe(true)

    fileEvents.fire([{ type: 'modified', resource: URI.file(`${ROOT}/.gitignore`) }])
    expect(service.isIgnored(URI.file(`${ROOT}/cache`))).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('invalidates when the source controls change (repo open/close)', async () => {
    const executeCommand = vi.fn().mockResolvedValue(['D:/repo/x'])
    const controls = observableValue<readonly IScmSourceControlModel[]>('sc', [gitSourceControl()])
    const { service } = makeService(executeCommand, {
      sourceControls: controls,
    } as unknown as IScmService)

    service.isIgnored(URI.file(`${ROOT}/x`))
    await vi.advanceTimersByTimeAsync(200)
    expect(service.isIgnored(URI.file(`${ROOT}/x`))).toBe(true)

    controls.set([], undefined)
    expect(service.isIgnored(URI.file(`${ROOT}/x`))).toBeUndefined()
  })

  it('treats an unregistered command as not ignored (no repeat queries)', async () => {
    const executeCommand = vi.fn().mockResolvedValue(undefined)
    const { service, executeCommand: exec } = makeService(executeCommand)

    service.isIgnored(URI.file(`${ROOT}/x`))
    await vi.advanceTimersByTimeAsync(200)
    expect(service.isIgnored(URI.file(`${ROOT}/x`))).toBe(false)

    service.isIgnored(URI.file(`${ROOT}/x`))
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('treats a failing check-ignore as not ignored and logs a warning', async () => {
    const executeCommand = vi.fn().mockRejectedValue(new Error('boom'))
    const { service, logger } = makeService(executeCommand)

    service.isIgnored(URI.file(`${ROOT}/x`))
    await vi.advanceTimersByTimeAsync(200)
    expect(service.isIgnored(URI.file(`${ROOT}/x`))).toBe(false)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('discards a batch whose result lands after an invalidation', async () => {
    let resolveCmd: ((v: readonly string[] | undefined) => void) | undefined
    const executeCommand = vi.fn(
      () => new Promise<readonly string[] | undefined>((resolve) => (resolveCmd = resolve)),
    )
    const { service, fileEvents, executeCommand: exec } = makeService(executeCommand)

    service.isIgnored(URI.file(`${ROOT}/cache`))
    // Start the flush; executeCommand hangs while the command is in flight.
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)

    // A .gitignore save invalidates while the old-rule result is still pending.
    fileEvents.fire([{ type: 'modified', resource: URI.file(`${ROOT}/.gitignore`) }])

    // The stale answer (old rules) resolves; the flush must drop it.
    resolveCmd!(['D:/repo/cache'])
    await vi.advanceTimersByTimeAsync(0)

    // Cache stays empty, so the path re-enqueues instead of returning a stale true.
    expect(service.isIgnored(URI.file(`${ROOT}/cache`))).toBeUndefined()

    // Re-query under the new rules: no longer ignored.
    executeCommand.mockResolvedValue([])
    await vi.advanceTimersByTimeAsync(200)
    expect(service.isIgnored(URI.file(`${ROOT}/cache`))).toBe(false)
    expect(exec).toHaveBeenCalledTimes(2)
  })

  describe('remote workspace', () => {
    /** Harness scoped to a remote workspace with a remote git root. */
    function makeRemote(executeCommand: ReturnType<typeof vi.fn>): Harness {
      return makeService(
        executeCommand,
        scmOf([gitSourceControl(REMOTE_ROOT)]),
        remote(REMOTE_ROOT),
      )
    }

    it('resolves remote resources through check-ignore with host paths', async () => {
      // The remote git extension reports bare host paths, so the command must be
      // called with `/home/u/repo/...`, never a remote-ssh URI string.
      const executeCommand = vi.fn().mockResolvedValue([`${REMOTE_ROOT}/node_modules`])
      const { service, executeCommand: exec } = makeRemote(executeCommand)

      expect(service.isIgnored(remote(`${REMOTE_ROOT}/node_modules`))).toBeUndefined()
      expect(service.isIgnored(remote(`${REMOTE_ROOT}/src.ts`))).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)

      expect(exec).toHaveBeenCalledWith('git.checkIgnore', [
        `${REMOTE_ROOT}/node_modules`,
        `${REMOTE_ROOT}/src.ts`,
      ])
      expect(service.isIgnored(remote(`${REMOTE_ROOT}/node_modules`))).toBe(true)
      expect(service.isIgnored(remote(`${REMOTE_ROOT}/src.ts`))).toBe(false)
    })

    it('reports an off-host resource as not ignored without querying', async () => {
      const executeCommand = vi.fn().mockResolvedValue([])
      const { service, executeCommand: exec } = makeRemote(executeCommand)

      // A client-local editor and another host's resource are both off-host.
      expect(service.isIgnored(URI.file(`${ROOT}/node_modules`))).toBe(false)
      expect(service.isIgnored(remote(`${REMOTE_ROOT}/node_modules`, 'otherhost'))).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      expect(exec).not.toHaveBeenCalled()
    })

    it('invalidates when a remote .gitignore changes', async () => {
      const executeCommand = vi.fn().mockResolvedValue([`${REMOTE_ROOT}/cache`])
      const { service, fileEvents, executeCommand: exec } = makeRemote(executeCommand)

      service.isIgnored(remote(`${REMOTE_ROOT}/cache`))
      await vi.advanceTimersByTimeAsync(200)
      expect(service.isIgnored(remote(`${REMOTE_ROOT}/cache`))).toBe(true)

      // Remote watcher events arrive as remote-ssh URIs (authority reattached).
      fileEvents.fire([{ type: 'modified', resource: remote(`${REMOTE_ROOT}/.gitignore`) }])
      expect(service.isIgnored(remote(`${REMOTE_ROOT}/cache`))).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)
      expect(exec).toHaveBeenCalledTimes(2)
    })

    it('ignores an off-host .gitignore event', async () => {
      const executeCommand = vi.fn().mockResolvedValue([`${REMOTE_ROOT}/cache`])
      const { service, fileEvents, executeCommand: exec } = makeRemote(executeCommand)

      service.isIgnored(remote(`${REMOTE_ROOT}/cache`))
      await vi.advanceTimersByTimeAsync(200)
      expect(service.isIgnored(remote(`${REMOTE_ROOT}/cache`))).toBe(true)

      fileEvents.fire([{ type: 'modified', resource: URI.file(`${ROOT}/.gitignore`) }])
      // Cache survives: a local .gitignore says nothing about the remote repo.
      expect(service.isIgnored(remote(`${REMOTE_ROOT}/cache`))).toBe(true)
      expect(exec).toHaveBeenCalledTimes(1)
    })
  })
})
