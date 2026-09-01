/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for ScmWorkingTreeHintService — pull-style on-disk-change cache with
 *  batch check-working-tree resolution, negative caching, per-provider bucketing,
 *  invalidation, stale-while-revalidate and LRU eviction.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  observableValue,
  REMOTE_SCHEME,
  URI,
  type ISettableObservable,
} from '@universe-editor/platform'
import type {
  ICommandService,
  IFileChangeEvent,
  IFileWatcherService,
  ILoggerService,
  IWorkspace,
  IWorkspaceService,
} from '@universe-editor/platform'
import type { WorkingTreeChangeDto } from '@universe-editor/extensions-common'
import type { IScmService, IScmSourceControlModel } from '../../extensions/ScmService.js'
import type { IScmDecorationsService, IScmDecorationsSnapshot } from '../ScmDecorationsService.js'
import { CACHE_LIMIT, ScmWorkingTreeHintService } from '../ScmWorkingTreeHintService.js'

const ROOT = 'X:/workspace'
const REMOTE_AUTHORITY = 'myhost'
const REMOTE_ROOT = '/home/testuser/repo'

/** `remote-ssh://<authority>/<path>`. */
function remote(path: string, authority = REMOTE_AUTHORITY): URI {
  return URI.from({ scheme: REMOTE_SCHEME, authority, path })
}

function scmSourceControl(id: string, rootUri: string): IScmSourceControlModel {
  return { id, rootUri } as unknown as IScmSourceControlModel
}

function scmOf(controls: readonly IScmSourceControlModel[]): IScmService {
  return { sourceControls: observableValue('sc', controls) } as unknown as IScmService
}

function emptySnapshot(): IScmDecorationsSnapshot {
  return { files: new Map(), folders: new Map(), supplementary: new Map() }
}

function dto(path: string, overrides: Partial<WorkingTreeChangeDto> = {}): WorkingTreeChangeDto {
  return { path, letter: 'M', color: '#e2c08d', ...overrides }
}

interface Harness {
  service: ScmWorkingTreeHintService
  executeCommand: ReturnType<typeof vi.fn>
  fileEvents: Emitter<readonly IFileChangeEvent[]>
  workspaceEvents: Emitter<IWorkspace | null>
  decorations: ISettableObservable<IScmDecorationsSnapshot>
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
  const decorations = observableValue<IScmDecorationsSnapshot>('scmDecorations', emptySnapshot())
  const watcher = { onDidChangeFiles: fileEvents.event } as unknown as IFileWatcherService
  const workspace = {
    onDidChangeWorkspace: workspaceEvents.event,
    current: { folder },
  } as unknown as IWorkspaceService
  const logger = { warn: vi.fn(), debug: vi.fn() }
  const loggerService = { createLogger: () => logger } as unknown as ILoggerService
  const commands = { executeCommand } as unknown as ICommandService
  const service = new ScmWorkingTreeHintService(
    scm ?? scmOf([scmSourceControl('perforce', ROOT)]),
    commands,
    watcher,
    workspace,
    { decorations } as unknown as IScmDecorationsService,
    loggerService,
  )
  return { service, executeCommand, fileEvents, workspaceEvents, decorations, logger }
}

