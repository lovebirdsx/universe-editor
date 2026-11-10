import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import {
  RelativePattern,
  type FileSystemWatcher,
  type GlobPattern,
} from '@universe-editor/extension-api'
import {
  RepositoryWatcher,
  isRefreshTriggeringGitEntry,
  upstreamRefPath,
  type CreateFileSystemWatcher,
} from '../repositoryWatcher.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, watch: vi.fn() }
})

const watchMock = vi.mocked(watch)

type WatchListener = (event: string, filename: string | Buffer | null) => void

interface FsWatcherHandle {
  readonly target: string
  readonly close: ReturnType<typeof vi.fn>
  readonly listener: WatchListener | undefined
  emitError(err: unknown): void
}

let fsWatchers: Map<string, FsWatcherHandle>

/** Record every `fs.watch` target so tests can fire/error/close each one. */
function installFsWatchers(): Map<string, FsWatcherHandle> {
  const handles = new Map<string, FsWatcherHandle>()
  watchMock.mockImplementation(((target: string, listener?: WatchListener) => {
    const errorHandlers: ((err: unknown) => void)[] = []
    const close = vi.fn()
    handles.set(target, {
      target,
      close,
      get listener() {
        return listener
      },
      emitError(err: unknown) {
        for (const handler of errorHandlers) handler(err)
      },
    })
    return {
      on(event: string, handler: (err: unknown) => void) {
        if (event === 'error') errorHandlers.push(handler)
      },
      close,
    } as unknown as FSWatcher
  }) as typeof watch)
  return handles
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

function makeWatcher(
  root: string,
  onChange: () => void,
  factory: CreateFileSystemWatcher,
  log?: (msg: string) => void,
): RepositoryWatcher {
  return new RepositoryWatcher({
    root,
    onChange,
    createFileSystemWatcher: factory,
    ...(log !== undefined ? { log } : {}),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  watchMock.mockReset()
  fsWatchers = installFsWatchers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('isRefreshTriggeringGitEntry', () => {
  it('triggers for every first-level git entry except lock/watchman noise', () => {
    for (const name of [
      'index',
      'HEAD',
      'COMMIT_EDITMSG',
      'FETCH_HEAD',
      'MERGE_HEAD',
      'config',
      'packed-refs',
      'ORIG_HEAD',
      'refs',
      'objects',
    ]) {
      expect(isRefreshTriggeringGitEntry(name), name).toBe(true)
    }
    expect(isRefreshTriggeringGitEntry(Buffer.from('MERGE_HEAD'))).toBe(true)
  })

  it('ignores index.lock, watchman cookies, empty names and null', () => {
    expect(isRefreshTriggeringGitEntry('index.lock')).toBe(false)
    expect(isRefreshTriggeringGitEntry('.watchman-cookie-12345')).toBe(false)
    expect(isRefreshTriggeringGitEntry('')).toBe(false)
    expect(isRefreshTriggeringGitEntry(null)).toBe(false)
  })
})

describe('upstreamRefPath', () => {
  const common = join('/repo', '.git')

  it('maps remote-tracking and local upstreams', () => {
    expect(upstreamRefPath(common, 'origin/main')).toBe(
      join(common, 'refs', 'remotes', 'origin', 'main'),
    )
    expect(upstreamRefPath(common, 'origin/feature/x')).toBe(
      join(common, 'refs', 'remotes', 'origin', 'feature', 'x'),
    )
    expect(upstreamRefPath(common, 'main')).toBe(join(common, 'refs', 'heads', 'main'))
  })

  it('returns undefined for empty or malformed upstreams', () => {
    expect(upstreamRefPath(common, undefined)).toBeUndefined()
    expect(upstreamRefPath(common, '   ')).toBeUndefined()
    expect(upstreamRefPath(common, '/main')).toBeUndefined()
    expect(upstreamRefPath(common, 'origin/')).toBeUndefined()
  })
})

describe('RepositoryWatcher', () => {
  it('watches the working tree via a RelativePattern over the root', () => {
    const wt = makeWorkingTreeWatcher()
    let captured: GlobPattern | undefined
    const factory = vi.fn((glob: GlobPattern) => {
      captured = glob
      return wt as unknown as FileSystemWatcher
    })
    const watcher = makeWatcher('/repo', () => {}, factory)
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
    const watcher = makeWatcher('/repo', onChange, workingTreeFactory(wt))
    watcher.start()
    wt.fire('create')
    wt.fire('change')
    wt.fire('delete')
    expect(onChange).toHaveBeenCalledTimes(3)
    watcher.dispose()
  })

  it('fires on any first-level git entry except index.lock / watchman cookies', () => {
    const wt = makeWorkingTreeWatcher()
    const onChange = vi.fn()
    const watcher = makeWatcher('/repo', onChange, workingTreeFactory(wt))
    watcher.start()
    const gitDir = fsWatchers.get(join('/repo', '.git'))
    expect(gitDir).toBeDefined()
    gitDir?.listener?.('change', 'index')
    gitDir?.listener?.('change', 'HEAD')
    gitDir?.listener?.('change', 'COMMIT_EDITMSG')
    gitDir?.listener?.('change', 'FETCH_HEAD')
    gitDir?.listener?.('change', 'index.lock')
    gitDir?.listener?.('change', '.watchman-cookie-abc')
    gitDir?.listener?.('change', null)
    expect(onChange).toHaveBeenCalledTimes(4)
    watcher.dispose()
  })

  it('retargets the git-dir watch to the real worktree git dir', () => {
    const wt = makeWorkingTreeWatcher()
    const onChange = vi.fn()
    const watcher = makeWatcher('/repo', onChange, workingTreeFactory(wt))
    watcher.start()
    const fallback = fsWatchers.get(join('/repo', '.git'))

    const worktreeGitDir = join('/repo', '.git', 'worktrees', 'task2')
    watcher.setGitDirs({ gitDir: worktreeGitDir, commonDir: join('/repo', '.git') })

    expect(fallback?.close).toHaveBeenCalled()
    const retargeted = fsWatchers.get(worktreeGitDir)
    expect(retargeted).toBeDefined()
    retargeted?.listener?.('change', 'index')
    expect(onChange).toHaveBeenCalledTimes(1)
    watcher.dispose()
  })

  it('does not rebuild the git-dir watcher when the resolved path is unchanged', () => {
    const wt = makeWorkingTreeWatcher()
    const watcher = makeWatcher('/repo', () => {}, workingTreeFactory(wt))
    watcher.start()
    const fallback = fsWatchers.get(join('/repo', '.git'))

    watcher.setGitDirs({ gitDir: join('/repo', '.git'), commonDir: join('/repo', '.git') })

    expect(fallback?.close).not.toHaveBeenCalled()
    watcher.dispose()
  })

  it('degrades without throwing when the git-dir watch throws synchronously (ENOSPC)', () => {
    watchMock.mockImplementation((() => {
      throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), {
        code: 'ENOSPC',
      })
    }) as typeof watch)
    const wt = makeWorkingTreeWatcher()
    const onChange = vi.fn()
    const log = vi.fn()
    const watcher = makeWatcher('/repo', onChange, workingTreeFactory(wt), log)
    expect(() => watcher.start()).not.toThrow()
    expect(log).toHaveBeenCalled()
    // The injected working-tree watcher still drives changes.
    wt.fire('change')
    expect(onChange).toHaveBeenCalledTimes(1)
    watcher.dispose()
  })

  it("logs and closes on a git-dir watcher's 'error' event without crashing", () => {
    const wt = makeWorkingTreeWatcher()
    const log = vi.fn()
    const watcher = makeWatcher('/repo', () => {}, workingTreeFactory(wt), log)
    watcher.start()
    const controller = fsWatchers.get(join('/repo', '.git'))
    expect(() =>
      controller?.emitError(
        Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), {
          code: 'ENOSPC',
        }),
      ),
    ).not.toThrow()
    expect(controller?.close).toHaveBeenCalled()
    expect(log).toHaveBeenCalled()
    watcher.dispose()
  })

  it('does not fire after dispose', () => {
    const wt = makeWorkingTreeWatcher()
    const onChange = vi.fn()
    const watcher = makeWatcher('/repo', onChange, workingTreeFactory(wt))
    watcher.start()
    watcher.dispose()
    wt.fire('change')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('creates no watchers when setGitDirs/setUpstream arrive after dispose', () => {
    const wt = makeWorkingTreeWatcher()
    const watcher = makeWatcher('/repo', () => {}, workingTreeFactory(wt))
    watcher.start()
    watcher.dispose()
    const callsAfterDispose = watchMock.mock.calls.length
    watcher.setGitDirs({ gitDir: '/other/.git', commonDir: '/other/.git' })
    watcher.setUpstream('origin/main')
    expect(watchMock).toHaveBeenCalledTimes(callsAfterDispose)
  })

  it('watches and rebuilds the upstream ref as it changes', () => {
    const wt = makeWorkingTreeWatcher()
    const onChange = vi.fn()
    const watcher = makeWatcher('/repo', onChange, workingTreeFactory(wt))
    watcher.start()
    const commonDir = join('/repo', '.git')
    watcher.setGitDirs({ gitDir: commonDir, commonDir })

    watcher.setUpstream('origin/main')
    const first = fsWatchers.get(join(commonDir, 'refs', 'remotes', 'origin', 'main'))
    expect(first).toBeDefined()
    first?.listener?.('change', 'main')
    expect(onChange).toHaveBeenCalledTimes(1)

    watcher.setUpstream('origin/dev')
    expect(first?.close).toHaveBeenCalled()
    expect(fsWatchers.get(join(commonDir, 'refs', 'remotes', 'origin', 'dev'))).toBeDefined()

    watcher.setUpstream(undefined)
    expect(
      fsWatchers.get(join(commonDir, 'refs', 'remotes', 'origin', 'dev'))?.close,
    ).toHaveBeenCalled()
    watcher.dispose()
  })

  it('arms the upstream watcher when setGitDirs arrives after setUpstream', () => {
    const wt = makeWorkingTreeWatcher()
    const watcher = makeWatcher('/repo', () => {}, workingTreeFactory(wt))
    watcher.start()
    watcher.setUpstream('origin/main')
    expect(
      fsWatchers.get(join('/repo', '.git', 'refs', 'remotes', 'origin', 'main')),
    ).toBeUndefined()

    const commonDir = join('/repo', '.git')
    watcher.setGitDirs({ gitDir: commonDir, commonDir })
    expect(fsWatchers.get(join(commonDir, 'refs', 'remotes', 'origin', 'main'))).toBeDefined()
    watcher.dispose()
  })

  it('degrades when the upstream ref has no loose file (packed) and logs once', () => {
    const wt = makeWorkingTreeWatcher()
    const log = vi.fn()
    watchMock.mockImplementation(((target: string) => {
      if (target.includes(join('refs', 'remotes'))) throw new Error('ENOENT')
      return { on() {}, close: vi.fn() } as unknown as FSWatcher
    }) as typeof watch)
    const watcher = makeWatcher('/repo', () => {}, workingTreeFactory(wt), log)
    watcher.start()
    const commonDir = join('/repo', '.git')
    watcher.setGitDirs({ gitDir: commonDir, commonDir })
    expect(() => watcher.setUpstream('origin/main')).not.toThrow()
    expect(() => watcher.setUpstream('origin/main')).not.toThrow()
    expect(log.mock.calls.filter(([msg]) => String(msg).includes('likely packed'))).toHaveLength(1)
    watcher.dispose()
  })
})
