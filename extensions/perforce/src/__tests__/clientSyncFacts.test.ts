/**
 * `SyncRunResult.facts`: the only place some run facts exist — the engine that
 * served the get, the parallel-thread knob in force, and the I/O counters —
 * snapshotted by `PerforceClient.sync` onto its result for the sync history.
 *
 * The load-bearing assertion here is that `io` SURVIVES the run: the counters it
 * reads are zeroed by the sync teardown (`_endExternalSuspend` →
 * `_stopSyncIoProbes`), so a snapshot taken one step later always reads "no
 * sampler". The rest pins the two sentinels around it — no sampler at all, and a
 * sampler that never reported — both of which must read as ABSENT rather than as
 * a real-looking 0 B. A third sentinel is the whole set of facts: a get the
 * editor refused before spawning anything has none to give.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileSystemWatcher } from '@universe-editor/extension-api'
import type { PerforceClientOptions } from '../client.js'
import { scopeFixture } from './scopeFixture.js'
import { clientSpecReply, isClientSpecProbe } from './discoveryProbe.js'
type PerforceClientInstance = import('../client.js').PerforceClient

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = { end: vi.fn() }
  pid: number | undefined = 4242
  kill(): boolean {
    return true
  }
}

const spawnMock = vi.fn<(...args: unknown[]) => FakeChildProcess>()
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

/** The sync I/O sampler, faked: the real one spawns a platform process. The
 *  fake hands the test the callbacks so samples and failures are driven
 *  deterministically. */
interface FakeIoProbe {
  readonly pid: number
  readonly dispose: ReturnType<typeof vi.fn>
  readonly sample: (read: number, write: number) => void
}
const ioMock = vi.hoisted(() => ({ probes: [] as unknown[], available: true }))

vi.mock('../processIo.js', () => ({
  createP4IoProbe: (pid: number, options: Record<string, unknown>) => {
    if (!ioMock.available) return undefined
    const probe: FakeIoProbe = {
      pid,
      dispose: vi.fn(),
      sample: (read, write) => (options.onSample as (s: unknown) => void)({ read, write }),
    }
    ioMock.probes.push(probe)
    return probe
  },
}))

const mocks = vi.hoisted(() => ({ executeCommand: vi.fn(), showMessage: vi.fn() }))

const windowMock = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
}))
vi.mock('@universe-editor/extension-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@universe-editor/extension-api')>()
  return { ...actual, window: windowMock }
})

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => ''),
  chmod: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}))

const BRIDGE_KEY = '__universeExtensionHostBridge__'
function installBridge(): void {
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
    executeCommand: mocks.executeCommand,
    showMessage: mocks.showMessage,
  }
}

const { PerforceClient } = await import('../client.js')
const { ConcurrencyGate } = await import('../concurrency.js')
const { P4deltaService } = await import('../p4delta/p4deltaService.js')

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const DISCOVERY_SPEC = clientSpecReply(ROOT)
const ROOT_FWD = process.platform === 'win32' ? 'C:/ws' : '/ws'
const CONTENT = `${ROOT_FWD}/Content`
const P4DELTA_EXE = '/opt/p4delta'
const DISCOVERY = `... clientName testclient\n... clientRoot ${ROOT}\n... userName testuser\n\n`

type Reply = { stdout?: string; stderr?: string; exit?: number }

function subcommand(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-Mj' || a === '-ztag') continue
    if (a === '-p' || a === '-u' || a === '-c' || a === '-x') {
      i++
      continue
    }
    return a
  }
  return undefined
}

const spawned: string[][] = []
const heldChildren: FakeChildProcess[] = []

function respond(
  handler: (argv: string[]) => Reply,
  hold: (argv: string[]) => boolean = () => false,
): void {
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[1] as string[]) ?? []
    spawned.push(argv)
    const child = new FakeChildProcess()
    if (hold(argv)) {
      heldChildren.push(child)
      return child
    }
    queueMicrotask(() => {
      const reply = handler(argv)
      if (reply.stdout) child.stdout.emit('data', Buffer.from(reply.stdout))
      if (reply.stderr) child.stderr.emit('data', Buffer.from(reply.stderr))
      child.emit('close', reply.exit ?? 0)
    })
    return child
  })
}

