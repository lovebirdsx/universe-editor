import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  getTransitions: vi.fn(),
  obliterateReview: vi.fn(),
  printRevisionBytes: vi.fn(),
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
    showErrorMessage: vi.fn(),
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
  },
}))

const { registerSwarmCommands } = await import('../swarm/swarmCommands.js')

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

    expect(mocks.printRevisionBytes).toHaveBeenCalledWith('//depot/x.xlsx@=900')
    expect(result).toBe(raw.toString('base64'))
    expect(Buffer.from(result as string, 'base64')).toEqual(raw)
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