describe('ScmWorkingTreeHintService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns undefined for an unknown path, then the hint once the batch resolves', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValue([dto(`${ROOT}/a.txt`, { color: '#111111', letter: 'A' })])
    const { service, executeCommand: exec } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.txt`)
    expect(service.getHint(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)

    expect(exec).toHaveBeenCalledTimes(1)
    expect(service.getHint(a)).toEqual({ color: '#111111', letter: 'A' })
  })

  it('batches a debounce window and buckets paths by owning provider', async () => {
    const executeCommand = vi.fn().mockResolvedValue([])
    const scm = scmOf([
      scmSourceControl('git', `${ROOT}/git`),
      scmSourceControl('perforce', `${ROOT}/p4`),
    ])
    const { service, executeCommand: exec } = makeService(executeCommand, scm)

    expect(service.getHint(URI.file(`${ROOT}/git/a.ts`))).toBeUndefined()
    expect(service.getHint(URI.file(`${ROOT}/git/b.ts`))).toBeUndefined()
    expect(service.getHint(URI.file(`${ROOT}/p4/c.ts`))).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)

    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec).toHaveBeenCalledWith('git.checkWorkingTree', [
      `${ROOT}/git/a.ts`,
      `${ROOT}/git/b.ts`,
    ])
    expect(exec).toHaveBeenCalledWith('perforce.checkWorkingTree', [`${ROOT}/p4/c.ts`])
  })

  it('caches a path missing from the result as clean and never re-queries it', async () => {
    const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/a.txt`)])
    const { service, executeCommand: exec } = makeService(executeCommand)

    const missing = URI.file(`${ROOT}/missing.txt`)
    const present = URI.file(`${ROOT}/a.txt`)
    expect(service.getHint(missing)).toBeUndefined()
    expect(service.getHint(present)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)

    expect(exec).toHaveBeenCalledTimes(1)
    expect(service.getHint(present)).toEqual({ color: '#e2c08d', letter: 'M' })
    // The command did not answer for `missing`, so it is cached clean.
    expect(service.getHint(missing)).toBeUndefined()

    // Re-reading both stays a cache hit: no further command.
    service.getHint(missing)
    service.getHint(present)
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('treats an unregistered command (undefined result) as clean for the whole batch', async () => {
    const executeCommand = vi.fn().mockResolvedValue(undefined)
    const { service, executeCommand: exec } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    expect(service.getHint(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)

    expect(exec).toHaveBeenCalledTimes(1)
    expect(service.getHint(a)).toBeUndefined()

    service.getHint(a)
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('treats a failing check-working-tree as clean and logs a warning', async () => {
    const executeCommand = vi.fn().mockRejectedValue(new Error('boom'))
    const { service, executeCommand: exec, logger } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    expect(service.getHint(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)

    expect(service.getHint(a)).toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()

    service.getHint(a)
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('discards a batch whose result lands after an invalidation', async () => {
    let resolveCmd: ((v: readonly WorkingTreeChangeDto[] | undefined) => void) | undefined
    const executeCommand = vi.fn(
      () =>
        new Promise<readonly WorkingTreeChangeDto[] | undefined>(
          (resolve) => (resolveCmd = resolve),
        ),
    )
    const { service, executeCommand: exec, workspaceEvents } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    expect(service.getHint(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)

    // A workspace change invalidates while the command is still in flight.
    workspaceEvents.fire(null)

    // The stale answer resolves; the flush must drop it.
    resolveCmd!([dto(`${ROOT}/a.ts`)])
    await vi.advanceTimersByTimeAsync(0)

    // Cache stays empty, so the path re-enqueues instead of returning a stale hint.
    expect(service.getHint(a)).toBeUndefined()
    expect(exec).toHaveBeenCalledTimes(1)

    executeCommand.mockResolvedValue([])
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('discards an in-flight answer overtaken by a file event, and re-queries', async () => {
    let resolveCmd: ((v: readonly WorkingTreeChangeDto[] | undefined) => void) | undefined
    const executeCommand = vi.fn(
      () =>
        new Promise<readonly WorkingTreeChangeDto[] | undefined>(
          (resolve) => (resolveCmd = resolve),
        ),
    )
    const { service, executeCommand: exec, fileEvents } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    expect(service.getHint(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)

    // The user saves the file while the query is still out. The answer about to
    // arrive describes the pre-save disk, so it must not be cached — and unlike a
    // full invalidation there is no generation bump to catch it.
    fileEvents.fire([{ resource: a, type: 0 } as unknown as IFileChangeEvent])

    resolveCmd!([dto(`${ROOT}/a.ts`, { letter: 'STALE' })])
    await vi.advanceTimersByTimeAsync(0)
    expect(service.getHint(a)).toBeUndefined()

    // The file event re-enqueued it on its own: no second render was needed to
    // notice the gap. (With `perforce.autoRefresh` off there is no later refresh
    // to fall back on, so self-healing here is the only correction.)
    executeCommand.mockResolvedValue([dto(`${ROOT}/a.ts`, { letter: 'FRESH' })])
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(2)
    expect(service.getHint(a)?.letter).toBe('FRESH')
  })

  it('discards an old answer that lands after the re-query was already issued', async () => {
    // Two overlapping queries for the same key. This is not exotic: any provider
    // whose round-trip outlasts the 150ms debounce hits it on every save.
    const resolvers: ((v: readonly WorkingTreeChangeDto[] | undefined) => void)[] = []
    const executeCommand = vi.fn(
      () =>
        new Promise<readonly WorkingTreeChangeDto[] | undefined>((resolve) =>
          resolvers.push(resolve),
        ),
    )
    const { service, executeCommand: exec, fileEvents } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    expect(service.getHint(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)

    // Save while query #1 is still out: the key is re-enqueued.
    fileEvents.fire([{ type: 'modified', resource: a }])
    // Let the debounce elapse so query #2 is actually *issued* before either
    // answer lands. That is what separates this from the file-event test above:
    // the second flush re-arms the in-flight marker, so the bookkeeping can no
    // longer tell query #1's answer from query #2's.
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(2)

    // The pre-save answer arrives first (it was sent first), then the fresh one.
    resolvers[0]!([])
    await vi.advanceTimersByTimeAsync(0)
    resolvers[1]!([dto(`${ROOT}/a.ts`, { letter: 'RC' })])
    await vi.advanceTimersByTimeAsync(0)

    // Latest query wins. Accepting #1 would pin the file "clean" for good: the
    // cache holds an entry, so no render re-enqueues it, and `_revalidate` only
    // walks keys already cached at the time it runs.
    expect(service.getHint(a)?.letter).toBe('RC')
  })

  it('does not re-enqueue a key whose query is still in flight', async () => {
    const executeCommand = vi.fn(
      () => new Promise<readonly WorkingTreeChangeDto[] | undefined>(() => {}),
    )
    const { service, executeCommand: exec } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    expect(service.getHint(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)

    // Still no answer, so the row keeps rendering as unknown. Re-reading it must
    // not fire a second identical query — Explorer re-renders constantly, and
    // each duplicate is another p4 spawn queued on the shared concurrency gate.
    expect(service.getHint(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('does not re-enqueue a stale cached key whose re-query is still in flight', async () => {
    let resolveCmd: ((v: readonly WorkingTreeChangeDto[] | undefined) => void) | undefined
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce([dto(`${ROOT}/a.ts`)])
      .mockImplementation(
        () =>
          new Promise<readonly WorkingTreeChangeDto[] | undefined>(
            (resolve) => (resolveCmd = resolve),
          ),
      )
    const { service, decorations, executeCommand: exec } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    service.getHint(a)
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)

    // Stale → the next read re-queries while keeping the old hint on screen.
    decorations.set(emptySnapshot(), undefined)
    expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(2)

    // A second refresh marks it stale again before the re-query has landed. The
    // cached-and-stale path needs the same in-flight guard as the cache-miss one,
    // or this fires a third query that answers the question already on the wire.
    decorations.set(emptySnapshot(), undefined)
    expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(2)

    // Once it lands the key is released, so a still-stale row queries again.
    resolveCmd!([dto(`${ROOT}/a.ts`, { letter: 'RC' })])
    await vi.advanceTimersByTimeAsync(0)
    expect(service.getHint(a)?.letter).toBe('RC')
  })

  it('fully invalidates when the workspace changes', async () => {
    const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/a.ts`)])
    const { service, workspaceEvents } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    expect(service.getHint(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })

    workspaceEvents.fire(null)
    expect(service.getHint(a)).toBeUndefined()
  })

  it('fully invalidates when the source controls change', async () => {
    const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/a.ts`)])
    const controls = observableValue<readonly IScmSourceControlModel[]>('sc', [
      scmSourceControl('perforce', ROOT),
    ])
    const { service } = makeService(executeCommand, {
      sourceControls: controls,
    } as unknown as IScmService)

    const a = URI.file(`${ROOT}/a.ts`)
    expect(service.getHint(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })

    controls.set([], undefined)
    expect(service.getHint(a)).toBeUndefined()
  })

  it('does not invalidate on the first autorun passes', () => {
    const executeCommand = vi.fn()
    const controls = observableValue<readonly IScmSourceControlModel[]>('sc', [
      scmSourceControl('perforce', ROOT),
    ])
    const { service } = makeService(executeCommand, {
      sourceControls: controls,
    } as unknown as IScmService)

    // Both the source-controls and decorations autoruns fire their first pass
    // during construction and must skip it: no invalidation, version still 0.
    expect(service.version.get()).toBe(0)
  })

  it('drops only the changed files on a file event, keeping the rest cached', async () => {
    const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/a.ts`), dto(`${ROOT}/b.ts`)])
    const { service, fileEvents, executeCommand: exec } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    const b = URI.file(`${ROOT}/b.ts`)
    expect(service.getHint(a)).toBeUndefined()
    expect(service.getHint(b)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })
    expect(service.getHint(b)).toEqual({ color: '#e2c08d', letter: 'M' })

    fileEvents.fire([{ type: 'modified', resource: a }])
    // Only `a` is dropped; `b` still hits the cache.
    expect(service.getHint(a)).toBeUndefined()
    expect(service.getHint(b)).toEqual({ color: '#e2c08d', letter: 'M' })

    // `a` re-enqueues on its own; `b` is not re-queried.
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec).toHaveBeenLastCalledWith('perforce.checkWorkingTree', [`${ROOT}/a.ts`])
  })

  it('revalidates without clearing: a visible row keeps its old hint', async () => {
    const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/a.ts`)])
    const { service, decorations } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    expect(service.getHint(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })

    // Decorations change → revalidate (mark stale), not invalidate.
    decorations.set(emptySnapshot(), undefined)
    // The row keeps its old hint synchronously instead of flickering.
    expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })
  })

  it('does not bump the version when the revalidated answer is unchanged', async () => {
    const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/a.ts`)])
    const { service, decorations } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    service.getHint(a)
    await vi.advanceTimersByTimeAsync(200)
    expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })
    const versionBefore = service.version.get()

    decorations.set(emptySnapshot(), undefined)
    service.getHint(a) // re-enqueues
    await vi.advanceTimersByTimeAsync(200)

    expect(service.version.get()).toBe(versionBefore)
    expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })
  })

  it('bumps the version and swaps the value when the revalidated answer changes', async () => {
    const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/a.ts`)])
    const { service, decorations, executeCommand: exec } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    service.getHint(a)
    await vi.advanceTimersByTimeAsync(200)
    expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })
    const versionBefore = service.version.get()

    executeCommand.mockResolvedValue([dto(`${ROOT}/a.ts`, { color: '#73c991', letter: 'A' })])

    decorations.set(emptySnapshot(), undefined)
    service.getHint(a) // re-enqueues
    await vi.advanceTimersByTimeAsync(200)

    expect(exec).toHaveBeenCalledTimes(2)
    expect(service.version.get()).toBe(versionBefore + 1)
    expect(service.getHint(a)).toEqual({ color: '#73c991', letter: 'A' })
  })

  it('revalidates lazily: only read paths are re-queried after a decorations change', async () => {
    const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/a.ts`), dto(`${ROOT}/b.ts`)])
    const { service, decorations, executeCommand: exec } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    const b = URI.file(`${ROOT}/b.ts`)
    service.getHint(a)
    service.getHint(b)
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)

    // The decorations change marks the whole cache stale.
    decorations.set(emptySnapshot(), undefined)

    // Only A is read, so only A re-enqueues.
    service.getHint(a)
    await vi.advanceTimersByTimeAsync(200)

    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec).toHaveBeenLastCalledWith('perforce.checkWorkingTree', [`${ROOT}/a.ts`])
  })

  it('evicts the least-recently-used entry past the cache limit', async () => {
    const paths = Array.from({ length: CACHE_LIMIT + 1 }, (_, i) => `${ROOT}/f${i}.ts`)
    const executeCommand = vi.fn().mockResolvedValue(paths.map((p) => dto(p)))
    const { service, executeCommand: exec } = makeService(executeCommand)

    for (const p of paths) service.getHint(URI.file(p))
    await vi.advanceTimersByTimeAsync(200)

    // The oldest entry was evicted; the newest survived.
    expect(service.getHint(URI.file(paths[0]!))).toBeUndefined()
    expect(service.getHint(URI.file(paths[CACHE_LIMIT]!))).toEqual({
      color: '#e2c08d',
      letter: 'M',
    })

    // Reading the evicted entry again re-enqueues it.
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec).toHaveBeenLastCalledWith('perforce.checkWorkingTree', [paths[0]])
  })

  it('returns undefined and never queries for an off-host resource', async () => {
    const executeCommand = vi.fn().mockResolvedValue([])
    const { service, executeCommand: exec } = makeService(executeCommand)

    expect(service.getHint(URI.parse('markdown-preview://x/a.md'))).toBeUndefined()
    expect(service.getHint(URI.parse('untitled:Untitled-1'))).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).not.toHaveBeenCalled()
  })

  describe('remote workspace', () => {
    function makeRemote(executeCommand: ReturnType<typeof vi.fn>): Harness {
      return makeService(
        executeCommand,
        scmOf([scmSourceControl('perforce', REMOTE_ROOT)]),
        remote(REMOTE_ROOT),
      )
    }

    it('does not query a client-local file or another host resource', async () => {
      const executeCommand = vi.fn().mockResolvedValue([])
      const { service, executeCommand: exec } = makeRemote(executeCommand)

      expect(service.getHint(URI.file(`${ROOT}/a.ts`))).toBeUndefined()
      expect(service.getHint(remote(`${REMOTE_ROOT}/a.ts`, 'otherhost'))).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)
      expect(exec).not.toHaveBeenCalled()
    })
  })
})
