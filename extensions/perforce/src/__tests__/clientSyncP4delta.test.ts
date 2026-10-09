/**
 * `PerforceClient.sync` on the δ engine (`perforce.p4delta.*`): which gets δ may
 * serve, the argv it is handed, how its records become the same `SyncRunResult`
 * the native path produces, and the failure split — a run that never reached its
 * apply phase is re-served on p4 in the same call, one that did is reported
 * as-is. This locks in:
 *  1. An eligible get runs ONE δ call (`--sync -a <targets>`) and no `p4 sync`
 *     at all; `@<CL>` becomes `--to`, `#head` adds nothing, and the range
 *     travels as ordinary argv — the opened workspace as a hard upper bound,
 *     with the engine applying the scope it reads at its own startup.
 *  2. Everything δ cannot express stays native: `#4`, `@<date>`, per-file force,
 *     the whole-client scope (a depot spelling). A path holding a p4
 *     metacharacter is NOT one of them: δ reads raw local paths, so such a
 *     target is handed over like any other. δ 能读的范围上的强制拉取也交给 δ
 *     （`--sync --force`），其类表、缺 apply 阶段与失败安全见文末的 force 用例。
 *  3. Records → summary: applied classes become rows, one `resolve` record feeds
 *     both keptOpen and mustResolve, and refusals are read back from the engine
 *     log.
 *  4. Failures before the apply phase fall back to p4 in the same call and do
 *     NOT count toward the ladder; failures after it are reported, never
 *     retried (the transfer may already have landed) and do count.
 *     强制拉取没有 apply 阶段可判断、且可能先把文件交给原生 p4，所以永不重跑、失败一律上报并计数。
 *  5. Cancel, progress callbacks and the drift subtraction all follow the native
 *     path's rules.
 *
 * The engine seam is `P4deltaService.prototype.run`, as in
 * `clientReconcileScan.test.ts`: the client builds a real service around the exe
 * it was handed, so the stub replaces only the process spawn and the argv the
 * client built is what these tests assert on. A get also needs the session
 * verdict only a scan round can give (`_reconcileScanEngine`), so the stub
 * answers the arming scan too and `makeArmedClient` runs one.
 *
 * A get's range is no longer set on the client (`setSyncScope` is gone): what
 * the editor hands over is the caller's typed targets, or the opened workspace
 * as a hard upper bound, and the daily scope the engine applies is the one IT
 * reads when its process starts. A get therefore carries no scope of its own to
 * assert on — only the targets in its argv, which is why the config a client
 * read is injected here as a `scopeFixture` (the range the editor side of the
 * run reasons about) while the engine side is out of this file's sight.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PerforceClientOptions } from '../client.js'
import { NO_SCOPE_CONFIG, scopeFixture } from './scopeFixture.js'
import { clientSpecReply, isClientSpecProbe } from './discoveryProbe.js'
type PerforceClientInstance = import('../client.js').PerforceClient
type ScopeRead = import('./scopeFixture.js').ScopeRead

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
const DISCOVERY_SPEC = clientSpecReply(ROOT)
const ROOT_FWD = process.platform === 'win32' ? 'C:/ws' : '/ws'
const CLIENT = 'testclient'

/** The daily scope's one include, in the client's own spelling: the Content
 *  folder of the client root — the range the tests used to hand the get
 *  directly (`setSyncScope`), now resolved as a scope and injected. */
const CONTENT = `${ROOT_FWD}/Content`

/** The config a client resolves for a test: Content, under the client root. */
function contentScope(): ScopeRead {
  return scopeFixture([CONTENT])
}

/** The same config after it narrowed its include. */
function narrowedScope(): ScopeRead {
  return scopeFixture([`${CONTENT}/sub`])
}

/** …and after it added an exclusion (the include list does not move at all). */
function excludedScope(): ScopeRead {
  return scopeFixture([CONTENT], [`${CONTENT}/gen`])
}

