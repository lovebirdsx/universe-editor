import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import {
  PossibleRepoWatcher,
  joinCandidate,
  POSSIBLE_REPO_DEBOUNCE_MS,
  repoCandidateFromPath,
} from '../possibleRepoWatcher.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, watch: vi.fn() }
})

const watchMock = vi.mocked(watch)

type WatchListener = (event: string, filename: string | Buffer | null) => void

interface WatcherController {
  readonly close: ReturnType<typeof vi.fn>
  readonly listener: WatchListener | undefined
  emitError(err: unknown): void
}

/** Install a fake non-recursive watch and expose its listener / error handler. */
function installWatcher(): WatcherController {
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

beforeEach(() => {
  vi.useFakeTimers()
  watchMock.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('repoCandidateFromPath', () => {
  it('maps a root-level .git entry to the root dir', () => {
    expect(repoCandidateFromPath('.git')).toBe('')
  })

  it('ignores anything else (the non-recursive watch only reports root entries)', () => {
    expect(repoCandidateFromPath('src/index.ts')).toBeUndefined()
    expect(repoCandidateFromPath('.gitignore')).toBeUndefined()
    expect(repoCandidateFromPath('.git\\HEAD')).toBeUndefined() // nested, win32 separators
    expect(repoCandidateFromPath('sub/.git')).toBeUndefined()
    expect(repoCandidateFromPath('foo.git/config')).toBeUndefined()
  })
})

describe('joinCandidate', () => {
  it('joins the workspace root with the relative candidate', () => {
    const root = join('/tmp', 'ws')
    expect(joinCandidate(root, '')).toBe(root)
    expect(joinCandidate(root, 'sub/dir')).toBe(join(root, 'sub', 'dir'))
  })
})

describe('PossibleRepoWatcher', () => {
  it('reports a root .git entry after start (debounced, once)', () => {
    const controller = installWatcher()
    const batches: string[][] = []
    const watcher = new PossibleRepoWatcher('/root', (dirs) => batches.push([...dirs]))
    watcher.start()
    controller.listener?.('rename', '.git')
    controller.listener?.('rename', '.git')
    vi.advanceTimersByTime(POSSIBLE_REPO_DEBOUNCE_MS)
    watcher.dispose()
    expect(batches).toEqual([['']])
  })

  it('ignores non-.git root entries', () => {
    const controller = installWatcher()
    const batches: string[][] = []
    const watcher = new PossibleRepoWatcher('/root', (dirs) => batches.push([...dirs]))
    watcher.start()
    controller.listener?.('rename', 'plain.txt')
    vi.advanceTimersByTime(POSSIBLE_REPO_DEBOUNCE_MS)
    watcher.dispose()
    expect(batches).toHaveLength(0)
  })

  it('degrades without throwing when watch throws synchronously (ENOSPC)', () => {
    watchMock.mockImplementation((() => {
      throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), {
        code: 'ENOSPC',
      })
    }) as typeof watch)
    const log = vi.fn()
    const watcher = new PossibleRepoWatcher('/root', () => {}, log)
    expect(() => watcher.start()).not.toThrow()
    expect(log).toHaveBeenCalled()
    watcher.dispose()
  })

  it("logs and closes on the watcher's 'error' event without crashing", () => {
    const controller = installWatcher()
    const log = vi.fn()
    const watcher = new PossibleRepoWatcher('/root', () => {}, log)
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
    const controller = installWatcher()
    const batches: string[][] = []
    const watcher = new PossibleRepoWatcher('/root', (dirs) => batches.push([...dirs]))
    watcher.start()
    watcher.dispose()
    controller.listener?.('rename', '.git')
    vi.advanceTimersByTime(POSSIBLE_REPO_DEBOUNCE_MS)
    expect(batches).toHaveLength(0)
  })
})
