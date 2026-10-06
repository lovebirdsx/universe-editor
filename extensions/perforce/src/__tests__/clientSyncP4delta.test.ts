/**
 * `PerforceClient.sync` on the δ engine (`perforce.p4delta.*`): which gets δ may
 * serve, the argv it is handed, how its records become the same `SyncRunResult`
 * the native path produces, and the failure split — a run that never reached its
 * apply phase is re-served on p4 in the same call, one that did is reported
 * as-is. This locks in:
 *  1. An eligible get runs ONE δ call (`--sync -a -- <entries>`) and no `p4
 *     sync` at all; `@<CL>` becomes `--to`, `#head` adds nothing.
 *  2. Everything δ cannot express stays native: `#4`, `@<date>`, per-file force,
 *     the whole-client scope, a filespec metacharacter, and any force get.
 *  3. Records → summary: applied classes become rows, one `resolve` record feeds
 *     both keptOpen and mustResolve, refusals are read back from the engine log.
 *  4. Failures before the apply phase fall back to p4 in the same call and do
 *     NOT count toward the ladder; failures after it are reported, never
 *     retried (the transfer may already have landed) and do count.
 *  5. Cancel, progress callbacks and the drift subtraction all follow the native
 *     path's rules.
 *
 * The engine seam is `P4deltaService.prototype.run`, as in
 * `clientReconcileScan.test.ts`: the client builds a real service around the exe
 * it was handed, so the stub replaces only the process spawn and the argv the
 * client built is what these tests assert on. A get also needs the session
 * verdict only a scan round can give (`_reconcileScanEngine`), so the stub
 * answers the arming scan too and `makeArmedClient` runs one.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PerforceClientOptions } from '../client.js'
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

/** The sync I/O sampler, faked: the real one spawns a platform process (WMI
 *  poller / `/proc` reader), which a unit test has no business doing. Returning
 *  undefined is the "no usable source on this machine" answer, which the client
 *  handles by counting watcher events instead — the pids it was offered are what
 *  these tests observe. */
const ioMock = vi.hoisted(() => ({ pids: [] as number[] }))
vi.mock('../processIo.js', () => ({
  createP4IoProbe: (pid: number) => {
    ioMock.pids.push(pid)
    return undefined
  },
}))

const mocks = vi.hoisted(() => ({ executeCommand: vi.fn(), showMessage: vi.fn() }))

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
const { P4deltaService } = await import('../p4deltaService.js')
type P4deltaRecord = import('../p4deltaService.js').P4deltaRecord
type P4deltaRunResult = import('../p4deltaService.js').P4deltaRunResult

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const ROOT_FWD = process.platform === 'win32' ? 'C:/ws' : '/ws'
const CLIENT = 'testclient'

/** The exe the client is handed. The service around it is real; only its
 *  `run` is stubbed, so the argv under test is the one the client built. */
const P4DELTA_EXE = '/opt/p4delta'

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

/** Every p4 argv the client spawned, for asserting what actually ran. */
const spawned: string[][] = []

function respond(handler: (argv: string[]) => Reply): void {
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[1] as string[]) ?? []
    spawned.push(argv)
    const child = new FakeChildProcess()
    queueMicrotask(() => {
      const reply = handler(argv)
      if (reply.stdout) child.stdout.emit('data', Buffer.from(reply.stdout))
      if (reply.stderr) child.stderr.emit('data', Buffer.from(reply.stderr))
      child.emit('close', reply.exit ?? 0)
    })
    return child
  })
}

const DISCOVERY = `... clientName ${CLIENT}\n... clientRoot ${ROOT}\n... userName testuser\n\n`

/** Discovery plus the get every test is about; everything else reads empty. */
function p4Handler(argv: string[]): Reply {
  const cmd = subcommand(argv)
  if (cmd === 'info') return { stdout: DISCOVERY }
  if (cmd === 'sync')
    return { stdout: `//depot/branch_x/native.cpp#9 - updated as ${ROOT_FWD}/native.cpp` }
  return { stdout: '' }
}

/** The argv of every real `p4 sync` (never the `-n` dry run), with the global
 *  connection options stripped so assertions read as the command. */
function nativeSyncCalls(): string[][] {
  return spawned
    .filter((a) => subcommand(a) === 'sync' && !a.includes('-n'))
    .map((a) => a.slice(a.indexOf('sync')))
}

