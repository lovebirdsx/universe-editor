/**
 * Autofetch: focus-gated, jittered, self-rescheduling fetch timer. Uses fake
 * timers and a fully mocked extension-api + gitExec so the loop is exercised
 * without a real repo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gitExecMock = vi.hoisted(() => vi.fn())
vi.mock('../gitService.js', () => ({ gitExec: gitExecMock, gitExecBinary: vi.fn() }))

const apiMock = vi.hoisted(() => ({
  windowState: { focused: true },
  focusListeners: new Set<(state: { focused: boolean }) => void>(),
  config: {
    autofetch: true,
    autofetchPeriod: 180,
    statusLimit: 10000,
  } as Record<string, unknown>,
}))

vi.mock('@universe-editor/extension-api', () => ({
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
      count: 0,
      commitTemplate: undefined,
      createResourceGroup(id: string, label: string) {
        return { id, label, hideWhenEmpty: undefined, resourceStates: [], dispose() {} }
      },
      dispose() {},
    })),
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
      get: vi.fn(async (key: string, fallback: unknown) =>
        section === 'git' && key in apiMock.config ? apiMock.config[key] : fallback,
      ),
    })),
    createFileSystemWatcher: vi.fn(() => ({
      onDidCreate: () => ({ dispose() {} }),
      onDidChange: () => ({ dispose() {} }),
      onDidDelete: () => ({ dispose() {} }),
      dispose() {},
    })),
  },
}))

const { Repository } = await import('../repository.js')

const CLEAN = { exitCode: 0, stdout: '', stderr: '' }

const fetchCalls = () =>
  gitExecMock.mock.calls.filter((c) => (c[0] as string[])[0] === 'fetch').length

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

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
  apiMock.config.autofetch = true
  apiMock.config.autofetchPeriod = 180
  apiMock.config.statusLimit = 10000
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Repository autofetch', () => {
  it('defers autofetch while unfocused, then runs once on refocus', async () => {
    apiMock.windowState.focused = false
    const repo = new Repository('/not-a-real-repo')
    try {
      await advance(0) // flush async _startAutofetch → schedule the initial timer
      await advance(8000) // initial (3s~8s) timer fires; unfocused → awaiting focus
      expect(fetchCalls()).toBe(0)

      setFocused(true)
      await advance(0)
      expect(fetchCalls()).toBe(1)
    } finally {
      repo.dispose()
    }
  })

  it('coalesces missed periods while unfocused into a single catch-up fetch', async () => {
    apiMock.windowState.focused = false
    const repo = new Repository('/not-a-real-repo')
    try {
      await advance(0)
      await advance(1_000_000) // many periods pass; loop is suspended awaiting focus
      expect(fetchCalls()).toBe(0)

      setFocused(true)
      await advance(0)
      expect(fetchCalls()).toBe(1)

      await advance(200_000) // one full period (180s ±10%) elapses while focused
      expect(fetchCalls()).toBe(2)
    } finally {
      repo.dispose()
    }
  })

  it('staggers the first delay and period with jitter (lower bound)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const repo = new Repository('/not-a-real-repo')
    try {
      await advance(0)
      await advance(3000) // first delay = 3000 + 0 * 5000
      expect(fetchCalls()).toBe(1)
      await advance(162000) // period = 180000 * (1 - 0.1 + 0)
      expect(fetchCalls()).toBe(2)
    } finally {
      repo.dispose()
    }
  })

  it('staggers the first delay and period with jitter (upper bound)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1)
    const repo = new Repository('/not-a-real-repo')
    try {
      await advance(0)
      await advance(7999) // first delay = 3000 + 1 * 5000 = 8000, not yet
      expect(fetchCalls()).toBe(0)
      await advance(1)
      expect(fetchCalls()).toBe(1)
      await advance(198000) // period = 180000 * (1 - 0.1 + 0.2)
      expect(fetchCalls()).toBe(2)
    } finally {
      repo.dispose()
    }
  })

  it('does not run a pending catch-up fetch after dispose', async () => {
    apiMock.windowState.focused = false
    const repo = new Repository('/not-a-real-repo')
    await advance(0)
    await advance(8000) // initial timer fired; awaiting focus
    expect(fetchCalls()).toBe(0)

    repo.dispose()
    setFocused(true)
    await advance(0)
    expect(fetchCalls()).toBe(0)
  })

  it('schedules nothing when git.autofetch is false', async () => {
    apiMock.config.autofetch = false
    const repo = new Repository('/not-a-real-repo')
    await advance(0)
    await advance(1_000_000)
    expect(fetchCalls()).toBe(0)
    repo.dispose()
  })

  it('logs fetch failures without leaving an unhandled rejection', async () => {
    const log = vi.fn()
    const repo = new Repository('/not-a-real-repo', log)
    try {
      await advance(0)
      gitExecMock.mockImplementationOnce(async () => {
        throw new Error('boom')
      })
      await advance(8000)
      expect(fetchCalls()).toBe(1)
      expect(gitExecMock).toHaveBeenCalledWith(['fetch'], '/not-a-real-repo', log)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('autofetch failed'))
    } finally {
      repo.dispose()
    }
  })
})
