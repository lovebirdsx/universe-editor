import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(),
}))

vi.mock('@universe-editor/extension-api', () => ({
  commands: { executeCommand: mocks.executeCommand },
}))

const { SwarmNotificationPoller } = await import('../swarm/swarmNotificationPoller.js')

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  isTraceEnabled: vi.fn(async () => false),
}

describe('SwarmNotificationPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.executeCommand.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => vi.useRealTimers())

  it('pokes the renderer via _workbench.swarmPollTick on each interval when configured', async () => {
    const poller = new SwarmNotificationPoller(async () => true, logger, 1000)
    poller.start()

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    const tickCalls = mocks.executeCommand.mock.calls.filter(
      (c) => c[0] === '_workbench.swarmPollTick',
    )
    expect(tickCalls.length).toBe(2)
    poller.dispose()
  })

  it('does not tick while Swarm is unconfigured', async () => {
    const poller = new SwarmNotificationPoller(async () => false, logger, 1000)
    poller.start()

    await vi.advanceTimersByTimeAsync(2000)

    expect(mocks.executeCommand).not.toHaveBeenCalled()
    poller.dispose()
  })

  it('stops ticking after dispose', async () => {
    const poller = new SwarmNotificationPoller(async () => true, logger, 1000)
    poller.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.executeCommand).toHaveBeenCalledTimes(1)

    poller.dispose()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.executeCommand).toHaveBeenCalledTimes(1)
  })

  it('swallows executeCommand failures and keeps ticking', async () => {
    mocks.executeCommand.mockRejectedValueOnce(new Error('renderer not ready'))
    const poller = new SwarmNotificationPoller(async () => true, logger, 1000)
    poller.start()

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(mocks.executeCommand).toHaveBeenCalledTimes(2)
    poller.dispose()
  })
})