// --- the δ stub --------------------------------------------------------------

/** δ argv per stubbed run, in call order. */
const p4deltaCalls: string[][] = []

/** The run options per stubbed run — how a test observes (and drives) the
 *  progress and pid callbacks a get forwards to the engine. */
const p4deltaOptions: Array<import('../p4deltaService.js').P4deltaRunOptions | undefined> = []

interface DeltaReply {
  records?: P4deltaRecord[]
  progress?: P4deltaRecord[]
  log?: string[]
  code?: number
  sawNonJsonStdout?: boolean
  /** The run stays in flight until this resolves — for observing progress
   *  mid-run or cancelling it. */
  hold?: Promise<void>
}

let deltaRunSpy: { mockRestore: () => void } | undefined
/** The reply for the current test's get runs. */
let syncReply: (argv: readonly string[]) => DeltaReply = () => ({})
/** The reply for the arming (and any later) scan rounds — a clean whole-scope
 *  answer unless a test wants drift to start from. */
let scanReply: (argv: readonly string[]) => DeltaReply = () => ({
  records: [deltaSummary({ mode: 'open', applied: false, total: 0, counts: {} })],
})

/** Stub the engine. A run whose argv carries `--sync` is a get and gets the
 *  test's reply; any other run is a scan round. The result is assembled the way
 *  the service assembles it (`sawSummary` from the records), so "no summary" is
 *  expressed by leaving the summary record out. */
function stubP4deltaRun(): void {
  deltaRunSpy = vi
    .spyOn(P4deltaService.prototype, 'run')
    .mockImplementation(async (args, options) => {
      const argv = [...args]
      p4deltaCalls.push(argv)
      p4deltaOptions.push(options)
      const r: DeltaReply = argv.includes('--sync') ? syncReply(argv) : scanReply(argv)
      if (r.hold) await r.hold
      const records = r.records ?? []
      // The real service hands each record to the caller as its line arrives;
      // replaying them here is what lets a test observe the progress a get
      // publishes mid-run.
      for (const record of records) options?.onRecord?.(record)
      return {
        code: r.code ?? 0,
        records,
        progress: r.progress ?? [],
        log: r.log ?? [],
        sawNonJsonStdout: r.sawNonJsonStdout ?? false,
        sawSummary: records.some((rec) => rec['kind'] === 'summary'),
        signal: null,
      } satisfies P4deltaRunResult
    })
}

/** The δ argv of the get runs only (the arming scan is not a get). */
function getCalls(): string[][] {
  return p4deltaCalls.filter((a) => a.includes('--sync'))
}

/** One δ `kind:"file"` record of a sync run, in the contract's shape. */
function deltaFile(rel: string, overrides: Record<string, unknown> = {}): P4deltaRecord {
  const klass = (overrides['class'] as string | undefined) ?? 'update'
  return {
    kind: 'file',
    mode: 'sync',
    class: klass,
    action: classAction(klass),
    nativeAction: nativeActionFor(klass),
    depotFile: `//depot/branch_x/${rel}`,
    clientFile: `//${CLIENT}/${rel}`,
    rev: '2',
    applied: true,
    stage: 'apply',
    force: false,
    ...overrides,
  }
}

function classAction(klass: string): string {
  if (klass === 'add') return 'adding'
  if (klass === 'delete') return 'deleting'
  if (klass === 'resolve') return 'scheduling'
  return 'updating'
}

function nativeActionFor(klass: string): string | undefined {
  if (klass === 'add') return 'added'
  if (klass === 'delete') return 'deleted'
  if (klass === 'resolve') return undefined
  return 'updated'
}

function deltaSummary(overrides: Record<string, unknown> = {}): P4deltaRecord {
  return {
    kind: 'summary',
    mode: 'sync',
    ok: true,
    applied: true,
    force: false,
    total: 1,
    counts: { update: 1 },
    scopeMatched: null,
    unmatched: 0,
    elapsedMs: 5,
    reason: null,
    ...overrides,
  }
}

// --- client construction -----------------------------------------------------

const createdClients: PerforceClientInstance[] = []