/** Emit output on the oldest held spawn and close it, settling its caller. */
function finishHeld(reply: Reply = { stdout: '', exit: 0 }): void {
  const child = heldChildren.shift()
  expect(child).toBeDefined()
  if (reply.stdout) child!.stdout.emit('data', Buffer.from(reply.stdout))
  if (reply.stderr) child!.stderr.emit('data', Buffer.from(reply.stderr))
  child!.emit('close', reply.exit ?? 0)
}

function makeHandler(syncReply: (argv: string[]) => Reply): (argv: string[]) => Reply {
  return (argv) => {
    const cmd = subcommand(argv)
    if (isClientSpecProbe(argv)) return { stdout: DISCOVERY_SPEC }
    if (cmd === 'info') return { stdout: DISCOVERY }
    if (cmd === 'sync') return syncReply(argv)
    return { stdout: '' }
  }
}

const createdClients: PerforceClientInstance[] = []

async function makeClient(
  syncReply: (argv: string[]) => Reply = () => ({}),
  options: PerforceClientOptions = {},
  holdSync = false,
): Promise<PerforceClientInstance> {
  respond(
    makeHandler(syncReply),
    holdSync ? (argv) => subcommand(argv) === 'sync' && !argv.includes('-n') : undefined,
  )
  const client = await PerforceClient.create(
    ROOT,
    {},
    new ConcurrencyGate(4),
    { enabled: true, workspaceTtlMs: 4000 },
    options,
  )
  expect(client).toBeDefined()
  createdClients.push(client!)
  return client!
}

/** A controllable watcher fake: its events are what the disk-write counter counts. */
function makeFakeWatcher(): {
  watcher: FileSystemWatcher
  fire: (kind: 'create' | 'change' | 'delete', path: string) => void
} {
  const listeners = {
    create: new Set<(uri: { fsPath: string }) => void>(),
    change: new Set<(uri: { fsPath: string }) => void>(),
    delete: new Set<(uri: { fsPath: string }) => void>(),
  }
  const watcher = {
    ignoreCreateEvents: false,
    ignoreChangeEvents: false,
    ignoreDeleteEvents: false,
    onDidCreate: (fn: (uri: { fsPath: string }) => void) => {
      listeners.create.add(fn)
      return { dispose: () => listeners.create.delete(fn) }
    },
    onDidChange: (fn: (uri: { fsPath: string }) => void) => {
      listeners.change.add(fn)
      return { dispose: () => listeners.change.delete(fn) }
    },
    onDidDelete: (fn: (uri: { fsPath: string }) => void) => {
      listeners.delete.add(fn)
      return { dispose: () => listeners.delete.delete(fn) }
    },
    dispose: vi.fn(),
  }
  return {
    watcher: watcher as unknown as FileSystemWatcher,
    fire: (kind, path) => {
      for (const fn of [...listeners[kind]]) fn({ fsPath: path })
    },
  }
}

// --- the δ stub --------------------------------------------------------------

interface DeltaReply {
  records?: Record<string, unknown>[]
  log?: string[]
  code?: number
}

let syncDeltaReply: (argv: readonly string[]) => DeltaReply = () => ({})

/** A distinct run reference per stub call: the client must report the id of the
 *  attempt that actually ran, not a shared or last-write-wins value. */
let deltaRunSeq = 0

/** The pid a started δ run would have. Handed to the run's spawn hook, which is
 *  the evidence the client reads as "δ really started" — a stub that stayed
 *  silent would model a run that never spawned. */
const DELTA_PID = 9001

function stubP4deltaRun(): void {
  deltaRunSeq = 0
  vi.spyOn(P4deltaService.prototype, 'run').mockImplementation(async (args, options) => {
    const isGet = args.includes('--sync')
    const r: DeltaReply = isGet
      ? syncDeltaReply(args)
      : { records: [deltaSummary({ mode: 'open', applied: false, total: 0, counts: {} })] }
    const records = [...(r.records ?? [])] as never[]
    for (const record of records) options?.onRecord?.(record)
    if (isGet) options?.onSpawn?.(DELTA_PID)
    deltaRunSeq += 1
    return {
      code: r.code ?? 0,
      runId: `p4d-mock-${deltaRunSeq}-1-abcd1234`,
      startedAt: 1_700_000_000_000 + deltaRunSeq,
      records,
      progress: [],
      log: r.log ?? [],
      sawNonJsonStdout: false,
      sawSummary: records.some((rec) => (rec as { kind?: string }).kind === 'summary'),
      signal: null,
    } as never
  })
}

function deltaSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'summary',
    mode: 'sync',
    ok: true,
    applied: true,
    force: false,
    total: 1,
    counts: { update: 1 },
    conflicts: 0,
    // The real engine always states a final p4 command count on its summary;
    // a stub that omitted it would read as an incomplete (lower-bound) run.
    p4Calls: 0,
    scopeMatched: null,
    unmatched: 0,
    elapsedMs: 5,
    reason: null,
    ...overrides,
  }
}

function deltaFile(rel: string): Record<string, unknown> {
  return {
    kind: 'file',
    mode: 'sync',
    class: 'update',
    action: 'updating',
    nativeAction: 'updated',
    depotFile: `//depot/branch_x/${rel}`,
    clientFile: `//testclient/${rel}`,
    rev: '2',
    applied: true,
    stage: 'apply',
    force: false,
  }
}

/** A client whose session already routed its questions to δ (one whole-scope
 *  scan round answered by the engine) — δ only serves a get after that verdict. */
async function makeArmedClient(): Promise<PerforceClientInstance> {
  const client = await makeClient(() => ({}), {
    p4delta: { exe: P4DELTA_EXE },
    readScope: scopeFixture([CONTENT]),
  })
  await client.runReconcileScan()
  return client
}

beforeEach(() => {
  installBridge()
  spawnMock.mockReset()
  spawned.length = 0
  heldChildren.length = 0
  ioMock.probes.length = 0
  ioMock.available = true
  syncDeltaReply = () => ({})
  stubP4deltaRun()
  vi.clearAllMocks()
  mocks.executeCommand.mockResolvedValue(undefined)
})

afterEach(() => {
  for (const client of createdClients.splice(0)) client.dispose()
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
})

