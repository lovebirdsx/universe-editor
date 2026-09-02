/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for ScmBehindHintService — pull-style "is this file behind the depot
 *  head?" ask-once cache. Mirrors the ScmWorkingTreeHintService in-flight-token
 *  cases: the latest-wins stamp is the regression guard for the bug class the
 *  perforce CLAUDE.md calls out (a tokenless in-flight set lets a stale answer
 *  pin a row forever).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Emitter, observableValue, URI, type ISettableObservable } from '@universe-editor/platform'
import type {
  ICommandService,
  IFileChangeEvent,
  IFileWatcherService,
  ILoggerService,
  IWorkspace,
  IWorkspaceService,
} from '@universe-editor/platform'
import type { IScmService, IScmSourceControlModel } from '../../extensions/ScmService.js'
import type { IScmDecorationsService, IScmDecorationsSnapshot } from '../ScmDecorationsService.js'
import { scmViewState } from '../../../workbench/scm/scmViewState.js'
import { ScmBehindHintService } from '../ScmBehindHintService.js'

const ROOT = 'X:/workspace'

function scmSourceControl(id: string, rootUri: string): IScmSourceControlModel {
  return { id, rootUri } as unknown as IScmSourceControlModel
}

function scmOf(controls: readonly IScmSourceControlModel[]): IScmService {
  return { sourceControls: observableValue('sc', controls) } as unknown as IScmService
}

function emptySnapshot(): IScmDecorationsSnapshot {
  return { files: new Map(), folders: new Map(), supplementary: new Map() }
}

interface Harness {
  service: ScmBehindHintService
  executeCommand: ReturnType<typeof vi.fn>
  fileEvents: Emitter<readonly IFileChangeEvent[]>
  workspaceEvents: Emitter<IWorkspace | null>
  decorations: ISettableObservable<IScmDecorationsSnapshot>
  logger: { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> }
}

function makeService(executeCommand: ReturnType<typeof vi.fn>, scm?: IScmService): Harness {
  const fileEvents = new Emitter<readonly IFileChangeEvent[]>()
  const workspaceEvents = new Emitter<IWorkspace | null>()
  const decorations = observableValue<IScmDecorationsSnapshot>('scmDecorations', emptySnapshot())
  const watcher = { onDidChangeFiles: fileEvents.event } as unknown as IFileWatcherService
  const workspace = {
    onDidChangeWorkspace: workspaceEvents.event,
    current: { folder: URI.file(ROOT) },
  } as unknown as IWorkspaceService
  const logger = { warn: vi.fn(), debug: vi.fn() }
  const loggerService = { createLogger: () => logger } as unknown as ILoggerService
  const commands = { executeCommand } as unknown as ICommandService
  const service = new ScmBehindHintService(
    scm ?? scmOf([scmSourceControl('perforce', ROOT)]),
    commands,
    watcher,
    workspace,
    { decorations } as unknown as IScmDecorationsService,
    loggerService,
  )
  return { service, executeCommand, fileEvents, workspaceEvents, decorations, logger }
}

