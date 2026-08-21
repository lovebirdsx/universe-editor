/**
 * Watcher-driven auto-refresh chain: debounce → short-circuits → throttle →
 * idle-and-focused → status → cooldown. Uses fake timers and a fully mocked
 * extension-api + gitExec so the chain is exercised without a real repo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gitExecMock = vi.hoisted(() => vi.fn())
vi.mock('../gitService.js', () => ({ gitExec: gitExecMock, gitExecBinary: vi.fn() }))

const apiMock = vi.hoisted(() => ({
  windowState: { focused: true },
  focusListeners: new Set<(state: { focused: boolean }) => void>(),
  workingTreeListeners: {
    create: new Set<() => void>(),
    change: new Set<() => void>(),
    delete: new Set<() => void>(),
  },
  sourceControls: [] as { count: number }[],
  config: {
    autofetch: false,
    autorefresh: true,
    statusLimit: 10000,
  } as Record<string, unknown>,
  /** Number of times `git.autorefresh` has been read via getConfiguration. */
  autorefreshReads: 0,
}))

vi.mock('@universe-editor/extension-api', () => ({
  RelativePattern: class {
    constructor(
      public readonly base: string,
      public readonly pattern: string,
    ) {}
  },
  scm: {
    createSourceControl: vi.fn(() => {
      const sc = {
        acceptInputCommand: undefined,
        inputBox: { value: '', placeholder: '' },
        count: 0,
        commitTemplate: undefined,
        createResourceGroup(id: string, label: string) {
          return { id, label, hideWhenEmpty: undefined, resourceStates: [], dispose() {} }
        },
        dispose() {},
      }
      apiMock.sourceControls.push(sc)
      return sc
    }),
  },
  window: {
    state: apiMock.windowState,
    onDidChangeWindowState: (fn: (state: { focused: boolean }) => void) => {
      apiMock.focusListeners.add(fn)
      return { dispose: () => apiMock.focusListeners.delete(fn) }
    },
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn((section?: string) => ({
      get: vi.fn(async (key: string, fallback: unknown) => {
        if (section === 'git' && key === 'autorefresh') apiMock.autorefreshReads++
        return section === 'git' && key in apiMock.config ? apiMock.config[key] : fallback
      }),
    })),
    createFileSystemWatcher: vi.fn(() => ({
      onDidCreate: (fn: () => void) => {
        apiMock.workingTreeListeners.create.add(fn)
        return { dispose: () => apiMock.workingTreeListeners.create.delete(fn) }
      },
      onDidChange: (fn: () => void) => {
        apiMock.workingTreeListeners.change.add(fn)
        return { dispose: () => apiMock.workingTreeListeners.change.delete(fn) }
      },
      onDidDelete: (fn: () => void) => {
        apiMock.workingTreeListeners.delete.add(fn)
        return { dispose: () => apiMock.workingTreeListeners.delete.delete(fn) }
      },
      dispose() {},
    })),
  },
}))

const { Repository } = await import('../repository.js')

const CLEAN = { exitCode: 0, stdout: '', stderr: '' }

function statusOut(files: readonly string[]): string {
  return files.map((f) => `1 .M N... 0 0 0 0 0 ${f}\0`).join('')
}

const statusCalls = () =>
  gitExecMock.mock.calls.filter((c) => (c[0] as string[])[0] === 'status').length

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

/** Fire the working-tree watcher, then let the 1s chain debounce elapse. */
async function fireChangeAndDrain(): Promise<void> {
  for (const fn of [...apiMock.workingTreeListeners.change]) fn()
  await advance(0)
  await advance(1000)
}

function setFocused(focused: boolean): void {
  apiMock.windowState.focused = focused
  for (const fn of [...apiMock.focusListeners]) fn({ focused })
}