async function makeClient(options: PerforceClientOptions = {}): Promise<PerforceClientInstance> {
  respond(p4Handler)
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

/** A client whose session has already routed its questions to δ the way
 *  production does: one whole-scope scan round answered by the engine. The get
 *  is served by δ only after that verdict, so every test starts here. */
async function makeArmedClient(
  options: PerforceClientOptions = { p4delta: { exe: P4DELTA_EXE } },
): Promise<PerforceClientInstance> {
  const client = await makeClient(options)
  await client.runReconcileScan()
  return client
}

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  installBridge()
  spawnMock.mockReset()
  spawned.length = 0
  p4deltaCalls.length = 0
  p4deltaOptions.length = 0
  ioMock.pids.length = 0
  syncReply = () => ({})
  scanReply = () => ({
    records: [deltaSummary({ mode: 'open', applied: false, total: 0, counts: {} })],
  })
  stubP4deltaRun()
  vi.clearAllMocks()
  mocks.executeCommand.mockResolvedValue(undefined)
})

afterEach(() => {
  for (const client of createdClients) client.dispose()
  createdClients.length = 0
  deltaRunSpy?.mockRestore()
  deltaRunSpy = undefined
  delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
})

describe('PerforceClient.sync — δ engine', () => {
  it('serves an eligible get from δ, with the contract argv and no p4 sync', async () => {
    const client = await makeArmedClient()
    client.setSyncScope([`${ROOT_FWD}/Content`])
    syncReply = () => ({ records: [deltaFile('Content/a.cpp'), deltaSummary()] })

    const res = await client.sync('#head')

    expect(getCalls()).toEqual([
      [
        '--json',
        '--no-scope-file',
        '--client-root',
        ROOT,
        '--sync',
        '-a',
        '--',
        `${ROOT_FWD}/Content/...`,
      ],
    ])
    // The whole point of the engine swap: not one `p4 sync` for this get.
    expect(nativeSyncCalls()).toEqual([])
    expect(res.ok).toBe(true)
    expect(res.cancelled).toBe(false)
    expect(res.summary).toEqual({
      applied: 1,
      keptOpen: 0,
      mustResolve: 0,
      refusedModified: 0,
      refusedOverwrite: 0,
      upToDate: false,
      unrecognized: false,
    })
    expect(res.refusedFiles).toEqual([])
    expect(res.error).toBeUndefined()
  })

  it('keeps the get on p4 until a scan round has proved the engine', async () => {
    // "An engine is configured" is not the verdict a get follows: only a scan
    // round that came back from δ proves it can answer this workspace, and until
    // that round happens the get stays native like every other question.
    const client = await makeClient({ p4delta: { exe: P4DELTA_EXE } })
    client.setSyncScope([`${ROOT_FWD}/Content`])

    const res = await client.sync('#head')

    expect(getCalls()).toEqual([])
    expect(nativeSyncCalls()).toHaveLength(1)
    expect(res.ok).toBe(true)
  })

  it('carries a changelist target as --to', async () => {
    const client = await makeArmedClient()
    client.setSyncScope([`${ROOT_FWD}/Content`])

    await client.sync('@4521')

    expect(getCalls()[0]).toEqual([
      '--json',
      '--no-scope-file',
      '--client-root',
      ROOT,
      '--sync',
      '--to',
      '4521',
      '-a',
      '--',
      `${ROOT_FWD}/Content/...`,
    ])
  })

  it('passes a filespec scope through verbatim, without escaping it', async () => {
    const client = await makeArmedClient()
    // A depot-syntax scope (the graph's / the timeline's), handed in as the
    // per-call scope. δ reads entries literally, so a `%`-escaped spelling would
    // name a file nobody has.
    await client.sync('#head', { scope: ['//depot/branch_x/...'] })

    expect(getCalls()[0]?.slice(-1)).toEqual(['//depot/branch_x/...'])
  })

  it('stays on p4 for a revision spec δ cannot express', async () => {
    const client = await makeArmedClient()
    client.setSyncScope([`${ROOT_FWD}/Content`])

    for (const spec of ['#4', '@2026/08/01', '']) {
      await client.sync(spec)
    }

    expect(getCalls()).toEqual([])
    expect(nativeSyncCalls().map((a) => a.at(-1))).toEqual([
      `${ROOT_FWD}/Content/...#4`,
      `${ROOT_FWD}/Content/...@2026/08/01`,
      `${ROOT_FWD}/Content/...`,
    ])
  })

  it('stays on p4 for a scope δ cannot read', async () => {
    const client = await makeArmedClient()
    client.setSyncScope([`${ROOT_FWD}/con@tent`])
    await client.sync('#head')
    // Escaped-for-p4 spelling is what the native argv carries; the metacharacter
    // is exactly why the engine is not asked.
    expect(getCalls()).toEqual([])
    expect(nativeSyncCalls()).toHaveLength(1)
  })

  it('stays on p4 for the whole-client scope', async () => {
    const client = await makeArmedClient()
    // The default before any focus folder is set: δ's entries are local paths
    // or `//<depot>/...` subtrees, and `//...` is neither.
    expect(client.syncScopes).toEqual(['//...'])

    await client.sync('#head')

    expect(getCalls()).toEqual([])
    expect(nativeSyncCalls()).toHaveLength(1)
  })

  it('stays on p4 for a force get, whose spec δ cannot read', async () => {
    const client = await makeArmedClient()
    client.setSyncScope([`${ROOT_FWD}/Content`])

    await client.sync('#head', { force: true })

    expect(getCalls()).toEqual([])
    expect(nativeSyncCalls()[0]).toContain('-f')
  })

  it('maps refusals, opened files and applied rows out of the engine run', async () => {
    const client = await makeArmedClient()
    client.setSyncScope([`${ROOT_FWD}/Content`])
    syncReply = () => ({
      records: [
        deltaFile('Content/a.cpp'),
        deltaFile('Content/open.cpp', { class: 'resolve' }),
        deltaSummary({ total: 2, counts: { update: 1, resolve: 1 } }),
      ],
      log: [
        `//depot/branch_x/Content/mod.cpp#3 - can't update modified file ${ROOT_FWD}/Content/mod.cpp`,
        `//depot/branch_x/Content/orphan.cpp#7 - can't overwrite existing file ${ROOT_FWD}/Content/orphan.cpp`,
      ],
    })

    const res = await client.sync('#head')

    expect(res.summary).toMatchObject({
      applied: 1,
      // One `resolve` record is both: p4 prints the "is opened" skip and the
      // "must resolve" warning for the same file.
      keptOpen: 1,
      mustResolve: 1,
      refusedModified: 1,
      refusedOverwrite: 1,
      upToDate: false,
      unrecognized: false,
    })
    expect(res.refusedFiles.map((f) => f.clientFile)).toEqual([`${ROOT_FWD}/Content/mod.cpp`])
    expect(res.refusedOverwriteFiles.map((f) => f.clientFile)).toEqual([
      `${ROOT_FWD}/Content/orphan.cpp`,
    ])
  })

  it('reports an up-to-date run without refreshing', async () => {
    const client = await makeArmedClient()
    client.setSyncScope([`${ROOT_FWD}/Content`])
    syncReply = () => ({ records: [deltaSummary({ total: 0, counts: {} })] })

    const res = await client.sync('#head')

    expect(res.ok).toBe(true)
    expect(res.summary?.upToDate).toBe(true)
    // Nothing landed, so there is nothing to refresh — the native path's
    // up-to-date early return, kept.
    expect(spawned.some((a) => subcommand(a) === 'opened')).toBe(false)
  })

  // The one failure shape that provably wrote nothing: the run never reached its
  // apply phase, so re-serving the get on p4 in the same call is free.
  it('re-runs an unconcluded get on p4 in the same call, without counting a failure', async () => {
    const client = await makeArmedClient()
    client.setSyncScope([`${ROOT_FWD}/Content`])
    syncReply = () => ({ code: 1, log: ['boom'] })

    const res = await client.sync('#head')

    expect(getCalls()).toHaveLength(1)
    expect(nativeSyncCalls()).toHaveLength(1)
    expect(res.ok).toBe(true)
    expect(res.summary?.applied).toBe(1)
    expect(client.p4deltaFallbackState).toEqual({ failures: 0, disarmed: false })
    // The fallback exit releases the bar too: the native run that serves the get
    // seeds its own zero frame, which would otherwise inherit the aborted δ
    // run's counts.
    expect(client.status.syncProgress).toBeUndefined()
  })

  // Past that point `-a` means part of the transfer may already have landed, and
  // re-running the scope under a second implementation is a different operation,
  // not a retry.
  it('reports a failure after the apply phase instead of retrying it, and counts it', async () => {
    const client = await makeArmedClient()
    client.setSyncScope([`${ROOT_FWD}/Content`])
    syncReply = () => ({
      code: 1,
      records: [deltaFile('Content/a.cpp'), { kind: 'error', message: 'connection dropped' }],
      log: ['   Applying the transfer with p4.', 'connection dropped'],
    })

    const res = await client.sync('#head')

    expect(getCalls()).toHaveLength(1)
    expect(nativeSyncCalls()).toEqual([])
    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(false)
    expect(res.summary).toBeUndefined()
    expect(client.p4deltaFallbackState).toEqual({ failures: 1, disarmed: false })
  })

  it('classifies a clobber abort from the engine, keeping the force-get remedy', async () => {
    const client = await makeArmedClient()
    client.setSyncScope([`${ROOT_FWD}/Content`])
    syncReply = () => ({
      code: 1,
      // The phase record is the engine's own announcement that the apply phase
      // began — what makes this failure past the point of no retry.
      progress: [{ kind: 'progress', phase: 'apply' }],
      records: [
        { kind: 'error', message: `Can't clobber writable file ${ROOT_FWD}/Content/a.cpp` },
      ],
    })

    const res = await client.sync('#head')

    expect(res.ok).toBe(false)
    expect(res.error?.kind).toBe('clobber')
  })

  it('drives the progress callback and the io sampler from the record stream', async () => {
    const client = await makeArmedClient()
    client.setSyncScope([`${ROOT_FWD}/Content`])
    const progress: Array<{ done: number; file: string | undefined }> = []
    syncReply = (argv) => {
      void argv
      return {
        records: [
          deltaFile('Content/a.cpp'),
          deltaFile('Content/b.cpp'),
          deltaFile('Content/open.cpp', { class: 'resolve' }),
          deltaSummary({ total: 3, counts: { update: 2, resolve: 1 } }),
        ],
      }
    }

    await client.sync('#head', { onProgress: (p) => progress.push(p) })

    expect(progress).toEqual([
      { done: 1, file: 'a.cpp' },
      { done: 2, file: 'b.cpp' },
      { done: 3, file: 'open.cpp' },
    ])
    // The status bar samples the engine's own process tree (its p4 children hang
    // off it), so the pid δ spawned is what gets handed to the sampler.
    const onSpawn = p4deltaOptions.find((o) => o?.onSpawn !== undefined)?.onSpawn
    expect(onSpawn).toBeTypeOf('function')
    onSpawn?.(1234)
    expect(ioMock.pids).toEqual([1234])
  })

  it('notes an inapplicable syncParallelThreads once per value, not once per get', async () => {
    const lines: string[] = []
    const client = await makeArmedClient({
      p4delta: { exe: P4DELTA_EXE },
      log: (msg) => lines.push(msg),
    })
    client.setSyncScope([`${ROOT_FWD}/Content`])
    // The setting's default is 4, so "once per get" would be every get.
    client.setSyncParallelThreads(8)
    syncReply = () => ({ records: [deltaFile('Content/a.cpp'), deltaSummary()] })

    await client.sync('#head')
    await client.sync('#head')

    expect(lines.filter((l) => l.includes('syncParallelThreads=8'))).toHaveLength(1)
  })

  it('clears the progress count when the get is done', async () => {
    const client = await makeArmedClient()
    client.setSyncScope([`${ROOT_FWD}/Content`])
    syncReply = () => ({
      records: [
        deltaFile('Content/a.cpp'),
        deltaFile('Content/b.cpp'),
        deltaSummary({ total: 2, counts: { update: 2 } }),
      ],
    })

    await client.sync('#head', { onProgress: () => {} })

    // The same invariant the native path is held to: a count that survives its
    // run is not cosmetic — the bar keeps its 1s heartbeat armed, the next run
    // inherits this run's `startedAt` (elapsed counts from the wrong origin), and
    // every later busy operation renders THIS run's count under its own label.
    expect(client.status.syncProgress).toBeUndefined()
  })

  it('subtracts the applied rows from the drift set, keeping everything else', async () => {
    const client = await makeClient({ p4delta: { exe: P4DELTA_EXE } })
    // The scan found two drifted files; the get then applies one of them.
    scanReply = () => ({
      records: [
        deltaFile('Content/a.cpp', { class: 'edit', action: 'edit', mode: 'open' }),
        deltaFile('Content/b.cpp', { class: 'edit', action: 'edit', mode: 'open' }),
        deltaSummary({ mode: 'open', applied: false, total: 2, counts: { edit: 2 } }),
      ],
    })
    await client.runReconcileScan()
    client.setSyncScope([`${ROOT_FWD}/Content`])
    // The set is keyed by `scopeKey` (folded), so the rows are read by path.
    const drifted = (): Array<string | undefined> =>
      [...client.scanDrift.values()].map((row) => row.clientFile).sort()
    expect(drifted()).toEqual([`${ROOT_FWD}/Content/a.cpp`, `${ROOT_FWD}/Content/b.cpp`])
    syncReply = () => ({ records: [deltaFile('Content/a.cpp'), deltaSummary()] })

    await client.sync('#head')

    // Only the file the engine reported as applied loses its row: b.cpp was left
    // alone and still carries the drift the user has to collect.
    expect(drifted()).toEqual([`${ROOT_FWD}/Content/b.cpp`])
  })

  it('reports a user cancel as cancelled, after subtracting what already landed', async () => {
    const client = await makeArmedClient()
    client.setSyncScope([`${ROOT_FWD}/Content`])
    let release: () => void = () => {}
    const held = new Promise<void>((r) => (release = r))
    syncReply = () => ({ code: 1, records: [deltaFile('Content/a.cpp')], hold: held })

    const pending = client.sync('#head')
    await flush()
    expect(getCalls()).toHaveLength(1)
    client.cancelBusy()
    release()
    const res = await pending

    expect(res.cancelled).toBe(true)
    expect(res.ok).toBe(false)
    expect(res.summary).toBeUndefined()
    // A cancel is not an engine failure: the user asked for it.
    expect(client.p4deltaFallbackState).toEqual({ failures: 0, disarmed: false })
    // …and the bar is released on this exit too — a cancelled run is exactly the
    // one that would otherwise leave its count standing.
    expect(client.status.syncProgress).toBeUndefined()
  })
})

