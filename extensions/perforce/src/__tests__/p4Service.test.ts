import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveP4Command } from '../p4Service.js'

const ORIGINAL = process.env.UNIVERSE_P4_PATH

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.UNIVERSE_P4_PATH
  else process.env.UNIVERSE_P4_PATH = ORIGINAL
})

describe('resolveP4Command', () => {
  it('defaults to `p4` from PATH when no override is set', () => {
    delete process.env.UNIVERSE_P4_PATH
    expect(resolveP4Command()).toEqual({ command: 'p4', prefixArgs: [] })
  })

  it('runs a .mjs override through the current Node runtime', () => {
    process.env.UNIVERSE_P4_PATH = '/tmp/fake-p4.mjs'
    const { command, prefixArgs } = resolveP4Command()
    expect(command).toBe(process.execPath)
    expect(prefixArgs).toEqual(['/tmp/fake-p4.mjs'])
  })

  it('runs .js / .cjs overrides through Node too', () => {
    for (const path of ['/tmp/fake.js', '/tmp/fake.cjs']) {
      process.env.UNIVERSE_P4_PATH = path
      expect(resolveP4Command()).toEqual({ command: process.execPath, prefixArgs: [path] })
    }
  })

  it('spawns a non-script override directly (a real p4 binary path)', () => {
    process.env.UNIVERSE_P4_PATH = '/opt/perforce/p4'
    expect(resolveP4Command()).toEqual({ command: '/opt/perforce/p4', prefixArgs: [] })
  })
})

// A controllable fake child process: tests push stdout chunks / close it by hand.
class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = { end: vi.fn() }
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

const spawnMock = vi.fn<(...args: unknown[]) => FakeChildProcess>()
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

const { P4Service, DEFAULT_MAX_OUTPUT_BYTES } = await import('../p4Service.js')
const { ConcurrencyGate } = await import('../concurrency.js')

function makeService() {
  return new P4Service('/repo', new ConcurrencyGate(4), undefined)
}

// `exec` awaits the concurrency gate before spawning, so the child is created a
// microtask later; flush pending microtasks before emitting on it.
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('P4Service._spawn output cap', () => {
  let child: FakeChildProcess
  beforeEach(() => {
    child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
  })
  afterEach(() => {
    spawnMock.mockReset()
  })

  it('resolves normally for output under the cap', async () => {
    const svc = makeService()
    const p = svc.exec(['info'])
    await flush()
    child.stdout.emit('data', Buffer.from('hello world'))
    child.emit('close', 0)
    const result = await p
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello world')
    expect(child.killed).toBe(false)
  })

  it('aborts and fails gracefully instead of crashing when stdout exceeds the cap', async () => {
    const svc = makeService()
    // Tiny cap so we don't have to allocate 256MB to reproduce the overflow.
    const p = svc.exec(['print', '//depot/huge'], { maxOutputBytes: 1024 })
    await flush()
    child.stdout.emit('data', Buffer.alloc(600))
    child.stdout.emit('data', Buffer.alloc(600)) // crosses the cap → abort
    expect(child.killed).toBe(true)
    child.emit('close', 1)
    const result = await p
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/exceeded .*MB and was aborted/)
  })

  it('has a default cap comfortably below the V8 string limit (0x1fffffe8)', () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeLessThan(0x1fffffe8)
  })

  it('does not reject (host crash) — a spawn error still surfaces as a rejection', async () => {
    const svc = makeService()
    const p = svc.exec(['info'])
    await flush()
    child.emit('error', new Error('p4 not found'))
    await expect(p).rejects.toThrow('p4 not found')
  })
})
