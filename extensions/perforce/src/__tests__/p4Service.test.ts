import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveP4Command, splitArgsForArgfile } from '../p4Service.js'

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

const {
  P4Service,
  DEFAULT_MAX_OUTPUT_BYTES,
  INTERACTIVE_COMMAND_TIMEOUT_MS,
  INTERACTIVE_EXEC,
  INTERACTIVE_CONTENT_EXEC,
} = await import('../p4Service.js')
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

// Repro for the "Chinese depot path → empty Swarm diff" bug: on Windows, spawn
// passes argv as UTF-16 which p4.exe's CRT re-encodes via the system ANSI code
// page (GBK on zh-CN), while P4CHARSET=utf8 makes p4 expect UTF-8 — any non-ASCII
// argument arrives untranslatable and p4 exits 1 with "No Translation for
// parameter". The fix routes such arguments through `p4 -x <argfile>`: a UTF-8
// temp file p4 reads arguments from, bypassing the ANSI argv conversion entirely.
describe('P4Service non-ASCII args go through -x argfile', () => {
  const CN_SPEC = '//depot/资源库/资源表.csv#47'
  let child: FakeChildProcess
  beforeEach(() => {
    child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
  })
  afterEach(() => {
    spawnMock.mockReset()
  })

  function spawnedArgs(): string[] {
    const call = spawnMock.mock.calls.at(-1)
    return (call?.[1] ?? []) as string[]
  }

  it('splitArgsForArgfile moves everything from the first non-ASCII arg into the file', () => {
    expect(splitArgsForArgfile(['print', '-q', CN_SPEC])).toEqual({
      argv: ['print', '-q'],
      argfileLines: [CN_SPEC],
    })
    expect(splitArgsForArgfile(['edit', '-c', '5', '中文A', 'asciiB'])).toEqual({
      argv: ['edit', '-c', '5'],
      argfileLines: ['中文A', 'asciiB'],
    })
    expect(splitArgsForArgfile(['files', '//depot/a.txt'])).toBeUndefined()
  })

  it('replaces non-ASCII argv with a leading -x <utf8 argfile>', async () => {
    const svc = makeService()
    const p = svc.exec(['print', '-q', CN_SPEC])
    await flush()
    const args = spawnedArgs()
    expect(args[0]).toBe('-x')
    const argfile = args[1] as string
    expect(args.slice(2)).toEqual(['print', '-q'])
    expect(args).not.toContain(CN_SPEC)
    // The argfile holds the moved arguments, one per line, as UTF-8 bytes.
    expect(readFileSync(argfile, 'utf8')).toBe(CN_SPEC + '\n')
    child.stdout.emit('data', Buffer.from('content'))
    child.emit('close', 0)
    const result = await p
    expect(result.stdout).toBe('content')
    // The temp argfile is cleaned up once the command finishes.
    expect(existsSync(argfile)).toBe(false)
  })

  it('keeps connection globals on the command line (only the non-ASCII tail moves)', async () => {
    const svc = new P4Service('/repo', new ConcurrencyGate(4), {
      port: 'p4:1666',
      user: 'u',
      client: 'c',
    })
    const p = svc.exec(['-Mj', 'files', CN_SPEC])
    await flush()
    const args = spawnedArgs()
    expect(args[0]).toBe('-x')
    expect(args.slice(2)).toEqual(['-p', 'p4:1666', '-u', 'u', '-c', 'c', '-Mj', 'files'])
    expect(args).not.toContain(CN_SPEC)
    child.emit('close', 0)
    await p
  })

  it('leaves ASCII-only commands untouched (no argfile, no temp file I/O)', async () => {
    const svc = makeService()
    const p = svc.exec(['files', '//depot/a.txt'])
    await flush()
    expect(spawnedArgs()).toEqual(['files', '//depot/a.txt'])
    child.emit('close', 0)
    await p
  })

  it('cleans up the argfile when the command fails', async () => {
    const svc = makeService()
    const p = svc.exec(['print', '-q', CN_SPEC])
    await flush()
    const argfile = spawnedArgs()[1] as string
    expect(existsSync(argfile)).toBe(true)
    child.stderr.emit('data', Buffer.from('some error'))
    child.emit('close', 1)
    const result = await p
    expect(result.exitCode).toBe(1)
    expect(existsSync(argfile)).toBe(false)
  })

  it('execBinary routes non-ASCII args through an argfile too', async () => {
    const svc = makeService()
    const p = svc.execBinary(['print', '-q', '//depot/资源/图.xlsx#3'])
    await flush()
    const args = spawnedArgs()
    expect(args[0]).toBe('-x')
    const argfile = args[1] as string
    expect(readFileSync(argfile, 'utf8')).toBe('//depot/资源/图.xlsx#3\n')
    child.stdout.emit('data', Buffer.from([1, 2, 3]))
    child.emit('close', 0)
    const result = await p
    expect(result.exitCode).toBe(0)
    expect(existsSync(argfile)).toBe(false)
  })
})