describe('PerforceClient.previewSync — δ engine', () => {
  it('answers from the engine without -a, folding refusals in', async () => {
    const client = await makeArmedClient()
    client.setSyncScope([`${ROOT_FWD}/Content`])
    syncReply = () => ({
      records: [
        deltaFile('Content/a.cpp', { stage: 'preview', applied: false }),
        deltaSummary({ applied: false, total: 1 }),
      ],
      log: [
        `//depot/branch_x/Content/mod.cpp#3 - can't update modified file ${ROOT_FWD}/Content/mod.cpp`,
      ],
    })

    const res = await client.previewSync()

    expect(getCalls()[0]).toEqual([
      '--json',
      '--no-scope-file',
      '--client-root',
      ROOT,
      '--sync',
      '--',
      `${ROOT_FWD}/Content/...`,
    ])
    expect(res.ok).toBe(true)
    expect(res.files.map((f) => f.clientFile)).toEqual([
      `${ROOT_FWD}/Content/a.cpp`,
      `${ROOT_FWD}/Content/mod.cpp`,
    ])
    expect(res.upToDate).toBe(false)
  })

  it('falls back to p4 for a bounded preview, which -m cannot express', async () => {
    const client = await makeArmedClient()
    client.setSyncScope([`${ROOT_FWD}/Content`])

    await client.previewSync(undefined, '#head', 50)

    expect(getCalls()).toEqual([])
    expect(spawned.some((a) => a.includes('-n') && a.includes('-m'))).toBe(true)
  })

  it('falls back to p4 when the engine does not answer a read-only preview', async () => {
    const client = await makeArmedClient()
    client.setSyncScope([`${ROOT_FWD}/Content`])
    syncReply = () => ({ code: 2, sawNonJsonStdout: true })

    const res = await client.previewSync()

    expect(getCalls()).toHaveLength(1)
    expect(res.ok).toBe(true)
    // Nothing was written, so a failed preview costs nothing but the round trip.
    expect(client.p4deltaFallbackState).toEqual({ failures: 0, disarmed: false })
  })
})