describe('SyncRunResult.facts', () => {
  it('reports the native engine, the parallel knob and no fallback', async () => {
    const client = await makeClient()
    client.setSyncParallelThreads(6)

    const res = await client.sync('#head')

    expect(res.facts?.engine).toBe('p4')
    expect(res.facts?.engineFallback).toBe(false)
    expect(res.facts?.parallelThreads).toBe(6)
    expect(res.facts?.startedAt).toBeLessThanOrEqual(res.facts!.endedAt)
    // The one p4 process this get started, counted from its spawn hook.
    expect(res.facts?.p4Calls).toEqual({ native: 1, p4delta: 0, complete: true })
  })

  it('carries the sampled byte totals out of a finished run', async () => {
    const client = await makeClient(
      () => ({ stdout: `//depot/branch_x/a.cpp#3 - updated as ${ROOT_FWD}/a.cpp` }),
      {},
      true,
    )
    const run = client.sync('#head', { onProgress: () => {} })
    await vi.waitFor(() => expect(ioMock.probes.length).toBe(1))
    const probe = ioMock.probes[0] as FakeIoProbe
    probe.sample(4096, 512)
    probe.sample(1024, 128)
    finishHeld({ stdout: `//depot/branch_x/a.cpp#3 - updated as ${ROOT_FWD}/a.cpp` })

    const res = await run

    // The regression this file exists for: these totals are zeroed by the sync
    // teardown, so an `io` that is non-empty here proves the snapshot ran first.
    expect(res.facts?.io).toEqual({ readBytes: 5120, writeBytes: 640 })
  })

  it('omits io when this machine has no sampler', async () => {
    ioMock.available = false
    const client = await makeClient()

    const res = await client.sync('#head')

    expect(res.facts?.engine).toBe('p4')
    expect(res.facts?.io).toBeUndefined()
  })

  it('omits io when the sampler existed but never reported', async () => {
    const client = await makeClient(() => ({}), {}, true)
    const run = client.sync('#head', { onProgress: () => {} })
    await vi.waitFor(() => expect(ioMock.probes.length).toBe(1))
    // No `sample()` call: a get that finished within one sampling tick.
    finishHeld()

    const res = await run

    // A 0 B reading here would claim the get moved nothing; "no sampler" is the
    // honest answer the history renders as unavailable.
    expect(res.facts?.io).toBeUndefined()
  })

  it('counts watcher activity as disk writes', async () => {
    const wt = makeFakeWatcher()
    const client = await makeClient(
      () => ({}),
      {
        watchRoot: ROOT,
        externalChangeDebounceMs: 0,
        createFileSystemWatcher: () => wt.watcher,
      },
      true,
    )
    const run = client.sync('#head', { onProgress: () => {} })
    await vi.waitFor(() => expect(heldChildren.length).toBe(1))
    wt.fire('change', `${ROOT_FWD}/a.cpp`)
    wt.fire('create', `${ROOT_FWD}/b.cpp`)
    finishHeld()

    const res = await run
    expect(res.facts?.diskWrites).toBe(2)
  })

  it('carries facts on a failed run too', async () => {
    const client = await makeClient(() => ({ stderr: 'clobber', exit: 1 }))

    const res = await client.sync('#head')

    expect(res.ok).toBe(false)
    expect(res.facts?.engine).toBe('p4')
    // Failure is still a call: the process started and made its round trip.
    expect(res.facts?.p4Calls).toEqual({ native: 1, p4delta: 0, complete: true })
  })

  it('counts the process a cancelled get did start', async () => {
    const client = await makeClient((argv) => {
      // Abort while the sync is in flight; the service resolves a failure
      // result whose stderr says it was cancelled.
      if (!argv.includes('-n')) client.cancelBusy()
      return { stdout: '', stderr: 'was cancelled', exit: 1 }
    })

    const res = await client.sync('#head')

    expect(res.cancelled).toBe(true)
    // The count stays exact: the process existed, so there is nothing unknown.
    expect(res.facts?.p4Calls).toEqual({ native: 1, p4delta: 0, complete: true })
  })

  it('keeps concurrent gets’ counts apart', async () => {
    // A client-global counter would bill the second get for the first one's
    // process (and for any background command in between); the per-run counter
    // must not.
    const client = await makeClient(() => ({}), {}, true)
    const first = client.sync('#head')
    await vi.waitFor(() => expect(heldChildren.length).toBe(1))
    const second = client.sync('#head')
    await vi.waitFor(() => expect(heldChildren.length).toBe(2))
    finishHeld()
    finishHeld()

    const [a, b] = await Promise.all([first, second])
    expect(a.facts?.p4Calls).toEqual({ native: 1, p4delta: 0, complete: true })
    expect(b.facts?.p4Calls).toEqual({ native: 1, p4delta: 0, complete: true })
  })

  it('leaves a get the editor refused undecorated, and carries the reason out', async () => {
    const client = await makeClient(() => ({}), {
      readScope: () => ({ kind: 'error', path: `${CONTENT}/.p4delta-scope`, reason: 'unreadable' }),
    })

    const res = await client.sync('#head')

    // `ok: false` alone would read as "p4 ran and failed", which is a fact about
    // a process that never existed; `notRun` is what tells the two apart, and
    // with no engine there are no facts to report — an `engine: 'p4'` here would
    // name a process that never started.
    expect(res.notRun).toBe(true)
    expect(res.ok).toBe(false)
    expect(res.facts).toBeUndefined()
    expect(res.summary).toBeUndefined()
    // The reason rides out in the field the history records, so the detail panel
    // can say WHY nothing ran.
    expect(res.error?.suggestion).toContain('not usable')
    expect(res.error?.kind).toBe('other')
    // Nothing was asked of p4 for the get itself (the scope read is local).
    expect(spawned.some((argv) => subcommand(argv) === 'sync')).toBe(false)
    expect(windowMock.showErrorMessage).toHaveBeenCalled()
  })

  it('reports δ as the engine when δ served the get', async () => {
    const client = await makeArmedClient()
    syncDeltaReply = () => ({ records: [deltaFile('Content/a.cpp'), deltaSummary()] })

    const res = await client.sync('#head')

    expect(res.ok).toBe(true)
    expect(res.summary?.applied).toBe(1)
    expect(res.facts?.engine).toBe('p4delta')
    expect(res.facts?.engineFallback).toBe(false)
  })

  it('reports δ’s own p4 command count, confirmed by its summary', async () => {
    const client = await makeArmedClient()
    syncDeltaReply = () => ({
      records: [
        { kind: 'p4CommandCount', count: 0 },
        deltaFile('Content/a.cpp'),
        { kind: 'p4CommandCount', count: 7 },
        deltaSummary({ p4Calls: 7 }),
      ],
    })

    const res = await client.sync('#head')

    // δ served this get itself, so the editor started no p4 process: the whole
    // count is the engine's own, and the summary confirms it final.
    expect(res.facts?.p4Calls).toEqual({ native: 0, p4delta: 7, complete: true })
  })

  it('accumulates δ’s observed calls and the native fallback, marking the δ side inexact', async () => {
    const client = await makeArmedClient()
    // δ starts, gets a few calls in, then dies without a summary: the get is
    // re-served natively. Both halves must survive — dropping the first would
    // report a cheaper run than happened.
    syncDeltaReply = () => ({ records: [{ kind: 'p4CommandCount', count: 3 }], code: 1 })

    const res = await client.sync('#head')

    expect(res.facts?.engine).toBe('p4')
    expect(res.facts?.engineFallback).toBe(true)
    expect(res.facts?.p4Calls).toEqual({ native: 1, p4delta: 3, complete: false })
  })

  it('flags the fallback when δ was tried and the run went to native p4', async () => {
    const client = await makeArmedClient()

    // `#4` is a per-file revision δ cannot express — rejected before any δ call,
    // so the same invocation is served natively.
    const res = await client.sync('#4')

    expect(res.facts?.engine).toBe('p4')
    expect(res.facts?.engineFallback).toBe(true)
    // δ never started, so there is no δ side to be missing: the native count is
    // exact and complete, not an unknown.
    expect(res.facts?.p4Calls).toEqual({ native: 1, p4delta: 0, complete: true })
  })

  it('does not flag a fallback when the engine was never on the table', async () => {
    // No `p4delta` option and no armed scan: δ is not configured at all, which
    // is not the same statement as "δ was tried and refused".
    const client = await makeClient()

    const res = await client.sync('#head')

    expect(res.facts?.engine).toBe('p4')
    expect(res.facts?.engineFallback).toBe(false)
  })

  it('carries the δ log reference of the run that served the get', async () => {
    const client = await makeArmedClient()
    syncDeltaReply = () => ({ records: [deltaFile('Content/a.cpp'), deltaSummary()] })

    const res = await client.sync('#head')

    // The reference is the attempt's own, minted when δ started — it is what
    // "open this run's log" resolves against.
    expect(res.facts?.deltaRunId).toMatch(/^p4d-mock-\d+-1-abcd1234$/)
  })

  it('keeps the δ log reference when δ died and the get was re-served natively', async () => {
    const client = await makeArmedClient()
    // δ started, did work, then died without a summary. There is no second δ
    // run — but there IS a log, and the record must still point at it.
    syncDeltaReply = () => ({ records: [{ kind: 'p4CommandCount', count: 3 }], code: 1 })

    const res = await client.sync('#head')

    expect(res.facts?.engine).toBe('p4')
    expect(res.facts?.engineFallback).toBe(true)
    expect(res.facts?.deltaRunId).toMatch(/^p4d-mock-\d+-1-abcd1234$/)
  })

  it('carries no δ log reference when δ never ran', async () => {
    const client = await makeClient()

    const res = await client.sync('#head')

    // A pure native get has no δ log; claiming one would point the detail panel
    // at another run's file.
    expect(res.facts?.deltaRunId).toBeUndefined()
  })

  it('carries δ’s per-command classification out of the run', async () => {
    const client = await makeArmedClient()
    syncDeltaReply = () => ({
      records: [
        { kind: 'p4CommandCount', count: 1, command: 'set' },
        { kind: 'p4CommandCount', count: 2, command: 'fstat' },
        deltaFile('Content/a.cpp'),
        deltaSummary({ p4Calls: 2, p4CallsByCommand: { set: 1, fstat: 1 } }),
      ],
    })

    const res = await client.sync('#head')

    expect(res.facts?.p4Calls).toEqual({
      native: 0,
      p4delta: 2,
      complete: true,
      p4deltaByCommand: { set: 1, fstat: 1 },
      p4deltaByCommandComplete: true,
    })
  })

  it('keeps the event stream’s classification as a lower bound when δ died', async () => {
    const client = await makeArmedClient()
    syncDeltaReply = () => ({
      records: [
        { kind: 'p4CommandCount', count: 1, command: 'set' },
        { kind: 'p4CommandCount', count: 2, command: 'have' },
      ],
      code: 1,
    })

    const res = await client.sync('#head')

    // No summary, so both halves are lower bounds — and the classification still
    // answers "these two calls were a set and a have".
    expect(res.facts?.p4Calls).toEqual({
      native: 1,
      p4delta: 2,
      complete: false,
      p4deltaByCommand: { set: 1, have: 1 },
      p4deltaByCommandComplete: false,
    })
  })
})
