/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for ScmWorkingTreeHintService — pull-style on-disk-change cache with
 *  batch check-working-tree resolution, negative caching, per-provider bucketing,
 *  invalidation, stale-while-revalidate and LRU eviction.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  observableValue,
  REMOTE_SCHEME,
  URI,
  type IDisposable,
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
import { scmViewState } from '../../../workbench/scm/scmViewState.js'
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
  return {
    sourceControls: observableValue('sc', controls),
  } as unknown as IScmService
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

/**
 * Declares rows as visible — the viewport-driven enqueue entry point. A read no
 * longer enqueues, so every "the first look queries it" setup goes through here.
 */
function show(service: ScmWorkingTreeHintService, ...resources: URI[]): void {
  service.markVisible(resources)
}

describe('ScmWorkingTreeHintService', () => {
  let commandDisposables: IDisposable[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    // scmViewState is a module-level singleton; reset it so a selectedRepo left
    // by a previous test can't leak into this one's arbitration.
    scmViewState.setSelectedRepo(undefined)
    // The perforce extension registers `checkWorkingTree` at runtime; git never
    // does. Register a no-op so capability-aware routing treats perforce as able
    // to answer (the mock `executeCommand` intercepts the actual call).
    commandDisposables.push(
      CommandsRegistry.registerCommand('perforce.checkWorkingTree', () => undefined),
    )
  })

  afterEach(() => {
    scmViewState.setSelectedRepo(undefined)
    for (const d of commandDisposables) d.dispose()
    commandDisposables = []
    vi.useRealTimers()
  })

  it('returns undefined for an unknown path, then the hint once the batch resolves', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValue([dto(`${ROOT}/a.txt`, { color: '#111111', letter: 'A' })])
    const { service, executeCommand: exec } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.txt`)
    show(service, a)
    expect(service.getHint(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)

    expect(exec).toHaveBeenCalledTimes(1)
    expect(service.getHint(a)).toEqual({ color: '#111111', letter: 'A' })
  })

  it('never queries from a read alone — only markVisible enqueues', async () => {
    const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/a.txt`)])
    const { service, executeCommand: exec } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.txt`)
    // Rendering a row reads its hint; that alone must never spawn a query. A
    // non-windowed tree renders off-screen rows too, so "rendered" is not
    // "visible" — only the viewport declaration is.
    for (let i = 0; i < 3; i++) expect(service.getHint(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).not.toHaveBeenCalled()

    show(service, a)
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })
  })

  it('batches a debounce window and buckets paths by owning provider', async () => {
    const executeCommand = vi.fn().mockResolvedValue([])
    const scm = scmOf([
      scmSourceControl('git', `${ROOT}/git`),
      scmSourceControl('perforce', `${ROOT}/p4`),
    ])
    // Bucketing needs two *capable* owners; in the real app only perforce
    // registers the capability, so git is made capable just for this mechanic.
    const gitCommand = CommandsRegistry.registerCommand('git.checkWorkingTree', () => undefined)
    const { service, executeCommand: exec } = makeService(executeCommand, scm)
    try {
      service.markVisible([
        URI.file(`${ROOT}/git/a.ts`),
        URI.file(`${ROOT}/git/b.ts`),
        URI.file(`${ROOT}/p4/c.ts`),
      ])
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
    } finally {
      gitCommand.dispose()
    }
  })

  it('caches a path missing from the result as clean and never re-queries it', async () => {
    const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/a.txt`)])
    const { service, executeCommand: exec } = makeService(executeCommand)

    const missing = URI.file(`${ROOT}/missing.txt`)
    const present = URI.file(`${ROOT}/a.txt`)
    show(service, missing, present)
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
    show(service, a)
    expect(service.getHint(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)

    expect(exec).toHaveBeenCalledTimes(1)
    expect(service.getHint(a)).toBeUndefined()

    show(service, a)
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('treats a failing check-working-tree as clean and logs a warning', async () => {
    const executeCommand = vi.fn().mockRejectedValue(new Error('boom'))
    const { service, executeCommand: exec, logger } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    show(service, a)
    expect(service.getHint(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)

    expect(service.getHint(a)).toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()

    show(service, a)
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
    show(service, a)
    expect(service.getHint(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)

    // A workspace change invalidates while the command is still in flight.
    workspaceEvents.fire(null)

    // The stale answer resolves; the flush must drop it.
    resolveCmd!([dto(`${ROOT}/a.ts`)])
    await vi.advanceTimersByTimeAsync(0)

    // Cache stays empty, so a fresh declaration enqueues again instead of
    // handing out a stale hint.
    expect(service.getHint(a)).toBeUndefined()
    expect(exec).toHaveBeenCalledTimes(1)

    executeCommand.mockResolvedValue([])
    show(service, a)
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
    show(service, a)
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
    // notice the gap. (A quiet workspace may see no later provider refresh at
    // all, so self-healing here is the only correction.)
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
    show(service, a)
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
    resolvers[1]!([dto(`${ROOT}/a.ts`, { letter: 'RM' })])
    await vi.advanceTimersByTimeAsync(0)

    // Latest query wins. Accepting #1 would pin the file "clean" for good: the
    // cache holds an entry, so no render re-enqueues it, and `_revalidate` only
    // walks keys already cached at the time it runs.
    expect(service.getHint(a)?.letter).toBe('RM')
  })

  it('does not re-enqueue a key whose query is still in flight', async () => {
    const executeCommand = vi.fn(
      () => new Promise<readonly WorkingTreeChangeDto[] | undefined>(() => {}),
    )
    const { service, executeCommand: exec } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    show(service, a)
    expect(service.getHint(a)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)

    // Still no answer, so the row keeps rendering as unknown. Re-declaring it
    // must not fire a second identical query — the viewport re-declares on every
    // scroll, and each duplicate is another p4 spawn on the shared gate.
    show(service, a)
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
    show(service, a)
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)

    // Stale → the next declaration re-queries while keeping the old hint on screen.
    decorations.set(emptySnapshot(), undefined)
    show(service, a)
    expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(2)

    // A second refresh marks it stale again before the re-query has landed. The
    // cached-and-stale path needs the same in-flight guard as the cache-miss one,
    // or this fires a third query that answers the question already on the wire.
    decorations.set(emptySnapshot(), undefined)
    show(service, a)
    expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(2)

    // Once it lands the key is released, so a still-stale row queries again.
    resolveCmd!([dto(`${ROOT}/a.ts`, { letter: 'RM' })])
    await vi.advanceTimersByTimeAsync(0)
    expect(service.getHint(a)?.letter).toBe('RM')
  })

  it('fully invalidates when the workspace changes', async () => {
    const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/a.ts`)])
    const { service, workspaceEvents } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    show(service, a)
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
    show(service, a)
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
    show(service, a, b)
    expect(service.getHint(a)).toBeUndefined()
    expect(service.getHint(b)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })
    expect(service.getHint(b)).toEqual({ color: '#e2c08d', letter: 'M' })

    fileEvents.fire([{ type: 'modified', resource: a }])
    // Only `a` is dropped; `b` still hits the cache.
    show(service, a)
    expect(service.getHint(a)).toBeUndefined()
    expect(service.getHint(b)).toEqual({ color: '#e2c08d', letter: 'M' })

    // `a` re-queries (the declaration above); `b` is not re-queried.
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec).toHaveBeenLastCalledWith('perforce.checkWorkingTree', [`${ROOT}/a.ts`])
  })

  it('revalidates without clearing: a visible row keeps its old hint', async () => {
    const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/a.ts`)])
    const { service, decorations } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    show(service, a)
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
    show(service, a)
    await vi.advanceTimersByTimeAsync(200)
    expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })
    const versionBefore = service.version.get()

    decorations.set(emptySnapshot(), undefined)
    show(service, a) // re-queries
    await vi.advanceTimersByTimeAsync(200)

    expect(service.version.get()).toBe(versionBefore)
    expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })
  })

  it('bumps the version and swaps the value when the revalidated answer changes', async () => {
    const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/a.ts`)])
    const { service, decorations, executeCommand: exec } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    show(service, a)
    await vi.advanceTimersByTimeAsync(200)
    expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })
    const versionBefore = service.version.get()

    executeCommand.mockResolvedValue([dto(`${ROOT}/a.ts`, { color: '#73c991', letter: 'A' })])

    decorations.set(emptySnapshot(), undefined)
    show(service, a) // re-queries
    await vi.advanceTimersByTimeAsync(200)

    expect(exec).toHaveBeenCalledTimes(2)
    expect(service.version.get()).toBe(versionBefore + 1)
    expect(service.getHint(a)).toEqual({ color: '#73c991', letter: 'A' })
  })

  it('revalidates lazily: only re-declared paths are re-queried after a decorations change', async () => {
    const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/a.ts`), dto(`${ROOT}/b.ts`)])
    const { service, decorations, executeCommand: exec } = makeService(executeCommand)

    const a = URI.file(`${ROOT}/a.ts`)
    const b = URI.file(`${ROOT}/b.ts`)
    show(service, a, b)
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(1)

    // The decorations change marks the whole cache stale.
    decorations.set(emptySnapshot(), undefined)

    // Only A is declared visible again, so only A re-queries.
    show(service, a)
    await vi.advanceTimersByTimeAsync(200)

    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec).toHaveBeenLastCalledWith('perforce.checkWorkingTree', [`${ROOT}/a.ts`])
  })

  it('evicts the least-recently-used entry past the cache limit', async () => {
    const paths = Array.from({ length: CACHE_LIMIT + 1 }, (_, i) => `${ROOT}/f${i}.ts`)
    const executeCommand = vi.fn().mockResolvedValue(paths.map((p) => dto(p)))
    const { service, executeCommand: exec } = makeService(executeCommand)

    service.markVisible(paths.map((p) => URI.file(p)))
    await vi.advanceTimersByTimeAsync(200)

    // The oldest entry was evicted; the newest survived.
    expect(service.getHint(URI.file(paths[0]!))).toBeUndefined()
    expect(service.getHint(URI.file(paths[CACHE_LIMIT]!))).toEqual({
      color: '#e2c08d',
      letter: 'M',
    })

    // Declaring the evicted entry visible again re-enqueues it.
    show(service, URI.file(paths[0]!))
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec).toHaveBeenLastCalledWith('perforce.checkWorkingTree', [paths[0]])
  })

  it('does not re-order the LRU on a plain read', async () => {
    const paths = Array.from(
      { length: CACHE_LIMIT },
      (_, i) => `${ROOT}/f${String(i).padStart(5, '0')}.ts`,
    )
    const executeCommand = vi.fn().mockResolvedValue(paths.map((p) => dto(p)))
    const { service } = makeService(executeCommand)

    service.markVisible(paths.map((p) => URI.file(p)))
    await vi.advanceTimersByTimeAsync(200)

    // Rendering a row reads its hint — and a read must not re-order the cache,
    // or every render would silently protect whatever it happened to show.
    expect(service.getHint(URI.file(paths[0]!))).toEqual({ color: '#e2c08d', letter: 'M' })
    service.markVisible([URI.file(`${ROOT}/new.ts`)])
    await vi.advanceTimersByTimeAsync(200)

    // paths[0] was still the head, so the insert evicted it.
    expect(service.getHint(URI.file(paths[0]!))).toBeUndefined()
    expect(service.getHint(URI.file(paths[1]!))).toEqual({ color: '#e2c08d', letter: 'M' })
  })

  it('moves a declared-visible entry to the LRU tail', async () => {
    const paths = Array.from(
      { length: CACHE_LIMIT },
      (_, i) => `${ROOT}/f${String(i).padStart(5, '0')}.ts`,
    )
    const executeCommand = vi.fn().mockResolvedValue(paths.map((p) => dto(p)))
    const { service } = makeService(executeCommand)

    service.markVisible(paths.map((p) => URI.file(p)))
    await vi.advanceTimersByTimeAsync(200)

    // The row is on screen, so it must not be the next entry evicted.
    show(service, URI.file(paths[0]!))
    service.markVisible([URI.file(`${ROOT}/new.ts`)])
    await vi.advanceTimersByTimeAsync(200)

    expect(service.getHint(URI.file(paths[0]!))).toEqual({ color: '#e2c08d', letter: 'M' })
    expect(service.getHint(URI.file(paths[1]!))).toBeUndefined()
  })

  it('returns undefined and never queries for an off-host resource', async () => {
    const executeCommand = vi.fn().mockResolvedValue([])
    const { service, executeCommand: exec } = makeService(executeCommand)

    service.markVisible([URI.parse('markdown-preview://x/a.md'), URI.parse('untitled:Untitled-1')])
    expect(service.getHint(URI.parse('markdown-preview://x/a.md'))).toBeUndefined()
    expect(service.getHint(URI.parse('untitled:Untitled-1'))).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(exec).not.toHaveBeenCalled()
  })

  describe('perforce / multi-provider arbitration', () => {
    const GIT_ROOT = `${ROOT}/git`

    function nestedControls(): readonly IScmSourceControlModel[] {
      // Perforce registers first; the git repo is nested inside its workspace.
      return [scmSourceControl('perforce', ROOT), scmSourceControl('git', GIT_ROOT)]
    }

    it('arbitrates to the selected outer provider over the longest-prefix owner', async () => {
      const executeCommand = vi.fn().mockResolvedValue([dto(`${GIT_ROOT}/a.txt`)])
      const { service, executeCommand: exec } = makeService(executeCommand, scmOf(nestedControls()))

      // The view is showing the p4 workspace, so a file the nested git repo also
      // owns must be routed to perforce — not to git by longest prefix.
      scmViewState.setSelectedRepo(ROOT)
      show(service, URI.file(`${GIT_ROOT}/a.txt`))
      expect(service.getHint(URI.file(`${GIT_ROOT}/a.txt`))).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)

      expect(exec).toHaveBeenCalledWith('perforce.checkWorkingTree', [`${GIT_ROOT}/a.txt`])
      expect(service.getHint(URI.file(`${GIT_ROOT}/a.txt`))).toEqual({
        color: '#e2c08d',
        letter: 'M',
      })
    })

    it('hides cached hints while another repo is selected and restores them on switch-back', async () => {
      const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/a.ts`)])
      const { service, executeCommand: exec } = makeService(executeCommand, scmOf(nestedControls()))

      scmViewState.setSelectedRepo(ROOT)
      const a = URI.file(`${ROOT}/a.ts`)
      show(service, a)
      expect(service.getHint(a)).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)
      expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })

      // The user switches the SCM view to the nested git repo: the p4 hint must
      // disappear immediately.
      scmViewState.setSelectedRepo(GIT_ROOT)
      expect(service.getHint(a)).toBeUndefined()

      // Switch back: the hint reappears from the retained p4 slot — the pull
      // channel's data survives the switch, so no new query is issued.
      scmViewState.setSelectedRepo(ROOT)
      expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'M' })
      expect(exec).toHaveBeenCalledTimes(1)
    })

    it('re-routes the re-query to the newly selected repo after a switch', async () => {
      const executeCommand = vi.fn().mockImplementation((id: unknown, _paths: unknown) => {
        if (id === 'perforce.checkWorkingTree') {
          return Promise.resolve([dto(`${GIT_ROOT}/x.ts`, { letter: 'P4' })])
        }
        // git contributes no checkWorkingTree command: an unanswered batch is clean.
        return Promise.resolve(undefined)
      })
      const { service, executeCommand: exec } = makeService(executeCommand, scmOf(nestedControls()))

      const x = URI.file(`${GIT_ROOT}/x.ts`)
      scmViewState.setSelectedRepo(ROOT)
      show(service, x)
      expect(service.getHint(x)).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)
      expect(exec).toHaveBeenCalledWith('perforce.checkWorkingTree', [`${GIT_ROOT}/x.ts`])
      expect(service.getHint(x)?.letter).toBe('P4')

      // Switch to git: the cached p4 answer is hidden, and the re-query goes to
      // git — which has no checkWorkingTree — so the badge disappears for good.
      scmViewState.setSelectedRepo(GIT_ROOT)
      show(service, x)
      expect(service.getHint(x)).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)
      expect(exec).toHaveBeenCalledTimes(2)
      expect(exec).toHaveBeenLastCalledWith('git.checkWorkingTree', [`${GIT_ROOT}/x.ts`])
      expect(service.getHint(x)).toBeUndefined()

      // Switch back: the p4 answer is still in its slot and reappears; the git
      // batch's clean answer lives in the git slot and cannot clobber it.
      scmViewState.setSelectedRepo(ROOT)
      expect(service.getHint(x)?.letter).toBe('P4')
      expect(exec).toHaveBeenCalledTimes(2)
    })

    it('surfaces p4 drift for an unselected nested-git file', async () => {
      const executeCommand = vi.fn().mockImplementation((id: unknown, _paths: unknown) => {
        if (id === 'perforce.checkWorkingTree') {
          return Promise.resolve([dto(`${GIT_ROOT}/a.txt`, { letter: 'RM' })])
        }
        // git contributes no checkWorkingTree command: an unanswered batch is clean.
        return Promise.resolve(undefined)
      })
      const { service, executeCommand: exec } = makeService(executeCommand, scmOf(nestedControls()))

      // No repo is selected in the SCM view (scmViewState.selectedRepo stays
      // undefined). The unselected state is meant to merge every provider's hint
      // slot, so the nested git repo's file — still owned by the outer Perforce
      // workspace — must surface its p4 drift as an RM badge.
      const a = URI.file(`${GIT_ROOT}/a.txt`)
      show(service, a)
      expect(service.getHint(a)).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)

      expect(exec).toHaveBeenCalledWith('perforce.checkWorkingTree', [`${GIT_ROOT}/a.txt`])
      expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'RM' })
    })

    it('queries nothing when no owner has the checkWorkingTree capability', async () => {
      const executeCommand = vi.fn().mockResolvedValue([])
      const { service, executeCommand: exec } = makeService(
        executeCommand,
        scmOf([scmSourceControl('git', ROOT)]),
      )
      const a = URI.file(`${ROOT}/a.ts`)
      show(service, a)
      expect(service.getHint(a)).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)
      expect(exec).not.toHaveBeenCalled()

      // Re-declaring stays a miss that never enqueues: the path was not cached
      // as clean, so it neither spawns nor re-queues every frame.
      show(service, a)
      expect(service.getHint(a)).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)
      expect(exec).not.toHaveBeenCalled()
    })

    it('re-queries a path once its owner registers the capability late', async () => {
      const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/a.ts`, { letter: 'RM' })])
      const { service, executeCommand: exec } = makeService(
        executeCommand,
        scmOf([scmSourceControl('late', ROOT)]),
      )
      const a = URI.file(`${ROOT}/a.ts`)

      // The source control is registered but its capability command is not yet:
      // no capable owner, so the path is left alone (zero spawn, nothing cached).
      show(service, a)
      expect(service.getHint(a)).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)
      expect(exec).not.toHaveBeenCalled()

      // The extension registers the command after the source control, with no
      // sourceControls change to invalidate on — the next declaration must
      // re-arbitrate instead of staying stuck as "no owner".
      const command = CommandsRegistry.registerCommand('late.checkWorkingTree', () => undefined)
      try {
        show(service, a)
        expect(service.getHint(a)).toBeUndefined()
        await vi.advanceTimersByTimeAsync(200)
        expect(exec).toHaveBeenCalledWith('late.checkWorkingTree', [`${ROOT}/a.ts`])
        expect(service.getHint(a)).toEqual({ color: '#e2c08d', letter: 'RM' })
      } finally {
        command.dispose()
      }
    })
  })

  describe('folder hints', () => {
    it('propagates a file hint to its ancestor folders, colour only', async () => {
      const executeCommand = vi
        .fn()
        .mockResolvedValue([dto(`${ROOT}/src/deep/a.ts`, { color: '#111111' })])
      const { service, executeCommand: exec } = makeService(executeCommand)

      show(service, URI.file(`${ROOT}/src/deep/a.ts`))
      expect(service.getHint(URI.file(`${ROOT}/src/deep/a.ts`))).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)

      expect(service.getFolderHint(URI.file(`${ROOT}/src/deep`))).toEqual({ color: '#111111' })
      expect(service.getFolderHint(URI.file(`${ROOT}/src`))).toEqual({ color: '#111111' })
      // No provider root is known here, so propagation runs to the path top —
      // harmless, since only rendered rows look a folder up.
      expect(service.getFolderHint(URI.file(ROOT))).toEqual({ color: '#111111' })
      // A directory never shows a badge letter: the aggregate is colour only.
      expect(service.getFolderHint(URI.file(`${ROOT}/src/deep`))).toStrictEqual({
        color: '#111111',
      })
      expect(service.getFolderHint(URI.file(`${ROOT}/other`))).toBeUndefined()
      expect(service.getFolderHint(URI.file(`${ROOT}/src/untouched/deeper`))).toBeUndefined()
      expect(service.getFolderHint(URI.parse('markdown-preview://x/src'))).toBeUndefined()

      // Folders never enqueue their own query — the fold is pure cache derivation.
      expect(exec).toHaveBeenCalledTimes(1)
    })

    it('a delete descendant outranks an edit descendant for the folder colour', async () => {
      const executeCommand = vi
        .fn()
        .mockResolvedValue([
          dto(`${ROOT}/src/edited.ts`),
          dto(`${ROOT}/src/deleted.ts`, { color: '#c74e39', strikeThrough: true }),
        ])
      const { service } = makeService(executeCommand)

      service.markVisible([URI.file(`${ROOT}/src/edited.ts`), URI.file(`${ROOT}/src/deleted.ts`)])
      await vi.advanceTimersByTimeAsync(200)

      expect(service.getFolderHint(URI.file(`${ROOT}/src`))).toEqual({ color: '#c74e39' })
    })

    it('ties keep the first descendant colour', async () => {
      const executeCommand = vi
        .fn()
        .mockResolvedValue([
          dto(`${ROOT}/src/aaa.ts`, { color: '#111111' }),
          dto(`${ROOT}/src/bbb.ts`, { color: '#222222' }),
        ])
      const { service } = makeService(executeCommand)

      service.markVisible([URI.file(`${ROOT}/src/aaa.ts`), URI.file(`${ROOT}/src/bbb.ts`)])
      await vi.advanceTimersByTimeAsync(200)

      expect(service.getFolderHint(URI.file(`${ROOT}/src`))).toEqual({ color: '#111111' })
    })

    it('ties stay stable when LRU re-ordering precedes an unrelated rebuild', async () => {
      const executeCommand = vi
        .fn()
        .mockResolvedValue([
          dto(`${ROOT}/src/aaa.ts`, { color: '#111111' }),
          dto(`${ROOT}/src/bbb.ts`, { color: '#222222' }),
        ])
      const { service, fileEvents } = makeService(executeCommand)

      const aaa = URI.file(`${ROOT}/src/aaa.ts`)
      show(service, aaa, URI.file(`${ROOT}/src/bbb.ts`))
      await vi.advanceTimersByTimeAsync(200)
      expect(service.getFolderHint(URI.file(`${ROOT}/src`))).toEqual({ color: '#111111' })

      // Declaring a cached row visible re-orders the LRU (aaa moves to the tail)
      // without bumping `_version`; the next unrelated bump rebuilds the fold on
      // the new order.
      show(service, aaa)
      fileEvents.fire([{ type: 'modified', resource: URI.file(`${ROOT}/elsewhere.ts`) }])
      await vi.advanceTimersByTimeAsync(200)
      expect(service.getFolderHint(URI.file(`${ROOT}/src`))).toEqual({ color: '#111111' })
    })

    it('a folder of only clean files has no tint', async () => {
      // Both files resolve clean (not in the provider's answer set) → null entries.
      const executeCommand = vi.fn().mockResolvedValue([])
      const { service } = makeService(executeCommand)

      service.markVisible([URI.file(`${ROOT}/src/a.ts`), URI.file(`${ROOT}/src/b.ts`)])
      await vi.advanceTimersByTimeAsync(200)

      expect(service.getHint(URI.file(`${ROOT}/src/a.ts`))).toBeUndefined()
      expect(service.getFolderHint(URI.file(`${ROOT}/src`))).toBeUndefined()
    })

    it('evicting the last hinted descendant clears the folder tint', async () => {
      const hinted = dto(`${ROOT}/00-target/a.ts`, { color: '#111111' })
      const executeCommand = vi.fn().mockImplementation((...args: unknown[]) => {
        const paths = args[1] as string[]
        return Promise.resolve(paths.includes(hinted.path) ? [hinted] : [])
      })
      const { service } = makeService(executeCommand)

      show(service, URI.file(hinted.path))
      await vi.advanceTimersByTimeAsync(200)
      expect(service.getFolderHint(URI.file(`${ROOT}/00-target`))).toEqual({ color: '#111111' })

      // Fill the cache past CACHE_LIMIT; the `00-` keys sort first and evict first.
      service.markVisible(
        Array.from({ length: CACHE_LIMIT }, (_, i) =>
          URI.file(`${ROOT}/filler/f${String(i).padStart(5, '0')}.ts`),
        ),
      )
      await vi.advanceTimersByTimeAsync(200)
      expect(service.getHint(URI.file(hinted.path))).toBeUndefined()

      // The eviction bump already rebuilt the fold: no file event needed.
      expect(service.getFolderHint(URI.file(`${ROOT}/00-target`))).toBeUndefined()
    })

    it('a file event dropping the only hinted descendant clears the folder colour', async () => {
      const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/src/a.ts`)])
      const { service, fileEvents } = makeService(executeCommand)

      const a = URI.file(`${ROOT}/src/a.ts`)
      show(service, a)
      expect(service.getHint(a)).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)
      expect(service.getFolderHint(URI.file(`${ROOT}/src`))).toEqual({ color: '#e2c08d' })

      fileEvents.fire([{ type: 'modified', resource: a }])
      expect(service.getFolderHint(URI.file(`${ROOT}/src`))).toBeUndefined()
    })

    it('clears folder hints on a full invalidation', async () => {
      const executeCommand = vi.fn().mockResolvedValue([dto(`${ROOT}/src/a.ts`)])
      const { service, workspaceEvents } = makeService(executeCommand)

      show(service, URI.file(`${ROOT}/src/a.ts`))
      expect(service.getHint(URI.file(`${ROOT}/src/a.ts`))).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)
      expect(service.getFolderHint(URI.file(`${ROOT}/src`))).toEqual({ color: '#e2c08d' })

      workspaceEvents.fire(null)
      expect(service.getFolderHint(URI.file(`${ROOT}/src`))).toBeUndefined()
    })
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

      service.markVisible([URI.file(`${ROOT}/a.ts`), remote(`${REMOTE_ROOT}/a.ts`, 'otherhost')])
      expect(service.getHint(URI.file(`${ROOT}/a.ts`))).toBeUndefined()
      expect(service.getHint(remote(`${REMOTE_ROOT}/a.ts`, 'otherhost'))).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)
      expect(exec).not.toHaveBeenCalled()
    })
  })
})