// Repro for the Swarm poll wedge: a p4 process that hangs (frozen network drive,
// half-open TCP to a P4P gateway) never emits `close`. Without a spawn timeout it
// holds its ConcurrencyGate slot forever — every later command queues behind it,
// including the Swarm credential lookups (`p4 login -s` / `p4 tickets`) that gate
// every Swarm HTTP request, so the notification poll's latch stayed wedged for
// 44 minutes in the field. A per-command timeout must kill the child and resolve
// a failure result (never reject — the async close handler has no catcher).
describe('P4Service._spawn command timeout', () => {
  let child: FakeChildProcess
  beforeEach(() => {
    child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
  })
  afterEach(() => {
    spawnMock.mockReset()
  })

  it('kills a hung child and resolves a failure result after timeoutMs', async () => {
    const svc = makeService()
    const p = svc.exec(['login', '-s'], { timeoutMs: 50 })
    await flush()
    // Never emit close — the child is hung. The timeout must kill it…
    await new Promise((r) => setTimeout(r, 80))
    expect(child.killed).toBe(true)
    // …and the resulting close resolves a failure instead of hanging forever.
    child.emit('close', null)
    const result = await p
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/timed out after 50ms/)
  })

  it('a fast command is unaffected by the timeout', async () => {
    const svc = makeService()
    const p = svc.exec(['tickets'], { timeoutMs: 1000 })
    await flush()
    child.stdout.emit('data', Buffer.from('p4:1666 (user) ABC123'))
    child.emit('close', 0)
    const result = await p
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('ABC123')
    expect(child.killed).toBe(false)
  })

  it('applies the default timeout when no per-call override is given', async () => {
    const svc = new P4Service('/repo', new ConcurrencyGate(4), undefined, undefined, 50)
    const p = svc.exec(['info'])
    await flush()
    await new Promise((r) => setTimeout(r, 80))
    expect(child.killed).toBe(true)
    child.emit('close', null)
    const result = await p
    expect(result.stderr).toMatch(/timed out after 50ms/)
  })

  it('a killed slot frees the concurrency gate for queued commands', async () => {
    const gate = new ConcurrencyGate(1)
    const svc = new P4Service('/repo', gate, undefined)
    const hung = svc.exec(['opened'], { timeoutMs: 50 })
    await flush()
    // Second command queues behind the hung one (gate of 1).
    const queuedChild = new FakeChildProcess()
    spawnMock.mockReturnValue(queuedChild)
    const queued = svc.exec(['tickets'], { timeoutMs: 1000 })
    await new Promise((r) => setTimeout(r, 80))
    expect(child.killed).toBe(true)
    child.emit('close', null)
    await hung
    // The queued command gets its own child and completes normally.
    await flush()
    queuedChild.stdout.emit('data', Buffer.from('ok'))
    queuedChild.emit('close', 0)
    const result = await queued
    expect(result.stdout).toBe('ok')
  })
})