/** …and after it WIDENED: the range now covers more than the preview listed. */
function widenedScope(): ScopeRead {
  return scopeFixture([CONTENT, `${ROOT_FWD}/Tools`])
}

/** A folder with no config file at all — the whole opened workspace. */
const NO_CONFIG: ScopeRead = () => NO_SCOPE_CONFIG

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
  if (isClientSpecProbe(argv)) return { stdout: DISCOVERY_SPEC }
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
      const isGet = argv.includes('--sync')
      const r: DeltaReply = isGet ? syncReply(argv) : scanReply(argv)
      if (r.hold) await r.hold
      const records = [...(r.records ?? [])]
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

/** The indices of the get runs (the arming scan is not a get). */
function getIndexes(): number[] {
  return p4deltaCalls.map((argv, i) => (argv.includes('--sync') ? i : -1)).filter((i) => i >= 0)
}

/** The δ argv of the get runs only. */
function getCalls(): string[][] {
  return getIndexes().map((i) => p4deltaCalls[i]!)
}

/** The targets a δ get was handed — its argv tail, after the switches the
 *  contract fixes. One argv per target, raw local paths, no scope tail. */
function deltaTargets(argv: readonly string[]): string[] {
  let i = 0
  const skip = (flag: string): void => {
    if (argv[i] === flag) i += 1
  }
  skip('--json')
  if (argv[i] === '--client-root') i += 2
  skip('--sync')
  if (argv[i] === '--to') i += 2
  skip('-a')
  skip('--no-scope-file')
  return [...argv.slice(i)]
}

