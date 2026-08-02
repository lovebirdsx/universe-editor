import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  getTransitions: vi.fn(),
  obliterateReview: vi.fn(),
  printRevisionBytes: vi.fn(),
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
    mocks.printRevisionBytes.mockReset()
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
          printRevisionBytes: mocks.printRevisionBytes,
        },
      } as never,
      logger,
    )
  })

  it('forwards getTransitions to the server-authoritative client operation', async () => {
    const transitions = [{ state: 'approved', label: 'Approve' }]
    mocks.getTransitions.mockResolvedValue(transitions)

    const result = await mocks.handlers.get('perforce.swarm.getTransitions')?.('1001')

    expect(mocks.getTransitions).toHaveBeenCalledWith('1001')
    expect(result).toEqual(transitions)
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
    mocks.printRevisionBytes.mockResolvedValue(raw)

    const result = await mocks.handlers.get('perforce.swarm.getFileContentBytes')?.({
      depotFile: '//depot/x.xlsx',
      revision: '@=900',
    })

    expect(mocks.printRevisionBytes).toHaveBeenCalledWith('//depot/x.xlsx@=900', false)
    expect(result).toBe(raw.toString('base64'))
    expect(Buffer.from(result as string, 'base64')).toEqual(raw)
  })

  it('passes the immutable flag through to printRevisionBytes', async () => {
    mocks.printRevisionBytes.mockResolvedValue(Buffer.from('x'))

    await mocks.handlers.get('perforce.swarm.getFileContentBytes')?.({
      depotFile: '//depot/x.xlsx',
      revision: '@=900',
      immutable: true,
    })

    expect(mocks.printRevisionBytes).toHaveBeenCalledWith('//depot/x.xlsx@=900', true)
  })

  it('rejects a revision that is not a bare #rev or @=change (filespec guard)', async () => {
    for (const revision of ['@=900 //evil', '#1; rm', 'head', '']) {
      const result = await mocks.handlers.get('perforce.swarm.getFileContentBytes')?.({
        depotFile: '//depot/x.xlsx',
        revision,
      })
      expect(result).toBe('')
    }
    expect(mocks.printRevisionBytes).not.toHaveBeenCalled()
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
