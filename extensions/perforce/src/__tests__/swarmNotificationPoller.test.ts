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
  // The poller mirrors lifecycle lines to stderr (→ extensionHost.log) via the
  // semantic console method; spy on all of them so tests stay quiet and the
  // mirror stays assertable in call order.
  const mirroredLines: string[] = []
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.executeCommand.mockReset().mockResolvedValue(undefined)
    logger.debug.mockClear()
    logger.info.mockClear()
    logger.warn.mockClear()
    logger.error.mockClear()
    mirroredLines.length = 0
    for (const method of ['info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        mirroredLines.push(String(args[0]))
      })
    }
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('ticks immediately on start, then on each interval when configured', async () => {
    const poller = new SwarmNotificationPoller(() => true, logger, 1000)
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(tickCalls().length).toBe(1)

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(tickCalls().length).toBe(3)
    poller.dispose()
  })

  it('does not tick while Swarm is unconfigured', async () => {
    const poller = new SwarmNotificationPoller(() => false, logger, 1000)
    poller.start()

    await vi.advanceTimersByTimeAsync(2000)

    expect(mocks.executeCommand).not.toHaveBeenCalled()
    poller.dispose()
  })

  it('fails open (ticks) while the configured cache is still cold', async () => {
    // undefined = neither the renderer push nor the activation fallback has
    // populated the cache yet. Poking is harmless (the renderer defends itself
    // against an unregistered dashboard command); a stuck "unconfigured"
    // verdict is the silent-death class this poller exists to kill.
    const poller = new SwarmNotificationPoller(() => undefined, logger, 1000)
    poller.start()

    await vi.advanceTimersByTimeAsync(2000)

    expect(tickCalls().length).toBe(3)
    poller.dispose()
  })

  it('stops ticking after dispose', async () => {
    const poller = new SwarmNotificationPoller(() => true, logger, 1000)
    poller.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.executeCommand).toHaveBeenCalledTimes(2)

    poller.dispose()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.executeCommand).toHaveBeenCalledTimes(2)
  })

  it('swallows executeCommand failures and keeps ticking', async () => {
    mocks.executeCommand.mockRejectedValueOnce(new Error('renderer not ready'))
    const poller = new SwarmNotificationPoller(() => true, logger, 1000)
    poller.start()

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(mocks.executeCommand).toHaveBeenCalledTimes(3)
    expect(logger.warn).toHaveBeenCalledWith('status', expect.stringContaining('poll tick failed'))
    poller.dispose()
  })

  it('setEnabled(false) stops the driver; setEnabled(true) restarts it with an immediate tick', async () => {
    const poller = new SwarmNotificationPoller(() => true, logger, 1000)
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
    const poller = new SwarmNotificationPoller(() => true, logger, 60_000)
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

  // Repro for the 2026-08 2.5-hour silence: awaiting the renderer's ack (or a
  // config RPC) inside the tick stalls every later tick while the window is
  // background-throttled — the promise neither settles nor rejects, so nothing
  // ever logs. The poke must be fire-and-forget: ticks keep firing on schedule
  // and each unacknowledged one leaves a warn after the 30s watchdog.
  describe('an unacknowledged poke never stalls the driver', () => {
    it('keeps ticking and warns per timed-out poke while the RPC never settles', async () => {
      mocks.executeCommand.mockImplementation(() => new Promise(() => {}))
      const poller = new SwarmNotificationPoller(() => true, logger, 1000)
      poller.start()

      // 60s of wall clock: ticks fire every second regardless of the pending pokes.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(tickCalls().length).toBe(61) // immediate tick + 60 interval ticks

      // Pokes fired in the first 30s have all tripped their watchdog by now.
      const ackWarnings = logger.warn.mock.calls.filter((c) =>
        String(c[1]).includes('not acknowledged'),
      )
      expect(ackWarnings.length).toBeGreaterThanOrEqual(30)
      poller.dispose()
    })

    it('dispose silences the in-flight watchdogs', async () => {
      mocks.executeCommand.mockImplementation(() => new Promise(() => {}))
      const poller = new SwarmNotificationPoller(() => true, logger, 1000)
      poller.start()
      await vi.advanceTimersByTimeAsync(1000)

      poller.dispose()
      logger.warn.mockClear()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('logs ack restored once the renderer answers after a timeout window', async () => {
      let resolvePoke: (() => void) | undefined
      mocks.executeCommand.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolvePoke = resolve
          }),
      )
      const poller = new SwarmNotificationPoller(() => true, logger, 60_000)
      poller.start()
      expect(tickCalls().length).toBe(1)

      // The poke goes unanswered past the watchdog…
      await vi.advanceTimersByTimeAsync(30_000)
      expect(logger.warn).toHaveBeenCalledWith(
        'status',
        expect.stringContaining('not acknowledged'),
      )

      // …then the renderer comes back: recovery is visible exactly once.
      resolvePoke!()
      await vi.advanceTimersByTimeAsync(0)
      expect(logger.info).toHaveBeenCalledWith('status', 'poll tick ack restored')
      poller.dispose()
    })
  })

  // The lifecycle decisions must survive a restart: the Swarm output channel is
  // in-memory, so these lines ALSO go to stderr, which the main process forwards
  // into the session's extensionHost.log. Frequency is bounded (start/stop are
  // rare, timeouts at most one per interval), so the log cannot be flooded.
  describe('lifecycle mirror to stderr (extensionHost.log)', () => {
    const stderrLines = () => [...mirroredLines]

    it('mirrors start / re-arm / stop, but not the per-tick failure warn', async () => {
      const poller = new SwarmNotificationPoller(() => true, logger, 1000)
      poller.start()
      poller.setIntervalMs(2000)
      poller.setEnabled(false)
      expect(stderrLines()).toEqual([
        '[swarm poll] poll driver every 1s',
        '[swarm poll] poll driver re-armed every 2s',
        '[swarm poll] poll driver stopped (backgroundPoll disabled)',
      ])
      // Routine lifecycle is not an error: main routes the stderr level tag back
      // to a log level, so these must ride console.info, not console.error.
      expect(vi.mocked(console.error)).not.toHaveBeenCalled()
      expect(vi.mocked(console.info)).toHaveBeenCalledTimes(3)

      // A rejected poke stays channel-only: it is renderer-state noise (normal
      // during activation), not poller lifecycle.
      mocks.executeCommand.mockRejectedValueOnce(new Error('renderer not ready'))
      poller.setEnabled(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(stderrLines().filter((l) => l.includes('poll tick failed'))).toEqual([])
      poller.dispose()
    })

    it('mirrors the ack-timeout warn and the ack-restored info', async () => {
      let resolvePoke: (() => void) | undefined
      mocks.executeCommand.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolvePoke = resolve
          }),
      )
      const poller = new SwarmNotificationPoller(() => true, logger, 60_000)
      poller.start()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(stderrLines()).toContain(
        '[swarm poll] poll tick not acknowledged by renderer within 30s',
      )
      // A wedged renderer is a genuine warning; the recovery line is not.
      expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
        '[swarm poll] poll tick not acknowledged by renderer within 30s',
      )

      resolvePoke!()
      await vi.advanceTimersByTimeAsync(0)
      expect(stderrLines()).toContain('[swarm poll] poll tick ack restored')
      expect(vi.mocked(console.error)).not.toHaveBeenCalled()
      poller.dispose()
    })
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
