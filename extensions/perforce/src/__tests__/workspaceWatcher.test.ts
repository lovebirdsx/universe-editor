import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileSystemWatcher } from '@universe-editor/extension-api'
import type { PerforceClient } from '../client.js'
import { ClientManager } from '../clientManager.js'
import { WorkspaceWatchController, isNoise, type WatcherFactory } from '../workspaceWatcher.js'

// The controller only touches the real extension-api through its default watcher
// factory, which every test replaces — the module mock just keeps the import
// binding off the real bridge.
vi.mock('@universe-editor/extension-api', () => ({
  RelativePattern: class {},
  workspace: { createFileSystemWatcher: vi.fn() },
}))

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const FILE_A = join(ROOT, 'a.txt')
const FILE_B = join(ROOT, 'src', 'b.txt')

type FsPathListener = (uri: { fsPath: string }) => void

/** A `FileSystemWatcher` fake whose events can be fired manually. */
function createFakeWatcher() {
  const listeners: { create?: FsPathListener; change?: FsPathListener; delete?: FsPathListener } =
    {}
  let disposed = false
  const watcher = {
    ignoreCreateEvents: false,
    ignoreChangeEvents: false,
    ignoreDeleteEvents: false,
    onDidCreate: (l: FsPathListener) => {
      listeners.create = l
      return { dispose: () => undefined }
    },
    onDidChange: (l: FsPathListener) => {
      listeners.change = l
      return { dispose: () => undefined }
    },
    onDidDelete: (l: FsPathListener) => {
      listeners.delete = l
      return { dispose: () => undefined }
    },
    dispose: () => {
      disposed = true
    },
  } as unknown as FileSystemWatcher
  return {
    watcher,
    emitCreate: (fsPath: string) => listeners.create?.({ fsPath }),
    emitChange: (fsPath: string) => listeners.change?.({ fsPath }),
    emitDelete: (fsPath: string) => listeners.delete?.({ fsPath }),
    isDisposed: () => disposed,
  }
}

function fakeClient(overrides: Record<string, unknown> = {}): PerforceClient {
  return {
    root: ROOT,
    refreshReconcilePaths: vi.fn(async () => undefined),
    dispose: () => undefined,
    ...overrides,
  } as unknown as PerforceClient
}

