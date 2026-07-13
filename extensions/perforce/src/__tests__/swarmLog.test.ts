import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub the extension-api workspace config the logger reads `swarm.trace` from.
const traceValue = { current: false }
vi.mock('@universe-editor/extension-api', () => ({
  workspace: {
    getConfiguration: () => ({
      get: async (_key: string, _default: unknown) => traceValue.current,
    }),
  },
}))

const { createSwarmLogger } = await import('../swarm/swarmLog.js')

describe('createSwarmLogger', () => {
  beforeEach(() => {
    traceValue.current = false
  })

  it('formats info lines as `HH:mm:ss.SSS [level] [scope] message`', () => {
    const lines: string[] = []
    const log = createSwarmLogger((l) => lines.push(l))
    log.info('api', 'hello')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} \[info\] \[api\] hello$/)
  })

  it('emits warn / error synchronously regardless of trace', () => {
    const lines: string[] = []
    const log = createSwarmLogger((l) => lines.push(l))
    log.warn('status', 'w')
    log.error('cmd', 'e')
    expect(lines[0]).toContain('[warn] [status] w')
    expect(lines[1]).toContain('[error] [cmd] e')
  })

  it('suppresses debug lines when trace is off', async () => {
    const lines: string[] = []
    const log = createSwarmLogger((l) => lines.push(l))
    log.debug('api', 'verbose')
    // debug resolves a config promise before deciding; flush the microtask queue.
    await Promise.resolve()
    await Promise.resolve()
    expect(lines).toHaveLength(0)
  })

  it('emits debug lines when trace is on', async () => {
    traceValue.current = true
    const lines: string[] = []
    const log = createSwarmLogger((l) => lines.push(l))
    log.debug('api', 'verbose')
    await Promise.resolve()
    await Promise.resolve()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[debug] [api] verbose')
  })

  it('isTraceEnabled reflects the config value', async () => {
    const log = createSwarmLogger(() => {})
    expect(await log.isTraceEnabled()).toBe(false)
    traceValue.current = true
    expect(await log.isTraceEnabled()).toBe(true)
  })
})