/** What every δ get ran over, in call order. */
function getTargets(): string[][] {
  return getCalls().map(deltaTargets)
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

/** 强制修复档的一条 `kind:"file"` 记录：同样是 `mode:"sync"`，用修复档自己的类表
 *  （`update` / `revert` / `restore` / `delete`），且没有 `stage` / `nativeAction`。 */
function deltaForceFile(rel: string, overrides: Record<string, unknown> = {}): P4deltaRecord {
  const klass = (overrides['class'] as string | undefined) ?? 'update'
  const action =
    klass === 'revert'
      ? 'reverting'
      : klass === 'restore'
        ? 'restoring'
        : klass === 'delete'
          ? 'deleting'
          : klass === 'handoff'
            ? 'sync'
            : 'updating'
  return {
    kind: 'file',
    mode: 'sync',
    class: klass,
    action,
    depotFile: `//depot/branch_x/${rel}`,
    clientFile: `//${CLIENT}/${rel}`,
    rev: '2',
    applied: true,
    force: true,
    ...overrides,
  }
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

async function makeClient(
  options: PerforceClientOptions = {},
  readScope: ScopeRead = scopeFixture([CONTENT]),
): Promise<PerforceClientInstance> {
  respond(p4Handler)
  const client = await PerforceClient.create(
    ROOT,
    {},
    new ConcurrencyGate(4),
    { enabled: true, workspaceTtlMs: 4000 },
    { readScope, ...options },
  )
  expect(client).toBeDefined()
  createdClients.push(client!)
  return client!
}

/** A client whose injected config can be swapped mid-flight — an edit landing
 *  between a preview and the get that applies it. */
async function makeSwappableClient(
  initial: ScopeRead,
): Promise<{ client: PerforceClientInstance; setScope: (next: ScopeRead) => void }> {
  let current = initial
  const client = await makeArmedClient({}, (root) => current(root))
  return {
    client,
    setScope: (next) => {
      current = next
    },
  }
}

/** A client whose session has already routed its questions to δ the way
 *  production does: one whole-scope scan round answered by the engine. The get
 *  is served by δ only after that verdict, so every test starts here. */
async function makeArmedClient(
  options: PerforceClientOptions = {},
  readScope: ScopeRead = scopeFixture([CONTENT]),
): Promise<PerforceClientInstance> {
  const client = await makeClient({ p4delta: { exe: P4DELTA_EXE }, ...options }, readScope)
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
    syncReply = () => ({ records: [deltaFile('Content/a.cpp'), deltaSummary()] })

    const res = await client.sync('#head')

    // One δ call, plain argv: no `--no-scope-file` (that flag belongs to the
    // explicit scope override alone), no scope tail and no snapshot. What the
    // editor hands over is the opened workspace as a HARD UPPER BOUND; the daily
    // scope is applied by the engine out of the config it reads when it starts,
    // so a get never carries a list computed from an older reading of that file.
    expect(getCalls()).toEqual([
      ['--json', '--client-root', ROOT, '--sync', '-a', `${ROOT_FWD}/...`],
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
      handoff: 0,
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

    const res = await client.sync('#head')

    expect(getCalls()).toEqual([])
    expect(nativeSyncCalls()).toHaveLength(1)
    expect(res.ok).toBe(true)
  })

  it('carries a changelist target as --to', async () => {
    const client = await makeArmedClient()

    await client.sync('@4521')

    expect(getCalls()).toEqual([
      ['--json', '--client-root', ROOT, '--sync', '--to', '4521', '-a', `${ROOT_FWD}/...`],
    ])
  })

  it('keeps a depot-syntax scope off δ, without escaping it', async () => {
    const client = await makeArmedClient()
    // A depot-syntax scope (the graph's / the timeline's), handed in as the
    // per-call scope. δ reads entries literally, and a typed request carries
    // absolute LOCAL targets only, so this range is not one δ can be asked for
    // at all — p4 runs it verbatim, which is the engine that can read it.
    const res = await client.sync('#head', { scope: ['//depot/branch_x/...'] })

    expect(getCalls()).toEqual([])
    expect(res.ok).toBe(true)
    expect(nativeSyncCalls().map((a) => a.at(-1))).toEqual(['//depot/branch_x/...#head'])
  })

  it('stays on p4 for a revision spec δ cannot express', async () => {
    const client = await makeArmedClient()

    for (const spec of ['#4', '@2026/08/01', '']) {
      await client.sync(spec)
    }

    expect(getCalls()).toEqual([])
    expect(nativeSyncCalls().map((a) => a.at(-1))).toEqual([
      `${CONTENT}/...#4`,
      `${CONTENT}/...@2026/08/01`,
      `${CONTENT}/...`,
    ])
  })

  it('asks δ even when the config names a folder with a p4 metacharacter', async () => {
    // A config include whose name carries `@` is exactly what the engine escapes
    // for itself at the p4 boundary, and the get's own argv is the workspace
    // root either way — so nothing about that name can route the get native.
    const client = await makeArmedClient({}, scopeFixture([`${ROOT_FWD}/con@tent`]))
    syncReply = () => ({ records: [deltaFile('Content/a.cpp'), deltaSummary()] })
    const res = await client.sync('#head')

    expect(getCalls()).toHaveLength(1)
    expect(nativeSyncCalls()).toEqual([])
    expect(res.ok).toBe(true)
  })

  it('stays on p4 for the whole-client scope', async () => {
    const client = await makeArmedClient()
    // The whole client is no longer a default: a scope-less get falls back to
    // the daily scope, so `//...` only arrives as the command layer's explicit
    // whole-repo choice — a range outside every daily scope, which the command
    // layer puts to the user and whose accepted answer is the override.
    expect(client.syncScopes).toEqual([`${CONTENT}/...`])

    await client.sync('#head', { scope: ['//...'], overrideScope: true })

    expect(getCalls()).toEqual([])
    expect(nativeSyncCalls()).toHaveLength(1)

    // …and the depot spelling routes native on its own merits — it is not a
    // range δ's typed request can carry, so the override is not what decides
    // here (the command layer is where the user's agreement is obtained).
    const plain = await client.sync('#head', { scope: ['//...'] })
    expect(plain.ok).toBe(true)
    expect(nativeSyncCalls()).toHaveLength(2)
    expect(nativeSyncCalls()[1]!.at(-1)).toBe('//...#head')
  })

  // δ 读不懂的形态留在原生：逐文件修订号、日期，以及拒绝清单点名的 per-file force
  // （spec `''`，filespec 里已经钉了 `#rev`）。δ 能读的范围上的强制拉取见下面的 force 用例。
  it('stays on p4 for the force specs δ cannot express', async () => {
    const client = await makeArmedClient()

    for (const spec of ['#4', '@2026/08/01', '']) {
      await client.sync(spec, { force: true })
    }

    expect(getCalls()).toEqual([])
    expect(nativeSyncCalls().every((a) => a.includes('-f'))).toBe(true)
    expect(nativeSyncCalls().map((a) => a.at(-1))).toEqual([
      `${CONTENT}/...#4`,
      `${CONTENT}/...@2026/08/01`,
      `${CONTENT}/...`,
    ])
  })

  it('maps refusals, opened files and applied rows out of the engine run', async () => {
    const client = await makeArmedClient()
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

  // 回退只在原生接得住时才免费：含排除项的根目标没有对应 filespec，原生必然拒绝——把这次失败
  // 交回 `undefined` 只会让调用方报范围错误、盖住 δ 给的原因。改为如实上报 δ 的失败；未进 apply
  // 的失败不是引擎证据，不计三振。
  it('keeps the delta failure when the scope blocks the fallback, and does not count it', async () => {
    const lines: string[] = []
    const client = await makeArmedClient({ log: (msg) => lines.push(msg) }, excludedScope())
    syncReply = () => ({ code: 1, log: ['boom'] })

    const res = await client.sync('#head')

    expect(getCalls()).toHaveLength(1)
    // 原生一条都没跑：这份范围表达不出它自己的排除项。
    expect(nativeSyncCalls()).toEqual([])
    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(false)
    expect(res.summary).toBeUndefined()
    // 用户拿到的是引擎给的原因，不是盖住它的范围 toast。
    expect(res.error?.kind).toBe('other')
    expect(res.error?.suggestion).toContain('boom')
    expect(client.p4deltaFallbackState).toEqual({ failures: 0, disarmed: false })
    // 日志说清「为什么不重试」且不假称已写：未进 apply 不算已转交文件。
    const why = lines.find((l) => l.includes('cannot take this get over'))
    expect(why).toBeDefined()
    expect(why).toContain('nothing was applied')
  })

  // Past that point `-a` means part of the transfer may already have landed, and
  // re-running the scope under a second implementation is a different operation,
  // not a retry.
  it('reports a failure after the apply phase instead of retrying it, and counts it', async () => {
    const client = await makeArmedClient()
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
    // The setting's default is 4, so "once per get" would be every get.
    client.setSyncParallelThreads(8)
    syncReply = () => ({ records: [deltaFile('Content/a.cpp'), deltaSummary()] })

    await client.sync('#head')
    await client.sync('#head')

    expect(lines.filter((l) => l.includes('syncParallelThreads=8'))).toHaveLength(1)
  })

  it('clears the progress count when the get is done', async () => {
    const client = await makeArmedClient()
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

describe('PerforceClient.sync — a force get over a scope δ can read', () => {
  /** 预热扫描发布的漂移行，按发布顺序。 */
  const driftedOf = (client: PerforceClientInstance): Array<string | undefined> =>
    [...client.scanDrift.values()].map((row) => row.clientFile).sort()

  it('serves the repair from δ with --force, and never asks p4 for it', async () => {
    const client = await makeArmedClient()
    syncReply = () => ({
      records: [deltaForceFile('Content/a.cpp'), deltaSummary({ force: true })],
    })

    const res = await client.sync('#head', { force: true })

    expect(getCalls()).toEqual([
      ['--json', '--client-root', ROOT, '--sync', '--force', '-a', `${ROOT_FWD}/...`],
    ])
    // 修复是最具破坏性的一条路：「谁执行的」就是全部问题，δ 之外不能出现任何 p4 sync。
    expect(nativeSyncCalls()).toEqual([])
    expect(res.ok).toBe(true)
    expect(res.summary).toMatchObject({ applied: 1, handoff: 0, upToDate: false })
  })

  it('carries a picked changelist as --to on the repair', async () => {
    const client = await makeArmedClient()
    syncReply = () => ({
      records: [deltaForceFile('Content/a.cpp'), deltaSummary({ force: true })],
    })

    await client.sync('@4521', { force: true })

    expect(getCalls()).toEqual([
      [
        '--json',
        '--client-root',
        ROOT,
        '--sync',
        '--force',
        '--to',
        '4521',
        '-a',
        `${ROOT_FWD}/...`,
      ],
    ])
  })

  it('keeps the user-confirmed scope override on the repair', async () => {
    const client = await makeArmedClient()
    syncReply = () => ({
      records: [deltaForceFile('Content/a.cpp'), deltaSummary({ force: true })],
    })

    await client.sync('#head', {
      force: true,
      overrideScope: true,
      scope: [`${ROOT_FWD}/Content/...`],
      scopeTargets: [{ path: `${ROOT_FWD}/Content`, isDirectory: true }],
    })

    expect(getCalls()).toEqual([
      [
        '--json',
        '--client-root',
        ROOT,
        '--sync',
        '--force',
        '-a',
        '--no-scope-file',
        `${ROOT_FWD}/Content/...`,
      ],
    ])
  })

  // 强制修复没有 apply 阶段可观察，且可能在失败前已把文件交给原生 p4：没有结论的流不能当作
  // 「没写盘」的证据，所以只上报、绝不换一份实现把同一次破坏性运行再做一遍。
  it('reports a failed repair instead of re-running it on p4, and counts it', async () => {
    const client = await makeArmedClient()
    syncReply = () => ({ code: 1, log: ['connection dropped'] })

    const res = await client.sync('#head', { force: true })

    expect(getCalls()).toHaveLength(1)
    expect(nativeSyncCalls()).toEqual([])
    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(false)
    expect(res.summary).toBeUndefined()
    expect(client.p4deltaFallbackState).toEqual({ failures: 1, disarmed: false })
  })

  // 连普通 get 总能重服务的 exit 2 也不例外：它读的 argv 来自编辑器管不到的构建，而已发生的
  // 覆盖不可撤销。
  it('does not re-serve a repair that failed at the parse stage either', async () => {
    const client = await makeArmedClient()
    syncReply = () => ({ code: 2 })

    const res = await client.sync('#head', { force: true })

    expect(getCalls()).toHaveLength(1)
    expect(nativeSyncCalls()).toEqual([])
    expect(res.ok).toBe(false)
    expect(client.p4deltaFallbackState).toEqual({ failures: 1, disarmed: false })
  })

  it('answers a repair the engine ignored --force for as a failure, not a fallback', async () => {
    const client = await makeArmedClient()
    // force:false 的 summary 是普通 get 的形状，不是用户要的修复。
    syncReply = () => ({ records: [deltaFile('Content/a.cpp'), deltaSummary()] })

    const res = await client.sync('#head', { force: true })

    expect(getCalls()).toHaveLength(1)
    expect(nativeSyncCalls()).toEqual([])
    expect(res.ok).toBe(false)
  })

  it('subtracts the verified repair rows from drift, but not the handed-off ones', async () => {
    const client = await makeClient({ p4delta: { exe: P4DELTA_EXE } })
    scanReply = () => ({
      records: [
        deltaFile('Content/a.cpp', { class: 'edit', action: 'edit', mode: 'open' }),
        deltaFile('Content/b.cpp', { class: 'edit', action: 'edit', mode: 'open' }),
        deltaSummary({ mode: 'open', applied: false, total: 2, counts: { edit: 2 } }),
      ],
    })
    await client.runReconcileScan()
    expect(driftedOf(client)).toEqual([`${ROOT_FWD}/Content/a.cpp`, `${ROOT_FWD}/Content/b.cpp`])
    syncReply = () => ({
      records: [
        deltaForceFile('Content/a.cpp'),
        deltaForceFile('Content/b.cpp', { class: 'handoff', handoff: 'sync' }),
        deltaSummary({ force: true, counts: { update: 1 } }),
      ],
    })

    await client.sync('#head', { force: true })

    // a.cpp 是 δ 自己修的，漂移行清掉；b.cpp 只是整批转交，逐文件结果未知，行留着等
    // refresh 与下一轮扫描按磁盘重新给答案。
    expect(driftedOf(client)).toEqual([`${ROOT_FWD}/Content/b.cpp`])
  })

  it('leaves the drift untouched when a repair is cancelled', async () => {
    const client = await makeClient({ p4delta: { exe: P4DELTA_EXE } })
    scanReply = () => ({
      records: [
        deltaFile('Content/a.cpp', { class: 'edit', action: 'edit', mode: 'open' }),
        deltaFile('Content/b.cpp', { class: 'edit', action: 'edit', mode: 'open' }),
        deltaSummary({ mode: 'open', applied: false, total: 2, counts: { edit: 2 } }),
      ],
    })
    await client.runReconcileScan()
    let release: () => void = () => {}
    const held = new Promise<void>((r) => (release = r))
    syncReply = () => ({ code: 1, records: [deltaForceFile('Content/a.cpp')], hold: held })

    const pending = client.sync('#head', { force: true })
    await flush()
    expect(getCalls()).toHaveLength(1)
    client.cancelBusy()
    release()
    const res = await pending

    expect(res.cancelled).toBe(true)
    // 修复的记录没有 `stage`，被杀掉的流证明不了落盘情况，两行都留着，绝不藏起本地改动。
    expect(driftedOf(client)).toEqual([`${ROOT_FWD}/Content/a.cpp`, `${ROOT_FWD}/Content/b.cpp`])
  })
})

describe('PerforceClient.previewSync — δ engine', () => {
  it('answers from the engine without -a, folding refusals in', async () => {
    const client = await makeArmedClient()
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

    // The dry run is the same δ call minus `-a`.
    expect(getCalls()).toEqual([['--json', '--client-root', ROOT, '--sync', `${ROOT_FWD}/...`]])
    expect(res.ok).toBe(true)
    expect(res.files.map((f) => f.clientFile)).toEqual([
      `${ROOT_FWD}/Content/a.cpp`,
      `${ROOT_FWD}/Content/mod.cpp`,
    ])
    expect(res.upToDate).toBe(false)
  })

  it('falls back to p4 for a bounded preview, which -m cannot express', async () => {
    const client = await makeArmedClient()

    await client.previewSync(undefined, '#head', 50)

    expect(getCalls()).toEqual([])
    expect(spawned.some((a) => a.includes('-n') && a.includes('-m'))).toBe(true)
  })

  it('falls back to p4 when the engine does not answer a read-only preview', async () => {
    const client = await makeArmedClient()
    syncReply = () => ({ code: 2, sawNonJsonStdout: true })

    const res = await client.previewSync()

    expect(getCalls()).toHaveLength(1)
    expect(res.ok).toBe(true)
    // Nothing was written, so a failed preview costs nothing but the round trip.
    expect(client.p4deltaFallbackState).toEqual({ failures: 0, disarmed: false })
  })
})

/**
 * A preview and the get that follows it are two ordinary runs, and neither hands
 * the other a credential: each reads the config in force when IT starts. So an
 * edit landing in between is not something to unblock — it is simply the next
 * run's input, the range the workspace asks for now. What must hold is that
 * nothing is ever frozen: no stored range may outlive the config it came from,
 * in either direction (narrowed, widened, re-excluded, re-written, or gone).
 */
describe('PerforceClient — a config edit between a preview and the get', () => {
  /** What the stub answers the δ PREVIEW run (`--sync` without `-a`): the same
   *  file, reported in its preview stage, with a summary that says "not
   *  applied" — the shape `toSyncOutcome` reads for a dry run. */
  function previewReply(): DeltaReply {
    return {
      records: [
        deltaFile('Content/a.cpp', { stage: 'preview', applied: false }),
        deltaSummary({ applied: false, total: 1 }),
      ],
    }
  }

  it('runs the get over the config in force at ITS start, not the preview’s', async () => {
    const { client, setScope } = await makeSwappableClient(contentScope())
    syncReply = previewReply
    expect((await client.previewSync()).ok).toBe(true)

    // The config is edited while the preview is on screen: the get re-resolves
    // and runs over the range the workspace asks for NOW. No stored plan is
    // consulted, and nothing about the edit is a refusal.
    setScope(narrowedScope())
    await client.refreshScope()
    syncReply = () => ({ records: [deltaFile('Content/a.cpp'), deltaSummary()] })

    const res = await client.sync('#head')

    expect(res.ok).toBe(true)
    expect(client.dailyScope?.includes).toEqual([{ path: `${CONTENT}/sub`, kind: 'directory' }])
    expect(getCalls()).toHaveLength(2)
    expect(nativeSyncCalls()).toEqual([])
  })

  it('does not refuse when the config WIDENED its range', async () => {
    const { client, setScope } = await makeSwappableClient(contentScope())
    syncReply = previewReply
    expect((await client.previewSync()).ok).toBe(true)

    setScope(widenedScope())
    await client.refreshScope()
    syncReply = () => ({ records: [deltaFile('Content/a.cpp'), deltaSummary()] })

    const res = await client.sync('#head')

    expect(res.ok).toBe(true)
    expect(client.dailyScope?.includes).toEqual([
      { path: CONTENT, kind: 'directory' },
      { path: `${ROOT_FWD}/Tools`, kind: 'directory' },
    ])
    expect(getCalls()).toHaveLength(2)
    expect(nativeSyncCalls()).toEqual([])
  })

  it('does not refuse when the config gained an exclusion', async () => {
    const { client, setScope } = await makeSwappableClient(contentScope())
    syncReply = previewReply
    expect((await client.previewSync()).ok).toBe(true)

    // An exclusion does not move the INCLUDE list at all, which is exactly why
    // it used to need a fingerprint nobody could guess: the range's shape says
    // nothing about it. Reading the file again is what settles it.
    setScope(excludedScope())
    await client.refreshScope()
    syncReply = () => ({ records: [deltaFile('Content/a.cpp'), deltaSummary()] })

    const res = await client.sync('#head')

    expect(res.ok).toBe(true)
    expect(client.dailyScope?.excludes).toEqual([{ path: `${CONTENT}/gen`, kind: 'directory' }])
    expect(getCalls()).toHaveLength(2)
    expect(nativeSyncCalls()).toEqual([])
  })

  it('does not refuse when the config file is gone', async () => {
    const { client, setScope } = await makeSwappableClient(contentScope())
    syncReply = previewReply
    expect((await client.previewSync()).ok).toBe(true)

    // No config at all any more: the range is the whole opened workspace, which
    // is strictly wider than what the preview listed — and still not a refusal.
    setScope(NO_CONFIG)
    await client.refreshScope()
    syncReply = () => ({ records: [deltaFile('Content/a.cpp'), deltaSummary()] })

    const res = await client.sync('#head')

    expect(res.ok).toBe(true)
    expect(client.scopeState).toBe('ready')
    expect(getCalls()).toHaveLength(2)
    expect(nativeSyncCalls()).toEqual([])
  })

  it('resolves a get that had no preview behind it the same way', async () => {
    const client = await makeArmedClient()
    syncReply = () => ({ records: [deltaFile('Content/a.cpp'), deltaSummary()] })

    const res = await client.sync('#head')

    expect(res.ok).toBe(true)
    expect(getCalls()).toHaveLength(1)
    expect(getTargets()).toEqual([[`${ROOT_FWD}/...`]])
  })
})
