/*---------------------------------------------------------------------------------------------
 *  Tests for ScmIgnoredResourcesService — pull-style git-ignored cache with batch
 *  check-ignore resolution, negative caching, invalidation and failure fallback.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Emitter, observableValue, URI } from '@universe-editor/platform'
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

function makeService(executeCommand: ReturnType<typeof vi.fn>, scm?: IScmService): Harness {
  const fileEvents = new Emitter<readonly IFileChangeEvent[]>()
  const workspaceEvents = new Emitter<IWorkspace | null>()
  const watcher = { onDidChangeFiles: fileEvents.event } as unknown as IFileWatcherService
  const workspace = { onDidChangeWorkspace: workspaceEvents.event } as unknown as IWorkspaceService
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
})
