/**
 * The post-get read-back: `p4 changes -s submitted -m 1 <spec><revision>` — the
 * one question a get asks to learn where it landed, and the only source of the
 * graph's local-sync-point record.
 *
 * Five properties carry it, each with a way to break silently:
 *  - the revision suffix goes on AFTER filespec escaping (a path's own `@`/`#`
 *    is `%40`/`%23` by then; appending first would leave two revision specifiers
 *    in one filespec);
 *  - an EMPTY answer is an answer ("nothing of this scope was ever submitted"),
 *    while a refusal is not — the caller writes a tombstone for the first and
 *    records nothing for the second;
 *  - a window that EXPIRED is reported as `timedOut` and is not the same thing
 *    as a p4 that refused: only the former is worth asking again, which is how a
 *    wide scope's read-back still reaches the ledger (measured 12.8s for a mid
 *    subtree and 27.3s for a workspace root against a 5s first window — the
 *    real-machine bug where a get recorded nothing at all);
 *  - and it is judged BEFORE the exit code, because an expired window carries the
 *    real one (`0` for a p4 that answered just as the kill landed) while carrying
 *    none of its output — read as an answer, that tombstones a synced scope;
 *  - the budget is the CALLER's, so that second question can be asked under a
 *    wider one without touching this method.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = { end: vi.fn() }
  /** Exit code reported when the watchdog's kill lands. Defaults to a failure,
   *  but a REAL p4 can have exited 0 a moment earlier — the kill then arrives on
   *  a process that is already gone, and `_spawn` still resolves the timeout with
   *  that `0` (`code ?? 1`). That shape is what the callback below models. */
  killExit = 1
  /** A killed p4 still reports its death on `close`, and that is what resolves
   *  the command — so the watchdog's kill has to close here too, or a hung
   *  command would hang the test instead of failing it. */
  kill(): boolean {
    this.emit('close', this.killExit)
    return true
  }
}

const spawnMock = vi.fn<(...args: unknown[]) => FakeChildProcess>()
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

const BRIDGE_KEY = '__universeExtensionHostBridge__'
function installScmBridge(): void {
  ;(globalThis as Record<string, unknown>)[BRIDGE_KEY] = {
    createSourceControl: () => ({
      id: 'perforce',
      label: '',
      rootUri: undefined,
      inputBox: { value: '', placeholder: '', onDidChange: () => ({ dispose() {} }) },
      count: undefined,
      commitTemplate: undefined,
      acceptInputCommand: undefined,
      acceptInputActions: undefined,
      createResourceGroup: () => ({
        id: '',
        label: '',
        hideWhenEmpty: undefined,
        resourceStates: [],
        dispose() {},
      }),
      dispose() {},
    }),
  }
}

const { PerforceClient } = await import('../client.js')
const { ConcurrencyGate } = await import('../concurrency.js')
const { SYNC_POINT_READBACK_SLOW_EXEC } = await import('../client.js')

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const CLIENT = 'testclient'
const SCOPES = ['X:/p4ws/main/a.txt', 'X:/p4ws/main/some dir/...']

function subcommand(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-Mj' || a === '-ztag') continue
    if (a === '-p' || a === '-u' || a === '-c') {
      i++
      continue
    }
    return a
  }
  return undefined
}

function changeRecord(id: string): string {
  return JSON.stringify({
    change: id,
    user: 'testuser',
    client: CLIENT,
    time: '1700000000',
    desc: `change ${id}`,
  })
}

interface HarnessOptions {
  /** Id the read-back answers with; null = an empty answer (nothing synced). */
  id?: string | null
  /** Exit code of the read-back (non-zero = p4 refused). */
  exit?: number
  /** Never close until the watchdog kills it — a query outlasting its window. */
  hang?: boolean
  /** Exit code the fake reports when that kill lands (see FakeChildProcess). */
  killExit?: number
}

function harness(opts: HarnessOptions = {}) {
  const readbackArgvs: string[][] = []
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[1] as string[]) ?? []
    const child = new FakeChildProcess()
    child.killExit = opts.killExit ?? 1
    const cmd = subcommand(argv)
    if (cmd === 'changes') readbackArgvs.push(argv)
    const answer = (): number => {
      let stdout = ''
      let exit = 0
      if (cmd === 'info') {
        stdout = `... clientName ${CLIENT}\n... clientRoot ${ROOT}\n... userName testuser\n\n`
      } else if (cmd === 'changes') {
        const id = opts.id ?? null
        stdout = id ? changeRecord(id) : ''
        exit = opts.exit ?? 0
      }
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      return exit
    }
    if (opts.hang === true && cmd === 'changes') {
      // The answer reaches the pipe, the command never closes: exactly the
      // read-back that outlives its window with its output already on the wire.
      answer()
      return child
    }
    queueMicrotask(() => child.emit('close', answer()))
    return child
  })
  return {
    readbackArgvs,
    create: () =>
      PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
        enabled: true,
        workspaceTtlMs: 30_000,
      }),
  }
}