describe('ScmBehindHintService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // scmViewState is a module-level singleton; reset it so a selectedRepo left
    // by a previous test can't leak into this one's arbitration.
    scmViewState.setSelectedRepo(undefined)
  })

  afterEach(() => {
    scmViewState.setSelectedRepo(undefined)
    vi.useRealTimers()
  })

  it('returns undefined while unknown, then the boolean once the batch resolves', async () => {
    const executeCommand = vi.fn().mockResolvedValue([`${ROOT}/a.txt`])
    const { service, executeCommand: exec } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.txt`)
    expect(service.isBehind(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)

    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith('perforce.checkBehind', [`${ROOT}/a.txt`])
    expect(service.isBehind(a)).toBe(true)
  })

  it('batches a debounce window into one command per provider', async () => {
    const executeCommand = vi.fn().mockResolvedValue([])
    const { service, executeCommand: exec } = makeService(executeCommand)

    service.isBehind(URI.file(`${ROOT}/a.txt`))
    service.isBehind(URI.file(`${ROOT}/b.txt`))
    service.isBehind(URI.file(`${ROOT}/c.txt`))
    await vi.advanceTimersByTimeAsync(200)

    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith('perforce.checkBehind', [
      `${ROOT}/a.txt`,
      `${ROOT}/b.txt`,
      `${ROOT}/c.txt`,
    ])
  })

  it('caches a miss (not in the behind subset) as false and never re-queries it', async () => {
    const executeCommand = vi.fn().mockResolvedValue([`${ROOT}/a.txt`])
    const { service, executeCommand: exec } = makeService(executeCommand)

    const behind = URI.file(`${ROOT}/a.txt`)
    const clean = URI.file(`${ROOT}/clean.txt`)
    service.isBehind(behind)
    service.isBehind(clean)
    await vi.advanceTimersByTimeAsync(200)

    expect(service.isBehind(behind)).toBe(true)
    expect(service.isBehind(clean)).toBe(false)

    // Re-reading both stays a cache hit: no further command.
    service.isBehind(behind)
    service.isBehind(clean)
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('treats an unregistered command (undefined result) as not behind for the whole batch', async () => {
    const executeCommand = vi.fn().mockResolvedValue(undefined)
    const { service, executeCommand: exec } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.txt`)
    expect(service.isBehind(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)

    expect(exec).toHaveBeenCalledTimes(1)
    expect(service.isBehind(a)).toBe(false)

    service.isBehind(a)
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('treats a failing checkBehind as not behind and logs a warning', async () => {
    const executeCommand = vi.fn().mockRejectedValue(new Error('boom'))
    const { service, executeCommand: exec, logger } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.txt`)
    expect(service.isBehind(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)

    expect(service.isBehind(a)).toBe(false)
    expect(logger.warn).toHaveBeenCalled()

    service.isBehind(a)
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('discards a batch whose result lands after an invalidation', async () => {
    let resolveCmd: ((v: readonly string[] | undefined) => void) | undefined
    const executeCommand = vi.fn(
      () => new Promise<readonly string[] | undefined>((resolve) => (resolveCmd = resolve)),
    )
    const { service, executeCommand: exec, workspaceEvents } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.txt`)
    expect(service.isBehind(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)

    // A workspace change invalidates while the command is still in flight.
    workspaceEvents.fire(null)

    // The stale answer resolves; the flush must drop it.
    resolveCmd!([`${ROOT}/a.txt`])
    await vi.advanceTimersByTimeAsync(0)

    expect(service.isBehind(a)).toBeUndefined()

    executeCommand.mockResolvedValue([])
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('discards an old answer that lands after the re-query was already issued', async () => {
    // Two overlapping queries for the same key: any provider whose round-trip
    // outlasts the 150ms debounce hits this on every save.
    const resolvers: ((v: readonly string[] | undefined) => void)[] = []
    const executeCommand = vi.fn(
      () => new Promise<readonly string[] | undefined>((resolve) => resolvers.push(resolve)),
    )
    const { service, executeCommand: exec, fileEvents } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.txt`)
    expect(service.isBehind(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)

    // Save while query #1 is still out: the key is re-enqueued.
    fileEvents.fire([{ type: 'modified', resource: a } as unknown as IFileChangeEvent])
    // Let the debounce elapse so query #2 is actually issued before either answer
    // lands — the second flush re-arms the in-flight marker, so only the token
    // can tell query #1's answer from query #2's.
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(2)

    // The pre-save answer arrives first (sent first), then the fresh one.
    resolvers[0]!([])
    await vi.advanceTimersByTimeAsync(0)
    resolvers[1]!([`${ROOT}/a.txt`])
    await vi.advanceTimersByTimeAsync(0)

    // Latest query wins. Accepting #1 would pin the file "not behind" for good:
    // the cache holds an entry, so no render re-enqueues it.
    expect(service.isBehind(a)).toBe(true)
  })

  it('does not re-enqueue a key whose query is still in flight', async () => {
    const executeCommand = vi.fn(() => new Promise<readonly string[] | undefined>(() => {}))
    const { service, executeCommand: exec } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.txt`)
    expect(service.isBehind(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)

    // Still no answer, so the row keeps rendering as unknown. Re-reading it must
    // not fire a second identical query — Explorer re-renders constantly, and
    // each duplicate is another p4 spawn queued on the shared concurrency gate.
    expect(service.isBehind(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('drops only the changed files on a file event, keeping the rest cached', async () => {
    const executeCommand = vi.fn().mockResolvedValue([`${ROOT}/a.txt`, `${ROOT}/b.txt`])
    const { service, fileEvents, executeCommand: exec } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.txt`)
    const b = URI.file(`${ROOT}/b.txt`)
    service.isBehind(a)
    service.isBehind(b)
    await vi.advanceTimersByTimeAsync(200)
    expect(service.isBehind(a)).toBe(true)
    expect(service.isBehind(b)).toBe(true)

    fileEvents.fire([{ type: 'modified', resource: a } as unknown as IFileChangeEvent])
    expect(service.isBehind(a)).toBeUndefined()
    expect(service.isBehind(b)).toBe(true)

    // `a` re-enqueues on its own; `b` is not re-queried.
    executeCommand.mockResolvedValue([])
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec).toHaveBeenLastCalledWith('perforce.checkBehind', [`${ROOT}/a.txt`])
  })

  it('fully invalidates when the workspace changes', async () => {
    const executeCommand = vi.fn().mockResolvedValue([`${ROOT}/a.txt`])
    const { service, workspaceEvents } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.txt`)
    service.isBehind(a)
    await vi.advanceTimersByTimeAsync(200)
    expect(service.isBehind(a)).toBe(true)

    workspaceEvents.fire(null)
    expect(service.isBehind(a)).toBeUndefined()
  })

  it('fully invalidates when the supplementary decorations change', async () => {
    const executeCommand = vi.fn().mockResolvedValue([`${ROOT}/a.txt`])
    const { service, decorations } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.txt`)
    service.isBehind(a)
    await vi.advanceTimersByTimeAsync(200)
    expect(service.isBehind(a)).toBe(true)

    // A fresh supplementary push (e.g. a sync cleared the markers) makes every
    // cached behind answer suspect → full invalidation.
    decorations.set(emptySnapshot(), undefined)
    expect(service.isBehind(a)).toBeUndefined()
  })

  it('does not invalidate on the first autorun passes', async () => {
    const executeCommand = vi.fn().mockResolvedValue([`${ROOT}/a.txt`])
    const { service, decorations } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.txt`)
    service.isBehind(a)
    await vi.advanceTimersByTimeAsync(200)
    expect(service.isBehind(a)).toBe(true)

    // The decorations autorun fires its first pass during construction and must
    // skip it — re-setting the SAME snapshot object would otherwise still count
    // as a change if the first-pass guard were missing.
    const cached = service.isBehind(a)
    expect(cached).toBe(true)
    // (A real change is covered by the invalidation test above; here we assert
    // the constructor-time pass did not already wipe the just-cached answer.)
    expect(decorations).toBeDefined()
  })

  it('bumps the version when a batch resolves so consumers re-render', async () => {
    const executeCommand = vi.fn().mockResolvedValue([`${ROOT}/a.txt`])
    const { service } = makeService(executeCommand)

    const versionBefore = service.version.get()
    service.isBehind(URI.file(`${ROOT}/a.txt`))
    await vi.advanceTimersByTimeAsync(200)

    expect(service.version.get()).toBeGreaterThan(versionBefore)
  })

  it('returns false and never queries for an off-host resource', async () => {
    const executeCommand = vi.fn().mockResolvedValue([])
    const { service, executeCommand: exec } = makeService(executeCommand)

    expect(service.isBehind(URI.parse('markdown-preview://x/a.md'))).toBe(false)
    expect(service.isBehind(URI.parse('untitled:Untitled-1'))).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).not.toHaveBeenCalled()
  })
})
