import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// The module is fully mocked below; importing `commands` here yields the mock's
// registerCommand/executeCommand spies for the poller-driving assertions.
import { commands } from '@universe-editor/extension-api'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  getTransitions: vi.fn(),
  obliterateReview: vi.fn(),
  printRevisionResult: vi.fn(),
  printRevisionBytesResult: vi.fn(),
  dashboard: vi.fn(),
  showErrorMessage: vi.fn(),
  invalidateCredential: vi.fn(),
}))

vi.mock('@universe-editor/extension-api', () => ({
  StatusBarAlignment: { Left: 1 },
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(id, handler)
      return { dispose: vi.fn() }
    }),
    executeCommand: vi.fn(),
  },
  window: {
    createStatusBarItem: vi.fn(() => ({
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    })),
    showErrorMessage: mocks.showErrorMessage,
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(async (_key: string, fallback: unknown) => fallback),
    })),
  },
}))

vi.mock('../swarm/swarmClient.js', () => ({
  SwarmClient: class {
    getTransitions = mocks.getTransitions
    obliterateReview = mocks.obliterateReview
    dashboard = mocks.dashboard
    invalidateCredential = mocks.invalidateCredential
  },
}))

const { registerSwarmCommands } = await import('../swarm/swarmCommands.js')
const { SwarmError, SwarmErrorCode } = await import('../swarm/swarmApi.js')

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  isTraceEnabled: vi.fn(async () => false),
}

