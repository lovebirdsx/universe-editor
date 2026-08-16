/**
 * refresh() coalescing: a concurrent call used to return immediately after
 * flagging `_queued`, so the caller's promise didn't mean "my refresh was
 * actually served". The SCM title Refresh button awaits exactly this promise
 * for its disabled/spinner state — a concurrent refresh must now wait for the
 * in-flight pass (which observes the queued flag and runs another round).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gitExecMock = vi.hoisted(() => vi.fn())
vi.mock('../gitService.js', () => ({ gitExec: gitExecMock, gitExecBinary: vi.fn() }))

vi.mock('@universe-editor/extension-api', () => ({
  StatusBarAlignment: { Left: 1 },
  RelativePattern: class {
    constructor(
      public readonly base: string,
      public readonly pattern: string,
    ) {}
  },
  scm: {
    createSourceControl: vi.fn(() => ({
      acceptInputCommand: undefined,
      inputBox: { value: '', placeholder: '' },
      count: undefined,
      commitTemplate: undefined,
      createResourceGroup(id: string, label: string) {
        return { id, label, hideWhenEmpty: undefined, resourceStates: [], dispose() {} }
      },
      dispose() {},
    })),
  },
  window: {
    createStatusBarItem: vi.fn(() => ({
      text: '',
      tooltip: '',
      command: undefined,
      showProgress: false,
      show() {},
      hide() {},
      dispose() {},
    })),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(async (_key: string, fallback: unknown) => fallback),
    })),
    createFileSystemWatcher: vi.fn(() => ({
      onDidCreate: vi.fn(() => ({ dispose() {} })),
      onDidChange: vi.fn(() => ({ dispose() {} })),
      onDidDelete: vi.fn(() => ({ dispose() {} })),
      dispose() {},
    })),
  },
}))

const { Repository } = await import('../repository.js')

const CLEAN = { exitCode: 0, stdout: '', stderr: '' }

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe('Repository refresh coalescing', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ue-git-refresh-'))
    gitExecMock.mockReset()
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('a concurrent refresh waits for the in-flight pass and gets its own round', async () => {
    let releaseFirst!: () => void
    const firstStatus = new Promise<typeof CLEAN>((res) => {
      releaseFirst = () => res(CLEAN)
    })
    // The first `git status` hangs until released; every later call succeeds.
    gitExecMock.mockImplementationOnce(() => firstStatus).mockImplementation(async () => CLEAN)

    const repo = new Repository(root)
    try {
      const first = repo.refresh()
      await vi.waitFor(() => expect(gitExecMock).toHaveBeenCalledTimes(1))

      let secondResolved = false
      const second = repo.refresh().then(() => {
        secondResolved = true
      })
      await tick()
      await tick()
      // Old behaviour returned immediately; the caller must now wait in flight.
      expect(secondResolved).toBe(false)
      expect(gitExecMock).toHaveBeenCalledTimes(1)

      releaseFirst()
      await vi.waitFor(() => expect(secondResolved).toBe(true))
      await Promise.all([first, second])

      // The queued flag ran another full round: a second `git status`.
      const statusCalls = gitExecMock.mock.calls.filter(
        (args) => (args[0] as string[])[0] === 'status',
      ).length
      expect(statusCalls).toBeGreaterThanOrEqual(2)
    } finally {
      repo.dispose()
    }
  })
})

describe('Repository autofetch', () => {
  it('catches a git spawn failure instead of leaking an unhandled rejection', async () => {
    vi.useFakeTimers()
    const root = '/not-a-real-repo'
    const log = vi.fn()
    gitExecMock.mockRejectedValue(new Error('spawn git ENOENT'))
    const repo = new Repository(root, log)
    try {
      // Let `_startAutofetch` finish its config reads and schedule the timers.
      await vi.advanceTimersByTimeAsync(0)
      // Fire the initial 3s autofetch tick.
      await vi.advanceTimersByTimeAsync(3100)
      expect(gitExecMock).toHaveBeenCalledWith(['fetch'], root, log)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('autofetch failed'))
    } finally {
      repo.dispose()
      vi.useRealTimers()
    }
  })
})
