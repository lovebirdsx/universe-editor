import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(),
}))

vi.mock('@universe-editor/extension-api', () => ({
  commands: { executeCommand: mocks.executeCommand },
}))

const { SwarmNotificationPoller, resolveSwarmPollIntervalMs } =
  await import('../swarm/swarmNotificationPoller.js')

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  isTraceEnabled: vi.fn(async () => false),
}

const tickCalls = () =>
  mocks.executeCommand.mock.calls.filter((c) => c[0] === '_workbench.swarmPollTick')

describe('SwarmNotificationPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.executeCommand.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => vi.useRealTimers())

  it('ticks immediately on start, then on each interval when configured', async () => {
    const poller = new SwarmNotificationPoller(async () => true, logger, 1000)
    poller.start()
    // The immediate tick is fire-and-forget; let its isConfigured() await flush.
    await vi.advanceTimersByTimeAsync(0)
    expect(tickCalls().length).toBe(1)

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(tickCalls().length).toBe(3)
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
    expect(mocks.executeCommand).toHaveBeenCalledTimes(2)

    poller.dispose()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.executeCommand).toHaveBeenCalledTimes(2)
  })

  it('swallows executeCommand failures and keeps ticking', async () => {
    mocks.executeCommand.mockRejectedValueOnce(new Error('renderer not ready'))
    const poller = new SwarmNotificationPoller(async () => true, logger, 1000)
    poller.start()

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(mocks.executeCommand).toHaveBeenCalledTimes(3)
    poller.dispose()
  })

  it('setEnabled(false) stops the driver; setEnabled(true) restarts it with an immediate tick', async () => {
    const poller = new SwarmNotificationPoller(async () => true, logger, 1000)
    poller.setEnabled(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.executeCommand).toHaveBeenCalledTimes(2)

    poller.setEnabled(false)
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.executeCommand).toHaveBeenCalledTimes(2)

    poller.setEnabled(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.executeCommand).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.executeCommand).toHaveBeenCalledTimes(4)
    poller.dispose()
  })

  it('setIntervalMs re-arms a running driver instead of locking in the old interval', async () => {
    const poller = new SwarmNotificationPoller(async () => true, logger, 60_000)
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.executeCommand).toHaveBeenCalledTimes(1)

    // The renderer's setEnabled(true) push started the driver before the async
    // config read delivered the configured interval — it must still apply.
    poller.setIntervalMs(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.executeCommand).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.executeCommand).toHaveBeenCalledTimes(3)
    poller.dispose()
  })
})

describe('resolveSwarmPollIntervalMs', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('defaults to 60s when unset and the config is 0', () => {
    expect(resolveSwarmPollIntervalMs(0)).toBe(60_000)
  })

  it('applies the 10s floor to the configured seconds', () => {
    expect(resolveSwarmPollIntervalMs(30)).toBe(30_000)
    expect(resolveSwarmPollIntervalMs(5)).toBe(10_000)
  })

  it('lets the e2e env override bypass the floor', () => {
    vi.stubEnv('UNIVERSE_SWARM_POLL_INTERVAL_MS', '1000')
    expect(resolveSwarmPollIntervalMs(10)).toBe(1000)
  })
})