describe('registerSwarmCommands review operations', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.getTransitions.mockReset()
    mocks.obliterateReview.mockReset()
    mocks.printRevisionResult.mockReset()
    mocks.printRevisionBytesResult.mockReset()
    mocks.dashboard.mockReset()
    mocks.showErrorMessage.mockReset()
    logger.debug.mockClear()
    logger.info.mockClear()
    logger.warn.mockClear()
    logger.error.mockClear()

    registerSwarmCommands(
      {
        active: {
          user: 'songxiao',
          p4Service: {},
          printRevisionResult: mocks.printRevisionResult,
          printRevisionBytesResult: mocks.printRevisionBytesResult,
        },
      } as never,
      logger,
    )
  })

  it('forwards getTransitions to the server-authoritative client operation', async () => {
    const transitions = [{ state: 'approved', label: 'Approve' }]
    mocks.getTransitions.mockResolvedValue(transitions)

    const result = await mocks.handlers.get('perforce.swarm.getTransitions')?.('1001')

    // No force argument → a plain cached read (the renderer only forces when
    // the review's `updated` stamp moved).
    expect(mocks.getTransitions).toHaveBeenCalledWith('1001', false)
    expect(result).toEqual(transitions)
  })

  it('passes force through to the client so a moved `updated` stamp bypasses the TTL cache', async () => {
    const transitions = [{ state: 'approved', label: 'Approve' }]
    mocks.getTransitions.mockResolvedValue(transitions)

    const result = await mocks.handlers.get('perforce.swarm.getTransitions')?.('1001', true, true)

    expect(mocks.getTransitions).toHaveBeenCalledWith('1001', true)
    expect(result).toEqual(transitions)
  })

  it('getTransitions with silent rethrows instead of raising UI (poll-driven path)', async () => {
    mocks.getTransitions.mockRejectedValue(new SwarmError(SwarmErrorCode.Network, 'boom'))

    await expect(
      mocks.handlers.get('perforce.swarm.getTransitions')?.('1001', false, true),
    ).rejects.toThrow('boom')
    expect(mocks.showErrorMessage).not.toHaveBeenCalled()
  })

  it('forwards obliterateReview and returns true on success', async () => {
    mocks.obliterateReview.mockResolvedValue(undefined)

    const result = await mocks.handlers.get('perforce.swarm.obliterateReview')?.({
      reviewId: '1001',
    })

    expect(mocks.obliterateReview).toHaveBeenCalledWith('1001')
    expect(result).toBe(true)
  })

  // getFileContentBytes backs the spreadsheet (xlsx) webview diff: it must return
  // the raw revision bytes base64-encoded so the zip isn't corrupted by UTF-8
  // decoding on the way to the Excel extension. (Previously covered end-to-end by
  // the swarmSpreadsheetDiff e2e, which was dropped to keep the perforce suite off
  // the non-kernel Excel extension.)
  it('base64-encodes raw revision bytes without utf8 corruption', async () => {
    // Bytes that are NOT valid UTF-8 (0xff 0xfe 0x00) — the xlsx-zip failure mode.
    const raw = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x01])
    mocks.printRevisionBytesResult.mockResolvedValue({ bytes: raw })

    const result = await mocks.handlers.get('perforce.swarm.getFileContentBytes')?.({
      depotFile: '//depot/x.xlsx',
      revision: '@=900',
    })

    expect(mocks.printRevisionBytesResult).toHaveBeenCalledWith('//depot/x.xlsx@=900', false)
    expect(result).toEqual({ content: raw.toString('base64') })
    expect(Buffer.from((result as { content: string }).content, 'base64')).toEqual(raw)
  })

  it('passes the immutable flag through to printRevisionBytesResult', async () => {
    mocks.printRevisionBytesResult.mockResolvedValue({ bytes: Buffer.from('x') })

    await mocks.handlers.get('perforce.swarm.getFileContentBytes')?.({
      depotFile: '//depot/x.xlsx',
      revision: '@=900',
      immutable: true,
    })

    expect(mocks.printRevisionBytesResult).toHaveBeenCalledWith('//depot/x.xlsx@=900', true)
  })

  it('rejects a revision that is not a bare #rev or @=change (filespec guard)', async () => {
    for (const revision of ['@=900 //evil', '#1; rm', 'head', '']) {
      const result = await mocks.handlers.get('perforce.swarm.getFileContentBytes')?.({
        depotFile: '//depot/x.xlsx',
        revision,
      })
      expect(result).toEqual({ content: '', error: 'invalid revision' })
    }
    expect(mocks.printRevisionBytesResult).not.toHaveBeenCalled()
  })

  it('propagates a print failure as a structured error instead of empty content', async () => {
    mocks.printRevisionBytesResult.mockResolvedValue({
      bytes: Buffer.alloc(0),
      error: 'p4 print failed (exit 1)',
    })

    const result = await mocks.handlers.get('perforce.swarm.getFileContentBytes')?.({
      depotFile: '//depot/x.xlsx',
      revision: '@=900',
    })

    expect(result).toEqual({ content: '', error: 'p4 print failed (exit 1)' })
  })

  it('propagates a text print failure as a structured error', async () => {
    mocks.printRevisionResult.mockResolvedValue({
      content: '',
      error: 'p4 print failed (exit 1)',
    })

    const result = await mocks.handlers.get('perforce.swarm.getFileContent')?.({
      depotFile: '//depot/a.txt',
      revision: '#3',
    })

    expect(result).toEqual({ content: '', error: 'p4 print failed (exit 1)' })
  })

  it('returns a structured error when there is no active Perforce client', async () => {
    mocks.handlers.clear()
    registerSwarmCommands({ active: undefined } as never, logger)

    const bytesResult = await mocks.handlers.get('perforce.swarm.getFileContentBytes')?.({
      depotFile: '//depot/x.xlsx',
      revision: '@=900',
    })
    const textResult = await mocks.handlers.get('perforce.swarm.getFileContent')?.({
      depotFile: '//depot/a.txt',
      revision: '#3',
    })

    expect(bytesResult).toEqual({ content: '', error: 'no active Perforce client' })
    expect(textResult).toEqual({ content: '', error: 'no active Perforce client' })
    expect(mocks.printRevisionResult).not.toHaveBeenCalled()
    expect(mocks.printRevisionBytesResult).not.toHaveBeenCalled()
  })

  it('a genuinely empty revision comes back with content and NO error key', async () => {
    mocks.printRevisionResult.mockResolvedValue({ content: '' })
    mocks.printRevisionBytesResult.mockResolvedValue({ bytes: Buffer.alloc(0) })

    const textResult = (await mocks.handlers.get('perforce.swarm.getFileContent')?.({
      depotFile: '//depot/empty.txt',
      revision: '#1',
    })) as Record<string, unknown>
    const bytesResult = (await mocks.handlers.get('perforce.swarm.getFileContentBytes')?.({
      depotFile: '//depot/empty.txt',
      revision: '#1',
    })) as Record<string, unknown>

    expect(textResult.content).toBe('')
    expect(textResult).not.toHaveProperty('error')
    expect(bytesResult.content).toBe('')
    expect(bytesResult).not.toHaveProperty('error')
  })
})