beforeEach(() => {
  installScmBridge()
  spawnMock.mockReset()
})
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
})

describe('PerforceClient.readGraphSyncPoint', () => {
  it('names the landed change, one `<spec><revision>` per scope', async () => {
    const h = harness({ id: '4519' })
    const client = await h.create()
    const read = await client!.readGraphSyncPoint(SCOPES, '@4521')

    expect(read).toEqual({ id: '4519', failed: false, timedOut: false })
    const argv = h.readbackArgvs[0]!
    expect(argv.slice(argv.indexOf('changes'))).toEqual([
      'changes',
      '-s',
      'submitted',
      '-m',
      '1',
      `${SCOPES[0]}@4521`,
      `${SCOPES[1]}@4521`,
    ])
    client!.dispose()
  })

  it('reports an empty answer as an answer, not a failure', async () => {
    const h = harness({ id: null })
    const client = await h.create()
    expect(await client!.readGraphSyncPoint(SCOPES, '#head')).toEqual({
      id: null,
      failed: false,
      timedOut: false,
    })
    client!.dispose()
  })

  it('answers nothing for an empty scope without asking p4', async () => {
    const h = harness({ id: '4519' })
    const client = await h.create()
    expect(await client!.readGraphSyncPoint([], '@4521')).toEqual({
      id: null,
      failed: true,
      timedOut: false,
    })
    expect(h.readbackArgvs).toHaveLength(0)
    client!.dispose()
  })

  it('marks an expired window as timedOut, and uses the budget it was given', async () => {
    const h = harness({ hang: true })
    const client = await h.create()
    const started = Date.now()
    const read = await client!.readGraphSyncPoint(SCOPES, '@4521', {
      priority: 'background',
      timeoutMs: 20,
    })

    expect(read).toEqual({ id: null, failed: true, timedOut: true })
    // The caller's 20ms window is what killed it — the module's own 5s budget is
    // not consulted, which is the property the wide-scope retry depends on.
    expect(Date.now() - started).toBeLessThan(2_000)
    client!.dispose()
  })

  it('does not call a refusal a timeout, so a broken p4 is not asked twice', async () => {
    const h = harness({ exit: 1 })
    const client = await h.create()
    expect(await client!.readGraphSyncPoint(SCOPES, '@4521')).toEqual({
      id: null,
      failed: true,
      timedOut: false,
    })
    client!.dispose()
  })

  it('never reads an expired window as an empty answer, zero exit code or not', async () => {
    // `_spawn` resolves a timeout with the child's REAL exit code, so a read-back
    // that answered a moment before the kill landed arrives as `exitCode: 0` with
    // its stdout already discarded. Judged as an answer, that is a tombstone for a
    // scope that just synced — "nothing here is synced" — and it retires the wider
    // records standing behind it. This is the one direction that must never be
    // guessed, so the window is judged BEFORE the exit code, not alongside it.
    const h = harness({ id: '4519', hang: true, killExit: 0 })
    const client = await h.create()
    const read = await client!.readGraphSyncPoint(SCOPES, '@4521', {
      priority: 'background',
      timeoutMs: 20,
    })

    expect(read).toEqual({ id: null, failed: true, timedOut: true })
    client!.dispose()
  })
})

describe('the read-back budgets', () => {
  it('dispatches the awaited window short and background', async () => {
    const h = harness({ id: '4519' })
    const client = await h.create()
    const { P4Service } = await import('../p4Service.js')
    const execSpy = vi.spyOn(P4Service.prototype, 'exec')
    await client!.readGraphSyncPoint(SCOPES, '@4521')

    // The dispatched options, not the module constant: this window bounds the
    // tail of every get (the caller awaits it), so widening it is what would make
    // a wide get stall again instead of handing over to the retry.
    const call = execSpy.mock.calls.find((c) => subcommand([...c[0]]) === 'changes')!
    expect(call[1]?.timeoutMs).toBeLessThanOrEqual(5_000)
    expect(call[1]?.priority).toBe('background')
    execSpy.mockRestore()
    client!.dispose()
  })

  it('gives the retry a window wide enough to finish what the first one started', () => {
    // Nobody waits on this one, so its only job is to outlast the widest scope
    // measured on a real workspace (27.3s for a workspace root — see the table on
    // SYNC_POINT_READBACK_EXEC) without giving up the background slot.
    expect(SYNC_POINT_READBACK_SLOW_EXEC.timeoutMs).toBeGreaterThan(27_000)
    expect(SYNC_POINT_READBACK_SLOW_EXEC.priority).toBe('background')
  })
})