beforeEach(() => {
  vi.useFakeTimers()
  gitExecMock.mockReset()
  gitExecMock.mockImplementation(async () => CLEAN)
  apiMock.windowState.focused = true
  apiMock.focusListeners.clear()
  apiMock.workingTreeListeners.create.clear()
  apiMock.workingTreeListeners.change.clear()
  apiMock.workingTreeListeners.delete.clear()
  apiMock.sourceControls.length = 0
  apiMock.config.autofetch = false
  apiMock.config.autorefresh = true
  apiMock.config.statusLimit = 10000
  apiMock.autorefreshReads = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Repository watcher auto-refresh chain', () => {
  it('defers auto-refresh while unfocused, then refreshes once on focus', async () => {
    apiMock.windowState.focused = false
    const repo = new Repository('/not-a-real-repo')
    try {
      await fireChangeAndDrain()
      expect(statusCalls()).toBe(0)

      setFocused(true)
      await advance(0)
      expect(statusCalls()).toBe(1)
    } finally {
      repo.dispose()
    }
  })

  it('collapses watcher changes within the 1s chain debounce into one refresh', async () => {
    const repo = new Repository('/not-a-real-repo')
    try {
      for (const fn of [...apiMock.workingTreeListeners.change]) fn()
      for (const fn of [...apiMock.workingTreeListeners.change]) fn()
      await advance(0)
      await advance(500) // still inside the 1s chain debounce window
      expect(statusCalls()).toBe(0)
      await advance(500)
      expect(statusCalls()).toBe(1)
    } finally {
      repo.dispose()
    }
  })

  it('runs one trailing refresh after the cooldown for changes made during it', async () => {
    const repo = new Repository('/not-a-real-repo')
    try {
      await fireChangeAndDrain()
      expect(statusCalls()).toBe(1)

      // A change arriving during the 5s cooldown coalesces into one trailing run.
      for (const fn of [...apiMock.workingTreeListeners.change]) fn()
      await advance(0)
      await advance(1000)
      expect(statusCalls()).toBe(1) // still cooling down

      await advance(5000)
      expect(statusCalls()).toBe(2) // trailing run fired, exactly once

      await advance(10000)
      expect(statusCalls()).toBe(2)
    } finally {
      repo.dispose()
    }
  })

  it('skips watcher auto-refresh when git.autorefresh is false, but active refresh still runs', async () => {
    apiMock.config.autorefresh = false
    const repo = new Repository('/not-a-real-repo')
    try {
      await fireChangeAndDrain()
      expect(statusCalls()).toBe(0)

      await repo.refresh()
      expect(statusCalls()).toBe(1)
    } finally {
      repo.dispose()
    }
  })

  it('truncates status to git.statusLimit and short-circuits auto-refresh for huge repos', async () => {
    apiMock.config.statusLimit = 3
    gitExecMock.mockImplementation(async () => ({
      exitCode: 0,
      stdout: statusOut(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']),
      stderr: '',
    }))
    const repo = new Repository('/not-a-real-repo')
    try {
      await repo.refresh()
      expect(apiMock.sourceControls.at(-1)?.count).toBe(3)

      await fireChangeAndDrain()
      expect(statusCalls()).toBe(1) // watcher path skipped, only the active refresh ran
    } finally {
      repo.dispose()
    }
  })

  it('recovers auto-refresh once the change count drops back under git.statusLimit', async () => {
    apiMock.config.statusLimit = 3
    gitExecMock.mockImplementation(async () => ({
      exitCode: 0,
      stdout: statusOut(['a.txt', 'b.txt', 'c.txt', 'd.txt']),
      stderr: '',
    }))
    const repo = new Repository('/not-a-real-repo')
    try {
      await repo.refresh() // hits the limit → huge
      await fireChangeAndDrain()
      expect(statusCalls()).toBe(1) // skipped while huge

      gitExecMock.mockImplementation(async () => ({
        exitCode: 0,
        stdout: statusOut(['a.txt']),
        stderr: '',
      }))
      await repo.refresh() // re-evaluates the flag → no longer huge
      await fireChangeAndDrain()
      expect(statusCalls()).toBe(3)
    } finally {
      repo.dispose()
    }
  })

  it('cancels a pending focus wait on dispose', async () => {
    apiMock.windowState.focused = false
    const repo = new Repository('/not-a-real-repo')
    try {
      await fireChangeAndDrain()
      expect(statusCalls()).toBe(0) // waiting for focus
    } finally {
      repo.dispose()
    }
    setFocused(true)
    await advance(0)
    expect(statusCalls()).toBe(0)
  })

  it('releases a blur-blocked refresh once the 60s fallback elapses', async () => {
    apiMock.windowState.focused = false
    const log = vi.fn()
    const repo = new Repository('/not-a-real-repo', log)
    try {
      await fireChangeAndDrain()
      expect(statusCalls()).toBe(0) // still waiting for focus

      await advance(59_999)
      expect(statusCalls()).toBe(0) // inside the fallback window: still held

      await advance(1)
      expect(statusCalls()).toBe(1) // fallback released exactly one status run
      expect(log).toHaveBeenCalledWith(expect.stringContaining('unfocused for too long'))
    } finally {
      repo.dispose()
    }
  })

  it('short-circuits watcher refresh while a non-read-only operation is in flight', async () => {
    const repo = new Repository('/not-a-real-repo')
    try {
      // Stage runs without a progress spinner; hold its gitExec in flight.
      let resolveStage: (value: unknown) => void = () => undefined
      gitExecMock.mockImplementationOnce(() => new Promise((resolve) => (resolveStage = resolve)))
      const stagePromise = repo.stage(['a.txt'])
      await advance(0)

      await fireChangeAndDrain()
      expect(statusCalls()).toBe(0) // blocked by the in-flight stage

      resolveStage(CLEAN)
      await stagePromise
      const afterStage = statusCalls()
      expect(afterStage).toBeGreaterThanOrEqual(1) // _run's trailing refresh

      await fireChangeAndDrain()
      expect(statusCalls()).toBe(afterStage + 1) // idle again → normal refresh
    } finally {
      repo.dispose()
    }
  })

  it('reads git.autorefresh once per debounce window, not per watcher event', async () => {
    const repo = new Repository('/not-a-real-repo')
    try {
      for (let i = 0; i < 50; i++) {
        for (const fn of [...apiMock.workingTreeListeners.change]) fn()
      }
      await advance(0)
      expect(apiMock.autorefreshReads).toBe(0) // each watcher event is zero-RPC

      await advance(500)
      expect(apiMock.autorefreshReads).toBe(0) // still inside the 1s debounce window

      await advance(500)
      expect(apiMock.autorefreshReads).toBe(1) // debounce fired → exactly one read
      expect(statusCalls()).toBe(1)
    } finally {
      repo.dispose()
    }
  })

  it('skips the config read entirely while the repo is huge', async () => {
    apiMock.config.statusLimit = 3
    gitExecMock.mockImplementation(async () => ({
      exitCode: 0,
      stdout: statusOut(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']),
      stderr: '',
    }))
    const repo = new Repository('/not-a-real-repo')
    try {
      await repo.refresh() // crosses the limit → huge
      expect(apiMock.autorefreshReads).toBe(0) // active refresh never reads autorefresh

      await fireChangeAndDrain()
      expect(apiMock.autorefreshReads).toBe(0) // huge short-circuit precedes the RPC
      expect(statusCalls()).toBe(1)
    } finally {
      repo.dispose()
    }
  })

  it('skips the config read entirely while a git operation is in flight', async () => {
    const repo = new Repository('/not-a-real-repo')
    try {
      let resolveStage: (value: unknown) => void = () => undefined
      gitExecMock.mockImplementationOnce(() => new Promise((resolve) => (resolveStage = resolve)))
      const stagePromise = repo.stage(['a.txt'])
      await advance(0)

      await fireChangeAndDrain()
      expect(apiMock.autorefreshReads).toBe(0) // operation short-circuit precedes the RPC
      expect(statusCalls()).toBe(0)

      resolveStage(CLEAN)
      await stagePromise
    } finally {
      repo.dispose()
    }
  })
})
