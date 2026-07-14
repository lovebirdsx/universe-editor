import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  getTransitions: vi.fn(),
  obliterateReview: vi.fn(),
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
    logger.debug.mockClear()
    logger.info.mockClear()
    logger.warn.mockClear()
    logger.error.mockClear()

    registerSwarmCommands(
      {
        active: { user: 'songxiao', p4Service: {} },
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
})