// User-initiated cancellation (status-bar spinner click → `client.cancelBusy()`).
// Same red line as the watchdog: the abort listener and `close` handler are async,
// so cancelling must resolve a failure result and never reject — a rejection from
// there has no catcher and takes the extension host down.
describe('P4Service._spawn cancellation via AbortSignal', () => {
  let child: FakeChildProcess
  beforeEach(() => {
    child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
  })
  afterEach(() => {
    spawnMock.mockReset()
  })

  it('kills the child and resolves a cancelled failure result', async () => {
    const svc = makeService()
    const source = new AbortController()
    const p = svc.exec(['reconcile', '-n', '-a', '-e', '-d', '/repo/a.txt'], {
      signal: source.signal,
    })
    await flush()
    expect(child.killed).toBe(false)
    source.abort()
    expect(child.killed).toBe(true)
    // A killed child closes with a null code; the failure must be resolved, not thrown.
    child.emit('close', null)
    const result = await p
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/was cancelled/)
  })

  it('kills immediately when the signal is already aborted at spawn time', async () => {
    const svc = makeService()
    const source = new AbortController()
    source.abort()
    const p = svc.exec(['opened'], { signal: source.signal })
    await flush()
    expect(child.killed).toBe(true)
    child.emit('close', null)
    const result = await p
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/cancelled/)
  })

  it('leaves a command that finished before the abort untouched', async () => {
    const svc = makeService()
    const source = new AbortController()
    const p = svc.exec(['info'], { signal: source.signal })
    await flush()
    child.stdout.emit('data', Buffer.from('ok'))
    child.emit('close', 0)
    const result = await p
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('ok')
    // The listener was detached on close — a later abort must not kill anything.
    source.abort()
    expect(child.killed).toBe(false)
  })
})

// End-to-end threading of `P4ExecOptions.priority` through the gate. The
// minutes-long diff-open wedge was that every p4 command shares one FIFO gate, so
// a reconcile disk re-verify fanning ~114 `reconcile -n` batches filled it and the
// user's click (fstat + print) queued at the tail. Interactive commands may use the
// reserved slot and skip ahead; background is hard-capped at `max - reserve`.
describe('P4Service concurrency priority + queued logging', () => {
  let child: FakeChildProcess
  beforeEach(() => {
    child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
  })
  afterEach(() => {
    spawnMock.mockReset()
  })

  it('an interactive command spawns immediately while background batches hold their slots', async () => {
    const gate = new ConcurrencyGate(4, 1) // backgroundCap = 3
    const svc = new P4Service('/repo', gate, undefined)

    // Fill the three background slots with hung reconcile batches.
    const holders: FakeChildProcess[] = []
    for (let i = 0; i < 3; i++) {
      const c = new FakeChildProcess()
      holders.push(c)
      spawnMock.mockReturnValueOnce(c)
      void svc.exec(['reconcile', '-n', '-a', '-e', '-d', `batch${i}`])
    }
    await flush()
    expect(spawnMock).toHaveBeenCalledTimes(3)

    // The user's click arrives while the batch is still running — it must spawn
    // now (into the reserved slot), not queue behind the reconcile batch.
    const interactive = new FakeChildProcess()
    spawnMock.mockReturnValueOnce(interactive)
    void svc.exec(['fstat', 'file.txt'], { priority: 'interactive' })
    await flush()
    expect(spawnMock).toHaveBeenCalledTimes(4)
    expect(spawnMock.mock.calls[3]![1]).toEqual(['fstat', 'file.txt'])

    holders.forEach((c) => c.emit('close', 0))
    interactive.emit('close', 0)
    await flush()
  })

  it('logs a queued line only when a command waited >= 250ms for a slot', async () => {
    const logs: string[] = []
    const gate = new ConcurrencyGate(1, 1)
    const svc = new P4Service('/repo', gate, undefined, (m) => logs.push(m))

    const holder = new FakeChildProcess()
    spawnMock.mockReturnValueOnce(holder)
    const hold = svc.exec(['opened'])
    await flush()

    const queued = new FakeChildProcess()
    spawnMock.mockReturnValueOnce(queued)
    const q = svc.exec(['tickets'])
    await new Promise((r) => setTimeout(r, 300)) // long enough to cross 250ms
    holder.emit('close', 0)
    await hold
    await flush()
    queued.emit('close', 0)
    await q

    expect(logs.some((l) => l.includes('queued'))).toBe(true)
  })

  it('does not log a queued line for a brief wait', async () => {
    const logs: string[] = []
    const gate = new ConcurrencyGate(1, 1)
    const svc = new P4Service('/repo', gate, undefined, (m) => logs.push(m))

    const holder = new FakeChildProcess()
    spawnMock.mockReturnValueOnce(holder)
    const hold = svc.exec(['opened'])
    await flush()

    const queued = new FakeChildProcess()
    spawnMock.mockReturnValueOnce(queued)
    const q = svc.exec(['tickets'])
    await new Promise((r) => setTimeout(r, 20)) // short — must not flood the log
    holder.emit('close', 0)
    await hold
    await flush()
    queued.emit('close', 0)
    await q

    expect(logs.some((l) => l.includes('queued'))).toBe(false)
  })

  it('execRecords carries priority through the -Mj → -ztag retry', async () => {
    const gate = new ConcurrencyGate(4, 1) // backgroundCap = 3
    const svc = new P4Service('/repo', gate, undefined)

    // Fill the background slots with hung commands.
    const holders: FakeChildProcess[] = []
    for (let i = 0; i < 3; i++) {
      const c = new FakeChildProcess()
      holders.push(c)
      spawnMock.mockReturnValueOnce(c)
      void svc.exec(['reconcile', '-n', '-a', '-e', '-d', `batch${i}`])
    }
    await flush()
    expect(spawnMock).toHaveBeenCalledTimes(3)

    // `-Mj` collapses to a data blob → execRecords retries with `-ztag`. Both legs
    // are interactive, so both must spawn immediately without waiting on the batch.
    const mj = new FakeChildProcess()
    const ztag = new FakeChildProcess()
    spawnMock.mockReturnValueOnce(mj).mockReturnValueOnce(ztag)
    const p = svc.execRecords(['changes', '-s', 'pending'], { priority: 'interactive' })
    await flush()
    // The `-Mj` leg spawned immediately while the batch still holds its slots.
    expect(spawnMock).toHaveBeenCalledTimes(4)
    expect(spawnMock.mock.calls[3]![1]).toEqual(['-Mj', 'changes', '-s', 'pending'])

    // Collapsed output → the retry must also spawn immediately (a dropped priority
    // would fall back to background and queue behind the full background cap).
    mj.stdout.emit('data', Buffer.from('{"data":"blob"}\n'))
    mj.emit('close', 0)
    await flush()
    expect(spawnMock).toHaveBeenCalledTimes(5)
    expect(spawnMock.mock.calls[4]![1]).toEqual(['-ztag', 'changes', '-s', 'pending'])

    ztag.stdout.emit('data', Buffer.from('... change 42\n\n'))
    ztag.emit('close', 0)
    const res = await p
    expect(res.records).toEqual([{ change: '42' }])

    holders.forEach((c) => c.emit('close', 0))
    await flush()
  })
})

