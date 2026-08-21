import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import {
  RelativePattern,
  type FileSystemWatcher,
  type GlobPattern,
} from '@universe-editor/extension-api'
import { RepositoryWatcher, type CreateFileSystemWatcher } from '../repositoryWatcher.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, watch: vi.fn() }
})

const watchMock = vi.mocked(watch)

type WatchListener = (event: string, filename: string | Buffer | null) => void

interface FsWatcherController {
  readonly close: ReturnType<typeof vi.fn>
  readonly listener: WatchListener | undefined
  emitError(err: unknown): void
}

function installFsWatcher(): FsWatcherController {
  let listener: WatchListener | undefined
  const errorHandlers: ((err: unknown) => void)[] = []
  const close = vi.fn()
  watchMock.mockImplementation(((target: unknown, l?: unknown) => {
    listener = l as WatchListener
    return {
      on(event: string, handler: (err: unknown) => void) {
        if (event === 'error') errorHandlers.push(handler)
      },
      close,
    } as unknown as FSWatcher
  }) as typeof watch)
  return {
    close,
    get listener() {
      return listener
    },
    emitError(err: unknown) {
      for (const h of errorHandlers) h(err)
    },
  }
}

/** A FileSystemWatcher fake whose three events can be fired by the test. */
function makeWorkingTreeWatcher() {
  const listeners = {
    create: new Set<() => void>(),
    change: new Set<() => void>(),
    delete: new Set<() => void>(),
  }
  return {
    onDidCreate(fn: () => void) {
      listeners.create.add(fn)
      return { dispose: () => listeners.create.delete(fn) }
    },
    onDidChange(fn: () => void) {
      listeners.change.add(fn)
      return { dispose: () => listeners.change.delete(fn) }
    },
    onDidDelete(fn: () => void) {
      listeners.delete.add(fn)
      return { dispose: () => listeners.delete.delete(fn) }
    },
    dispose: vi.fn(),
    fire(kind: keyof typeof listeners) {
      for (const fn of [...listeners[kind]]) fn()
    },
  }
}

function workingTreeFactory(
  wt: ReturnType<typeof makeWorkingTreeWatcher>,
): CreateFileSystemWatcher {
  return () => wt as unknown as FileSystemWatcher
}

beforeEach(() => {
  vi.useFakeTimers()
  watchMock.mockReset()
  installFsWatcher()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('RepositoryWatcher', () => {
  it('watches the working tree via a RelativePattern over the root', () => {
    const wt = makeWorkingTreeWatcher()
    let captured: GlobPattern | undefined
    const factory = vi.fn((glob: GlobPattern) => {
      captured = glob
      return wt as unknown as FileSystemWatcher
    })
    const watcher = new RepositoryWatcher('/repo', () => {}, factory)
    watcher.start()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(captured).toBeInstanceOf(RelativePattern)
    expect((captured as RelativePattern).base).toBe('/repo')
    expect((captured as RelativePattern).pattern).toBe('**/*')
    watcher.dispose()
  })

  it('forwards working-tree create/change/delete to onChange', () => {
    const wt = makeWorkingTreeWatcher()
    const onChange = vi.fn()
    const watcher = new RepositoryWatcher('/repo', onChange, workingTreeFactory(wt))
    watcher.start()
    wt.fire('create')
    wt.fire('change')
    wt.fire('delete')
    expect(onChange).toHaveBeenCalledTimes(3)
    watcher.dispose()
  })

  it('fires on .git index/HEAD changes and ignores the rest', () => {
    const controller = installFsWatcher()
    const wt = makeWorkingTreeWatcher()
    const onChange = vi.fn()
    const watcher = new RepositoryWatcher('/repo', onChange, workingTreeFactory(wt))
    watcher.start()
    expect(watchMock).toHaveBeenCalledWith(join('/repo', '.git'), expect.any(Function))
    controller.listener?.('change', 'index')
    controller.listener?.('change', 'HEAD')
    controller.listener?.('change', 'objects')
    controller.listener?.('change', 'logs')
    controller.listener?.('change', 'index.lock')
    expect(onChange).toHaveBeenCalledTimes(2)
    watcher.dispose()
  })

  it('degrades without throwing when the .git watch throws synchronously (ENOSPC)', () => {
    watchMock.mockImplementation((() => {
      throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), {
        code: 'ENOSPC',
      })
    }) as typeof watch)
    const wt = makeWorkingTreeWatcher()
    const onChange = vi.fn()
    const log = vi.fn()
    const watcher = new RepositoryWatcher('/repo', onChange, workingTreeFactory(wt), log)
    expect(() => watcher.start()).not.toThrow()
    expect(log).toHaveBeenCalled()
    // The injected working-tree watcher still drives changes.
    wt.fire('change')
    expect(onChange).toHaveBeenCalledTimes(1)
    watcher.dispose()
  })

  it("logs and closes on the .git watcher's 'error' event without crashing", () => {
    const controller = installFsWatcher()
    const wt = makeWorkingTreeWatcher()
    const log = vi.fn()
    const watcher = new RepositoryWatcher('/repo', () => {}, workingTreeFactory(wt), log)
    watcher.start()
    expect(() =>
      controller.emitError(
        Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), {
          code: 'ENOSPC',
        }),
      ),
    ).not.toThrow()
    expect(controller.close).toHaveBeenCalled()
    expect(log).toHaveBeenCalled()
    watcher.dispose()
  })

  it('does not fire after dispose', () => {
    const wt = makeWorkingTreeWatcher()
    const onChange = vi.fn()
    const watcher = new RepositoryWatcher('/repo', onChange, workingTreeFactory(wt))
    watcher.start()
    watcher.dispose()
    wt.fire('change')
    expect(onChange).not.toHaveBeenCalled()
  })
})