function makeController(factory: WatcherFactory, log?: (msg: string) => void) {
  const mgr = new ClientManager()
  const client = fakeClient()
  mgr.add(client)
  return {
    mgr,
    client,
    controller: new WorkspaceWatchController(mgr, log, factory),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('isNoise', () => {
  it.each([
    [join(ROOT, '.git', 'config'), true],
    [join(ROOT, 'node_modules', 'x', 'index.js'), true],
    [join(ROOT, '.hg', 'store'), true],
    [join(ROOT, '.svn', 'entries'), true],
    [join(ROOT, 'src', 'main.cpp'), false],
    [join(ROOT, 'a.txt'), false],
  ])('classifies %s as noise=%s', (path, expected) => {
    expect(isNoise(path)).toBe(expected)
  })

  it('flags temp/lock artifacts regardless of directory', () => {
    expect(isNoise(join(ROOT, 'src', 'a.txt~'))).toBe(true)
    expect(isNoise(join(ROOT, 'src', '.a.txt.swp'))).toBe(true)
    expect(isNoise(join(ROOT, '.~lock.a.txt#'))).toBe(true)
    expect(isNoise(join(ROOT, '4913'))).toBe(true)
  })
})

describe('WorkspaceWatchController', () => {
  it('arms the watcher on the opened folder', () => {
    const { watcher, ...fake } = createFakeWatcher()
    const { controller } = makeController(() => watcher)

    controller.start(true, ROOT)

    expect(fake.isDisposed()).toBe(false)
  })

  it('collects create/change/delete events into one debounced incremental reconcile', () => {
    vi.useFakeTimers()
    const fake = createFakeWatcher()
    const { client, controller } = makeController(() => fake.watcher)

    controller.start(true, ROOT)
    fake.emitCreate(FILE_A)
    fake.emitChange(FILE_B)
    fake.emitDelete(FILE_A)

    expect(client.refreshReconcilePaths).not.toHaveBeenCalled()
    vi.advanceTimersByTime(399)
    expect(client.refreshReconcilePaths).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(client.refreshReconcilePaths).toHaveBeenCalledTimes(1)
    expect(client.refreshReconcilePaths).toHaveBeenCalledWith(
      expect.arrayContaining([FILE_A, FILE_B]),
    )
    expect(vi.mocked(client.refreshReconcilePaths).mock.calls[0]![0]).toHaveLength(2)
  })

  it('skips noise paths so they never schedule a reconcile', () => {
    vi.useFakeTimers()
    const fake = createFakeWatcher()
    const { client, controller } = makeController(() => fake.watcher)

    controller.start(true, ROOT)
    fake.emitChange(join(ROOT, '.git', 'config'))
    fake.emitChange(join(ROOT, 'src', 'a.txt~'))
    vi.advanceTimersByTime(400)

    expect(client.refreshReconcilePaths).not.toHaveBeenCalled()
  })

  it('does nothing (and creates no watcher) when disabled or folderless', () => {
    const factory = vi.fn(() => createFakeWatcher().watcher)
    const { controller } = makeController(factory)

    controller.start(false, ROOT)
    controller.start(true, undefined)

    expect(factory).not.toHaveBeenCalled()
  })

  it('degrades without throwing when watcher creation fails', () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const { controller } = makeController(() => {
      throw new Error('ENOSPC: System limit for number of file watchers reached')
    }, log)

    expect(() => controller.start(true, ROOT)).not.toThrow()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('auto-refresh off'))

    // Nothing to fire and nothing scheduled — dispose stays safe.
    expect(() => controller.dispose()).not.toThrow()
  })

  it('disposes the armed watcher and clears the pending timer', () => {
    vi.useFakeTimers()
    const fake = createFakeWatcher()
    const { client, controller } = makeController(() => fake.watcher)

    controller.start(true, ROOT)
    fake.emitChange(FILE_A)
    controller.dispose()
    vi.advanceTimersByTime(400)

    expect(fake.isDisposed()).toBe(true)
    expect(client.refreshReconcilePaths).not.toHaveBeenCalled()
  })

  it('ignores events while paused, and drops what was already pending', () => {
    vi.useFakeTimers()
    const fake = createFakeWatcher()
    const { client, controller } = makeController(() => fake.watcher)

    controller.start(true, ROOT)
    // Already accumulating when the sync starts: these are pre-sync edits, but a
    // sync's own writes would be indistinguishable, so the batch is dropped and
    // the caller's post-sync refresh is what re-establishes truth.
    fake.emitChange(FILE_A)
    controller.pause()
    // Ten thousand files written by `p4 sync` land here — none may become a
    // reconcile path, or the user sees "it finished, then froze".
    fake.emitChange(FILE_B)
    fake.emitCreate(join(ROOT, 'c.txt'))
    vi.advanceTimersByTime(400)

    expect(client.refreshReconcilePaths).not.toHaveBeenCalled()
  })

  it('reacts again after resume', () => {
    vi.useFakeTimers()
    const fake = createFakeWatcher()
    const { client, controller } = makeController(() => fake.watcher)

    controller.start(true, ROOT)
    controller.pause()
    fake.emitChange(FILE_A)
    controller.resume()
    fake.emitChange(FILE_B)
    vi.advanceTimersByTime(400)

    // Only the post-resume path — the paused one was never recorded.
    expect(client.refreshReconcilePaths).toHaveBeenCalledTimes(1)
    expect(client.refreshReconcilePaths).toHaveBeenCalledWith([FILE_B])
  })
})