// W3: user-interactive reads (open diff / gutter / blame) share a tight per-call
// timeout (`INTERACTIVE_EXEC.timeoutMs = 30s`) so a hung interactive command
// fails fast with a toast instead of wedging its gate slot. Pinned here at the
// p4Service level: the constant relationship, and that a hung interactive command
// is killed at its timeoutMs and resolves a failure result (never rejects — the
// async close handler has no catcher, so a rejection would take down the host).
describe('interactive command tight timeout', () => {
  let child: FakeChildProcess
  beforeEach(() => {
    child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
  })
  afterEach(() => {
    spawnMock.mockReset()
  })

  it('INTERACTIVE_EXEC pins interactive priority + the 30s tight timeout', () => {
    expect(INTERACTIVE_COMMAND_TIMEOUT_MS).toBe(30_000)
    expect(INTERACTIVE_EXEC.priority).toBe('interactive')
    expect(INTERACTIVE_EXEC.timeoutMs).toBe(INTERACTIVE_COMMAND_TIMEOUT_MS)
  })

  it('INTERACTIVE_CONTENT_EXEC keeps the reserved slot but drops the tight timeout', () => {
    // `p4 print` streams whole file contents, so its duration scales with size —
    // it jumps the gate but keeps the generous `perforce.commandTimeout` budget.
    expect(INTERACTIVE_CONTENT_EXEC.priority).toBe('interactive')
    expect(INTERACTIVE_CONTENT_EXEC.timeoutMs).toBeUndefined()
  })

  it('a hung interactive command is killed at its timeoutMs and resolves a failure', async () => {
    const svc = makeService()
    // Same options shape as the baseline/gutter read paths, with a small timeout
    // so the hang reproduces fast; the watchdog adoption is what's under test.
    const p = svc.exec(['fstat', 'file.txt'], { ...INTERACTIVE_EXEC, timeoutMs: 30 })
    await flush()
    await new Promise((r) => setTimeout(r, 60))
    expect(child.killed).toBe(true)
    // Resolves a failure result, never rejects (the host-crash red line).
    child.emit('close', null)
    const result = await p
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/timed out after 30ms/)
  })
})