// Repro for "后台时新 review 零通知": the notification poller drives `dashboard`
// on a timer. Poll-driven failures must settle IMMEDIATELY and silently:
// - a MODAL "Login?" confirm (the old 401 path) only settles on a user click,
//   impossible in the background — the renderer's serialized refresh() latch
//   stayed true forever and no later tick ever ran;
// - an error toast per failed tick is pure noise for a background poller;
// - a swallowed EMPTY dashboard fallback reads as "zero reviews", wiping the
//   renderer's notified baseline so the next healthy tick re-fires every review
//   as "new". dashboard therefore rethrows: the renderer's poll catch is quiet.
describe('registerSwarmCommands dashboard failures (poll-driven, silent)', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.dashboard.mockReset()
    mocks.showErrorMessage.mockReset()
    logger.warn.mockClear()

    registerSwarmCommands(
      {
        active: { user: 'songxiao', p4Service: {} },
      } as never,
      logger,
    )
  })

  it('rethrows a 401 without ever opening the modal auth prompt', async () => {
    mocks.dashboard.mockRejectedValue(
      new SwarmError(SwarmErrorCode.Unauthorized, 'Swarm unauthorized (401)', 401),
    )

    // Race against a timeout so the pre-fix behavior (awaiting the modal forever)
    // fails deterministically instead of hanging the test run.
    const dashboardPromise = mocks.handlers.get('perforce.swarm.dashboard')?.({
      force: true,
    }) as Promise<unknown>
    const result = (await Promise.race([
      dashboardPromise.then(
        () => 'resolved',
        (e: unknown) => e,
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('hung on modal')), 2000)),
    ])) as unknown

    expect(result).toBeInstanceOf(SwarmError)
    expect((result as { code: unknown }).code).toBe(SwarmErrorCode.Unauthorized)
    expect(mocks.showErrorMessage).not.toHaveBeenCalled()
    // A 401 means the cached ticket died mid-TTL — the client must drop it so
    // the next request re-probes p4 instead of replaying the corpse.
    expect(mocks.invalidateCredential).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      'cmd',
      'dashboard: unauthorized → skipping (poll-driven, silent)',
    )
  })

  it('rethrows a network/timeout failure without an error toast or empty fallback', async () => {
    mocks.dashboard.mockRejectedValue(
      new SwarmError(SwarmErrorCode.Network, 'timed out after 30000ms: GET /reviews'),
    )

    await expect(
      mocks.handlers.get('perforce.swarm.dashboard')?.({ force: true }),
    ).rejects.toMatchObject({ code: SwarmErrorCode.Network })
    expect(mocks.showErrorMessage).not.toHaveBeenCalled()
  })
})

// The renderer pushes the full polling snapshot ({enabled, pollIntervalSeconds,
// configured}) because the host has no config-change event. The host-side
// configured cache feeds the poller's SYNCHRONOUS per-tick read (a tick path
// awaiting a renderer RPC is the 2026-08 silent-stall class), and the interval
// conversion stays host-side so UNIVERSE_SWARM_POLL_INTERVAL_MS keeps winning.
describe('registerSwarmCommands setBackgroundPoll payload', () => {
  const tickCalls = () =>
    vi.mocked(commands.executeCommand).mock.calls.filter((c) => c[0] === '_workbench.swarmPollTick')

  beforeEach(async () => {
    vi.useFakeTimers()
    mocks.handlers.clear()
    vi.mocked(commands.executeCommand).mockClear()

    registerSwarmCommands(
      {
        active: { user: 'songxiao', p4Service: {} },
      } as never,
      logger,
    )
    // Let the activation fallback finish (mocked config reads resolve with their
    // defaults: pollInterval 0, backgroundPoll disabled, Swarm configured).
    await vi.advanceTimersByTimeAsync(0)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('starts the driver with the pushed interval (raw seconds → host-side ms)', async () => {
    mocks.handlers.get('perforce.swarm.setBackgroundPoll')?.({
      enabled: true,
      pollIntervalSeconds: 30,
      configured: true,
    })

    expect(tickCalls().length).toBe(1) // immediate tick on start
    await vi.advanceTimersByTimeAsync(30_000)
    expect(tickCalls().length).toBe(2)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(tickCalls().length).toBe(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(tickCalls().length).toBe(3)
  })

  it('skips ticks after the renderer reports configured: false', async () => {
    mocks.handlers.get('perforce.swarm.setBackgroundPoll')?.({
      enabled: true,
      pollIntervalSeconds: 10,
      configured: false,
    })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(tickCalls().length).toBe(0)
  })

  it('lets UNIVERSE_SWARM_POLL_INTERVAL_MS override the pushed seconds (e2e)', async () => {
    vi.stubEnv('UNIVERSE_SWARM_POLL_INTERVAL_MS', '1000')
    mocks.handlers.get('perforce.swarm.setBackgroundPoll')?.({
      enabled: true,
      pollIntervalSeconds: 30,
      configured: true,
    })

    expect(tickCalls().length).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(tickCalls().length).toBe(2)
  })
})
