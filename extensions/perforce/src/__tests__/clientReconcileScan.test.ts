/**
 * Unit tests for `PerforceClient.runReconcileScan` — the background dry-run
 * `reconcile -n` walk that tints Explorer folders ahead of their files being
 * rendered. This locks in:
 *  1. Each directory batch is published to the renderer the moment it lands and
 *     checkpointed into the persistent cache (per-directory resume points).
 *  2. A clean directory is a RESULT (checkpointed with an empty file list), a
 *     failed batch is not — failure must never be cached as "nothing to see"
 *     (a SLOW failure only writes a split marker, never files).
 *  3. A batch slower than `perforce.reconcileScan.maxBatchDurationMs` that found
 *     drift — or that fails after outlasting the ceiling — splits into its
 *     direct subdirectories; the split itself is checkpointed as a marker so
 *     the next session resumes at the subdirectories. A slow-but-clean batch
 *     is NOT split (its cost is inherent hashing; splitting re-hashes per child).
 *  4. A checkpoint hit is served without a p4 spawn (resume after restart); a
 *     checkpoint older than the freshness ceiling is rescanned instead.
 *  5. A focus-scope change changes the checkpoint fingerprint, so scans from a
 *     different scope are never replayed.
 *  6. Cancellation stops the scan; completed checkpoints survive.
 *  7. Files already opened are filtered out when the drift group is assembled.
 *  8. Directory filespecs escape `@ # * %` (p4 filespec metacharacters).
 *  9. A mutation invalidates the scan checkpoints of every directory covering
 *     the mutated path (and a whole-workspace mutation clears the namespace).
 * 10. Going offline aborts the scan without spawning doomed batches and disarms
 *     it so a reconnect re-scans the un-checkpointed directories.
 * 11. The batch ceiling is clamped to the manifest minimum (1000ms).
 * 12. Dispose aborts in-flight held batches instead of leaving them to the
 *     SpawnWatchdog.
 * 13. Budget prediction runs before each batch: an expired checkpoint whose
 *     persisted `elapsedMs` exceeds the ceiling pre-splits the directory with
 *     zero parent batches; a never-scanned directory pre-splits when an
 *     early-exit local file count exceeds the threshold; both priors stand
 *     down (normal batch) when they fit the budget, and an unreadable count
 *     degrades to a normal scan.
 * 14. An external file change (working-tree watcher) is answered by a NARROW
 *     `reconcile -n` about those paths plus an incremental drift merge — never
 *     by re-walking the workspace; the covering checkpoint is PATCHED in place
 *     with that answer (preserving `completedAt`) rather than dropped, because
 *     with a root-level scope every file covers the single root checkpoint and
 *     dropping it cost the next session a full re-walk. The spec each path gets
 *     follows what it IS on disk: a file answers to its bare path, a directory to
 *     its `<dir>/...` subtree, and a path that is GONE to BOTH (which case
 *     deleted it cannot be known from a path that is not there — reading it as
 *     "a deleted file" is what made a deleted directory invisible). Two cases
 *     still invalidate: a bulk change past the path budget, and a directory whose
 *     excluded subtree cannot be carved around. An in-flight round is fenced by
 *     re-invalidating once it settles — a patch cannot fence a checkpoint that
 *     round has not written yet. Excluded / out-of-scope / self-mutation /
 *     offline / disposed events query nothing at all.
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileSystemWatcher } from '@universe-editor/extension-api'
import { expandP4Argv } from './expandP4Argv.js'
import { mkTempDir } from '@universe-editor/temp-root'

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = { end: vi.fn() }
  kill(): boolean {
    // Simulate a killed child: p4's real close resolves a failure result, which
    // is how cancellation surfaces to the scan loop.
    this.emit('close', 1)
    return true
  }
}

const spawnMock = vi.fn<(...args: unknown[]) => FakeChildProcess>()
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

/** The extension window, mocked so a mutation-failure path can surface its toast
 *  without a real host (the cleanest place is a failed-revert test). */
const windowMock = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showQuickPick: vi.fn(),
}))
vi.mock('@universe-editor/extension-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@universe-editor/extension-api')>()
  return { ...actual, window: windowMock }
})

/** The `node:fs/promises.readdir` the client uses for adaptive splitting. */
const readdirMock = vi.hoisted(() =>
  vi.fn<
    (
      dir: string,
    ) => Promise<
      Array<{ name: string; isDirectory: () => boolean; isSymbolicLink?: () => boolean }>
    >
  >(),
)
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: (...args: unknown[]) => readdirMock(...(args as [string])),
  }
})

const BRIDGE_KEY = '__universeExtensionHostBridge__'
/** Every resource group created by the bridge, so a test can observe the drift
 *  group's `resourceStates` after a scan settles (the publish wire was removed;
 *  the resident group is the surviving observation point). */
const groups: Array<{ id: string; resourceStates: unknown[] }> = []
/** When true, assigning the drift group's `resourceStates` throws — the bridge
 *  stand-in for a renderer that dies mid-publish (the deleted `publishWorkingTreeScan`
 *  wire's throw path). */
let reconcileGroupThrow = false
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
      createResourceGroup: (id: string) => {
        const group = {
          id,
          label: '',
          hideWhenEmpty: undefined,
          dispose() {},
        } as {
          id: string
          label: string
          hideWhenEmpty: unknown
          resourceStates: unknown[]
          dispose(): void
        }
        let states: unknown[] = []
        Object.defineProperty(group, 'resourceStates', {
          get: () => states,
          set: (v: unknown[]) => {
            if (reconcileGroupThrow) throw new Error('publish boom')
            states = v
          },
        })
        groups.push(group)
        return group
      },
      setSupplementaryDecorations: () => {},
      dispose() {},
    }),
  }
}

/** Per-test reset shared by the two scan describes: the SCM bridge, the spawn
 *  and readdir mocks, and the spawn / group ledgers. */
function resetScanHarness(): void {
  installScmBridge()
  spawnMock.mockReset()
  readdirMock.mockReset()
  // Every directory without a usable checkpoint now gets a cold-prior file
  // count before its batch; an empty listing ("no files") is the neutral
  // default so tests only override readdir when the count or a split matters.
  readdirMock.mockImplementation(async () => [])
  calls.length = 0
  groups.length = 0
  reconcileGroupThrow = false
  heldChildren.length = 0
  currentClock = undefined
  windowMock.showErrorMessage.mockClear()
}

const { PerforceClient } = await import('../client.js')
const { ConcurrencyGate } = await import('../concurrency.js')
const { setP4CommandTimeoutSeconds } = await import('../p4Service.js')
const { RECONCILE_SCAN_PRESPLIT_FILE_COUNT_THRESHOLD } = await import('../reconcileScanBudget.js')
const { P4CacheDisk } = await import('../p4CacheDisk.js')
type PerforceClientInstance = import('../client.js').PerforceClient
type PerforceClientOptions = import('../client.js').PerforceClientOptions
type P4CacheDiskBackend = import('../p4Cache.js').P4CacheDiskBackend
type P4CacheDiskInstance = import('../p4CacheDisk.js').P4CacheDisk

const ROOT = process.platform === 'win32' ? 'X:\\p4ws\\main' : '/p4ws/main'
const LOCAL = process.platform === 'win32' ? 'X:/p4ws/main' : '/p4ws/main'
const CLIENT = 'testclient'

/** A clock whose value tests advance by hand, injected as `P4CacheOptions.now`. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1000
  return { now: () => t, advance: (ms) => (t += ms) }
}

/** In-memory disk backend spy (the persistent checkpoint target). */
function fakeDisk(): P4CacheDiskBackend & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    get(ns: string, key: string): string | undefined {
      return store.get(`${ns}/${key}`)
    },
    set(ns: string, key: string, value: string): void {
      store.set(`${ns}/${key}`, value)
    },
    delete(ns: string, key: string): void {
      store.delete(`${ns}/${key}`)
    },
    deleteNamespace(ns: string): void {
      const prefix = `${ns}/`
      for (const k of [...store.keys()]) {
        if (k.startsWith(prefix)) store.delete(k)
      }
    },
  }
}

interface RespondOptions {
  /** Reconcile rows per filespec (client-syntax rels). Return undefined for "no
   *  special handling" (empty success). `filespec` is the path the batch asks
   *  about (the bare form when a spec pair is present); `specs` is the batch's
   *  whole filespec list, for asserting on the shape p4 was actually handed. */
  reconcile?: (
    filespec: string,
    specs: readonly string[],
  ) => { rel: string; action?: string }[] | undefined
  /** Advance the injected clock by this much before replying (a slow batch). */
  reconcileDelayMs?: (filespec: string) => number
  /** Override the reconcile exit code / stderr (failure scenarios). */
  reconcileExit?: (filespec: string) => number | undefined
  reconcileStderr?: (filespec: string) => string
  /** Emit these reconcile rows, then never close — the SpawnWatchdog kills the
   *  child and the partial-on-timeout path recovers the streamed rows. */
  reconcileTimeout?: (filespec: string) => { rel: string; action?: string }[] | undefined
  /** Hold the reconcile child open (never close) until killed — cancellation. */
  reconcileHold?: (filespec: string) => boolean
  /** Opened files reported by `p4 opened` (client-syntax rows). */
  opened?: () => { rel: string; action?: string; change?: string }[]
  /** Override the `p4 clean` (revert) exit code / stderr — a failed mutate. */
  cleanExit?: number | undefined
  cleanStderr?: string
  /** Full control of a `p4 sync` reply: raw stdout/stderr lines (the sync-drift
   *  tests hand the server-printed applied / refused lines verbatim). `hold`
   *  keeps the child open until `releaseHeld()` — a suspension test needs the
   *  run to outlive its own writes. */
  sync?: (argv: string[]) => { stdout?: string; stderr?: string; exit?: number; hold?: boolean }
}

const calls: string[][] = []

/** Held reconcile children, so a test can let them close on demand instead of
 *  only ever killing them (the in-flight-settle race needs the round to COMPLETE
 *  normally while a watcher event is pending). */
const heldChildren: { close: () => void }[] = []

/** Close every child currently held open by `reconcileHold`. */
function releaseHeld(): void {
  for (const child of heldChildren.splice(0)) child.close()
}

function respond(opts: RespondOptions = {}): void {
  spawnMock.mockImplementation((...args: unknown[]) => {
    // Expanded, not raw: a narrow query large enough to sit on the char budget
    // trips the spawn layer's `-x <argfile>`, and those paths would otherwise
    // vanish from the recorded argv (see expandP4Argv).
    const argv = expandP4Argv((args[1] as string[]) ?? [])
    calls.push(argv)
    const child = new FakeChildProcess()
    queueMicrotask(() => {
      const { stdout, stderr, exit, hold } = handle(argv, opts)
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      if (hold) {
        heldChildren.push({ close: () => child.emit('close', exit ?? 0) })
        return
      }
      if (stderr) child.stderr.emit('data', Buffer.from(stderr))
      child.emit('close', exit ?? 0)
    })
    return child
  })
}

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

function reconcileRows(rows: { rel: string; action?: string }[]): string {
  if (rows.length === 0) return ''
  return (
    rows
      .map((r) =>
        JSON.stringify({
          depotFile: `//depot/branch_x/${r.rel}`,
          clientFile: `//${CLIENT}/${r.rel}`,
          action: r.action ?? 'edit',
          rev: '1',
        }),
      )
      .join('\n') + '\n'
  )
}

function handle(
  argv: string[],
  opts: RespondOptions,
): { stdout: string; stderr?: string; exit?: number; hold?: boolean } {
  const cmd = subcommand(argv)
  if (cmd === 'info') {
    return { stdout: `... clientName ${CLIENT}\n... clientRoot ${ROOT}\n... userName testuser\n\n` }
  }
  if (cmd === 'opened') {
    const rows = opts.opened?.() ?? []
    return {
      stdout: rows
        .map((r) =>
          JSON.stringify({
            depotFile: `//depot/branch_x/${r.rel}`,
            clientFile: `//${CLIENT}/${r.rel}`,
            action: r.action ?? 'edit',
            rev: '1',
            change: r.change ?? 'default',
          }),
        )
        .join('\n'),
    }
  }
  if (cmd === 'reconcile' && argv.includes('-n')) {
    const specs = reconcileSpecs(argv)
    // The responders are written per PATH, not per spec, so a path answered by a
    // spec pair (a bare form plus its `<path>/...` companion — the shape every
    // vanished path and every directory gets) reads as that path. A scan batch is
    // unaffected: it has no bare/companion pair, so the trailing spec stands.
    const filespec = specs.find((s) => specs.includes(`${s}/...`)) ?? specs[specs.length - 1] ?? ''
    const delay = opts.reconcileDelayMs?.(filespec)
    if (delay) currentClock?.advance(delay)
    const timeoutRows = opts.reconcileTimeout?.(filespec)
    if (timeoutRows) return { stdout: reconcileRows(timeoutRows), hold: true }
    if (opts.reconcileHold?.(filespec)) return { stdout: '', hold: true }
    const exit = opts.reconcileExit?.(filespec)
    if (exit !== undefined && exit !== 0) {
      return { stdout: '', stderr: opts.reconcileStderr?.(filespec) ?? 'reconcile failed', exit }
    }
    const rows = opts.reconcile?.(filespec, specs) ?? []
    return { stdout: reconcileRows(rows) }
  }
  if (cmd === 'clean') {
    const exit = opts.cleanExit
    if (exit !== undefined && exit !== 0) {
      return { stdout: '', stderr: opts.cleanStderr ?? 'clean failed', exit }
    }
    return { stdout: '' }
  }
  if (cmd === 'sync') {
    const reply = opts.sync?.(argv) ?? {}
    return {
      stdout: reply.stdout ?? '',
      ...(reply.stderr !== undefined ? { stderr: reply.stderr } : {}),
      ...(reply.exit !== undefined ? { exit: reply.exit } : {}),
      ...(reply.hold === true ? { hold: true } : {}),
    }
  }
  // changes / fstat / describe — succeed silently with no records.
  return { stdout: '' }
}

/** All `reconcile -n` argv seen so far (each is the full p4 argv). */
function reconcileScans(): string[][] {
  return calls.filter((a) => subcommand(a) === 'reconcile' && a.includes('-n'))
}

const WILDCARD_SPEC = /[/\\](\.\.\.|\*)$/

/** The filespecs of a `reconcile -n` argv: everything after `-d`, the last of the
 *  command's fixed flags. A batch may carry several — a path that is GONE sends
 *  its bare form AND its `<path>/...` companion. */
function reconcileSpecs(argv: string[]): string[] {
  const at = argv.indexOf('-d')
  return at === -1 ? [] : argv.slice(at + 1)
}

/**
 * The background scan's own spawns: a `reconcile -n` whose filespecs are ALL
 * recursive/wildcard (`<dir>/...` or a carved `<dir>/*`).
 *
 * Split from {@link narrowScans} because BOTH are `reconcile -n` — asserting on
 * `reconcileScans().length` cannot tell "re-walked the whole directory" from
 * "asked about three files", which is exactly the distinction the watcher's
 * narrow-query design turns on. A narrow query for a path that is GONE carries a
 * `<path>/...` companion alongside the bare path (which of "a file" / "a
 * directory" was deleted cannot be known), so the test is "every spec wildcards",
 * not "some spec wildcards" — otherwise that batch would be counted as a re-walk.
 */
function fullScanScans(): string[][] {
  return reconcileScans().filter((a) => {
    const specs = reconcileSpecs(a)
    return specs.length > 0 && specs.every((s) => WILDCARD_SPEC.test(s))
  })
}

/** The per-path spawns: a `reconcile -n` carrying at least one concrete path
 *  (the watcher flush, `checkWorkingTree`, `revert -k`'s re-query). */
function narrowScans(): string[][] {
  return reconcileScans().filter((a) => reconcileSpecs(a).some((s) => !WILDCARD_SPEC.test(s)))
}

let currentClock: ReturnType<typeof fakeClock> | undefined

/** A controllable `FileSystemWatcher` fake: its three events can be fired by the
 *  test with a filesystem path, mirroring git's `repositoryWatcher.test.ts`. */
interface FakeWatcherController {
  readonly watcher: FileSystemWatcher
  readonly dispose: ReturnType<typeof vi.fn>
  fire(kind: 'create' | 'change' | 'delete', path: string): void
}

function makeFakeWatcher(): FakeWatcherController {
  const listeners = {
    create: new Set<(uri: { fsPath: string }) => void>(),
    change: new Set<(uri: { fsPath: string }) => void>(),
    delete: new Set<(uri: { fsPath: string }) => void>(),
  }
  const dispose = vi.fn()
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
    dispose,
  }
  return {
    watcher: watcher as unknown as FileSystemWatcher,
    dispose,
    fire(kind, path) {
      for (const fn of [...listeners[kind]]) fn({ fsPath: path })
    },
  }
}

/** Every client a test built, so `afterEach` can tear them down. Spawns are
 *  observed through the module-global `calls` array, which `beforeEach` resets —
 *  but a client left alive keeps floating work alive too (the background scan a
 *  `refresh()` tail scheduled, a debounced flush), and that work spawns into
 *  whichever test happens to be running when its timer fires. Under load the
 *  stray lands one test later and fails an assertion that has nothing to do with
 *  it; disposing on teardown is what keeps each test's spawns its own. */
const createdClients: PerforceClientInstance[] = []

afterEach(() => {
  for (const client of createdClients) client.dispose()
  createdClients.length = 0
})

async function makeClient(
  opts: RespondOptions = {},
  disk?: P4CacheDiskBackend,
  clock = fakeClock(),
  clientOptions: PerforceClientOptions = {},
): Promise<PerforceClientInstance> {
  currentClock = clock
  respond(opts)
  const client = await PerforceClient.create(
    ROOT,
    {},
    new ConcurrencyGate(4),
    {
      enabled: true,
      workspaceTtlMs: 4000,
      now: clock.now,
      ...(disk ? { disk } : {}),
    },
    clientOptions,
  )
  expect(client).toBeDefined()
  createdClients.push(client!)
  return client!
}

/** Await a macrotask so the debounce flush (delay 0 in tests) and the re-armed
 *  scan's own macrotask hop have both been scheduled. */
function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// --- drift-set observations --------------------------------------------------
//
// The `publishWorkingTreeScan` wire was removed: the renderer now reads the
// client's resident drift group. The group's rows are whole-array assigned on
// every settle, so the rendered set is observable via `reconcileGroupStates`,
// and the per-directory ownership (which directory contributed what, which is
// exactly what the old `published[].directory` carried) via `scanDriftByDir`.

/** The drift group's rendered rows as `{ path, letter }`, in group order. */
function groupRows(client: PerforceClientInstance): Array<{ path: string; letter: string }> {
  return client.reconcileGroupStates.map((s) => ({
    path: s.resourceUri,
    letter: s.contextValue ?? '',
  }))
}

/** Every directory that contributed a drift observation, in landing order. */
function scannedDirs(client: PerforceClientInstance): string[] {
  return [...client.scanDriftByDir.keys()]
}

/** Every path that contributed a drift observation, in `scanDrift` key order. */
function driftFiles(client: PerforceClientInstance): string[] {
  return [...client.scanDrift.values()].flatMap((f) => (f.clientFile ? [f.clientFile] : []))
}

describe('PerforceClient.runReconcileScan', () => {
  beforeEach(() => {
    resetScanHarness()
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  // --- ① publish + checkpoint -----------------------------------------------

  it('publishes each directory batch and checkpoints it into the persistent cache', async () => {
    const disk = fakeDisk()
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt', action: 'edit' }] }, disk)
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    // The drift group now carries the row the old publish wire broadcast: the
    // path is the local file and the letter is the reconcile drift letter (RM
    // for an edit), never the opened row's bare action letter.
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])
    // One checkpoint under the scan namespace.
    expect(disk.store.size).toBe(1)
    const [key] = [...disk.store.keys()]
    expect(key).toContain('reconcileScan/')
    const entry = JSON.parse(disk.store.get(key!)!) as { completedAt: number; files: unknown[] }
    expect(entry.completedAt).toBeTypeOf('number')
    expect(entry.files).toHaveLength(1)
  })

  it('checkpoints a clean directory as a result (empty file list)', async () => {
    const disk = fakeDisk()
    const client = await makeClient({ reconcile: () => [] }, disk)
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    // A clean directory is a RESULT, not an absence — the dir key appears with an
    // empty list, and the rendered group is empty.
    expect(scannedDirs(client)).toEqual([LOCAL])
    expect(client.scanDriftByDir.get(LOCAL)).toEqual([])
    expect(groupRows(client)).toEqual([])
    expect(disk.store.size).toBe(1)
    const entry = JSON.parse([...disk.store.values()][0]!) as { files: unknown[] }
    expect(entry.files).toEqual([])
  })

  // --- ② failure is never cached as clean ------------------------------------

  it('leaves a failed directory un-checkpointed and unrendered', async () => {
    const disk = fakeDisk()
    const client = await makeClient(
      {
        reconcile: () => [{ rel: 'a.txt' }],
        reconcileExit: () => 1,
        reconcileStderr: () => 'Connect to server failed; TCP connect failed',
      },
      disk,
    )
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    // Failure is not "clean": nothing enters the drift set, nothing renders.
    expect(scannedDirs(client)).toEqual([])
    expect(groupRows(client)).toEqual([])
    expect(disk.store.size).toBe(0)
  })

  it('treats "no file(s) to reconcile" as a clean batch, not a failure', async () => {
    const disk = fakeDisk()
    const client = await makeClient(
      {
        reconcile: () => [],
        reconcileExit: () => 1,
        reconcileStderr: () => 'no file(s) to reconcile.',
      },
      disk,
    )
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    // "no file(s) to reconcile" is a clean answer: the directory contributes a
    // (empty) observation and checkpoints it.
    expect(scannedDirs(client)).toEqual([LOCAL])
    expect(client.scanDriftByDir.get(LOCAL)).toEqual([])
    expect(groupRows(client)).toEqual([])
    expect(disk.store.size).toBe(1)
  })

  // --- ③ adaptive split -------------------------------------------------------

  it('splits a batch slower than the ceiling into its subdirectories', async () => {
    const disk = fakeDisk()
    const clock = fakeClock()
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === LOCAL)
        return ['sub1', 'sub2'].map((name) => ({
          name,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        }))
      return []
    })
    const client = await makeClient(
      {
        reconcile: (filespec) => {
          // The filespec is `<dir>/...` where <dir> uses the OS separator for
          // split subdirectories (`path.join`) — compare on the directory.
          const dir = filespec.replace(/[/\\]\.\.\.$/, '')
          if (dir === LOCAL) {
            // A slow batch: the injected clock advances past the 10s ceiling.
            clock.advance(20_000)
            return [{ rel: 'top.txt' }]
          }
          if (dir === join(LOCAL, 'sub1')) return [{ rel: 'sub1/a.txt' }]
          if (dir === join(LOCAL, 'sub2')) return []
          return undefined
        },
      },
      disk,
      clock,
    )
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    // The slow parent still publishes (the scan's result is not wasted), then
    // each subdirectory batch publishes in turn. Subdirectory paths come from
    // `readdir` + `path.join`, so assert with the same helper, not a hand-built
    // separator.
    expect(scannedDirs(client)).toEqual([LOCAL, join(LOCAL, 'sub1'), join(LOCAL, 'sub2')])
    expect(client.scanDriftByDir.get(LOCAL)).toHaveLength(1)
    expect(client.scanDriftByDir.get(join(LOCAL, 'sub1'))).toHaveLength(1)
    expect(client.scanDriftByDir.get(join(LOCAL, 'sub2'))).toHaveLength(0)
    // The slow parent checkpoints the SPLIT itself (a marker with no files — its
    // result was published just above), so the next session resumes at the
    // subdirectories instead of re-running the slow batch; the two fast
    // subdirectories checkpoint their results.
    const keys = [...disk.store.keys()]
    expect(keys).toHaveLength(3)
    const parentKey = keys.find((k) => k.includes('reconcileScan/') && !k.includes('sub'))
    expect(parentKey).toBeDefined()
    const parentEntry = JSON.parse(disk.store.get(parentKey!)!) as {
      split?: boolean
      files: unknown[]
    }
    expect(parentEntry.split).toBe(true)
    expect(parentEntry.files).toEqual([])
    expect(keys.some((k) => k.includes(join(LOCAL, 'sub1')))).toBe(true)
    expect(keys.some((k) => k.includes(join(LOCAL, 'sub2')))).toBe(true)
  })

  it('splits a batch that fails after outlasting the ceiling (watchdog kill)', async () => {
    // A batch that burns the whole ceiling before dying (SpawnWatchdog kill,
    // dropped connection) would fail just as slowly next session — re-running
    // the same doomed parent forever is the real-workspace regression this
    // locks in. It splits like a slow success: subdirectories are scanned
    // piecemeal now and a split marker lets later sessions resume there.
    const disk = fakeDisk()
    const clock = fakeClock()
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === LOCAL)
        return ['sub1', 'sub2'].map((name) => ({
          name,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        }))
      return []
    })
    const client = await makeClient(
      {
        // The parent is slow AND fails (a watchdog kill surfaces as a non-zero
        // exit with a timeout stderr); the subdirectories succeed quickly.
        reconcileDelayMs: (filespec) => (filespec === `${LOCAL}/...` ? 20_000 : 0),
        reconcileExit: (filespec) => (filespec === `${LOCAL}/...` ? 1 : undefined),
        reconcileStderr: () => 'timed out after 600000ms and was killed',
        reconcile: (filespec) => {
          const dir = filespec.replace(/[/\\]\.\.\.$/, '')
          if (dir === join(LOCAL, 'sub1')) return [{ rel: 'sub1/a.txt' }]
          if (dir === join(LOCAL, 'sub2')) return []
          return undefined
        },
      },
      disk,
      clock,
    )
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    // The failed parent publishes nothing, but both subdirectory batches do.
    expect(scannedDirs(client)).toEqual([join(LOCAL, 'sub1'), join(LOCAL, 'sub2')])
    expect(client.scanDriftByDir.get(join(LOCAL, 'sub1'))).toHaveLength(1)
    expect(client.scanDriftByDir.get(join(LOCAL, 'sub2'))).toHaveLength(0)
    // The parent checkpoints the SPLIT marker (no files — there was no result);
    // the subdirectories checkpoint their results, so the next session resumes
    // at the subdirectories instead of re-running the doomed parent batch.
    const keys = [...disk.store.keys()]
    expect(keys).toHaveLength(3)
    const parentKey = keys.find((k) => k.includes('reconcileScan/') && !k.includes('sub'))
    expect(parentKey).toBeDefined()
    const parentEntry = JSON.parse(disk.store.get(parentKey!)!) as {
      split?: boolean
      files: unknown[]
    }
    expect(parentEntry.split).toBe(true)
    expect(parentEntry.files).toEqual([])
    expect(keys.some((k) => k.includes(join(LOCAL, 'sub1')))).toBe(true)
    expect(keys.some((k) => k.includes(join(LOCAL, 'sub2')))).toBe(true)
  })

  it('does not split a fast failure (leaves it un-checkpointed)', async () => {
    // A fast failure (server refused, auth) is transient — the directory stays
    // un-checkpointed so the next session retries the parent. The only readdir
    // is the cold-prior count; the split path never touches it.
    const disk = fakeDisk()
    const client = await makeClient(
      {
        reconcile: () => [{ rel: 'a.txt' }],
        reconcileExit: () => 1,
        reconcileStderr: () => 'Connect to server failed; TCP connect failed',
      },
      disk,
    )
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    expect(scannedDirs(client)).toEqual([])
    expect(groupRows(client)).toEqual([])
    expect(disk.store.size).toBe(0)
    expect(readdirMock).toHaveBeenCalledTimes(1)
  })

  it('leaves a slow failure with no subdirectories un-checkpointed', async () => {
    // A slow failure that cannot be split (leaf directory) must not write a
    // "split" marker with zero subdirectories — that would be a checkpoint of
    // nothing. The directory stays un-checkpointed for next session's retry.
    const disk = fakeDisk()
    const clock = fakeClock()
    readdirMock.mockImplementation(async () => []) // no subdirectories to split into
    const client = await makeClient(
      {
        reconcileDelayMs: () => 20_000, // past the ceiling
        reconcileExit: () => 1,
        reconcileStderr: () => 'timed out after 600000ms and was killed',
      },
      disk,
      clock,
    )
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    expect(scannedDirs(client)).toEqual([])
    expect(groupRows(client)).toEqual([])
    expect(disk.store.size).toBe(0)
  })

  it('does not split a fast batch', async () => {
    const disk = fakeDisk()
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    expect(scannedDirs(client)).toEqual([LOCAL])
    expect(client.scanDriftByDir.get(LOCAL)).toHaveLength(1)
    expect(disk.store.size).toBe(1)
    // Only the cold-prior count read the directory; the split path did not.
    expect(readdirMock).toHaveBeenCalledTimes(1)
  })

  it('does not split a batch whose elapsed equals the ceiling exactly', async () => {
    // The comparison is strictly greater-than: a batch that lands exactly on
    // the ceiling is still a normal (single-batch) checkpoint, not a split.
    const disk = fakeDisk()
    const clock = fakeClock()
    const client = await makeClient(
      {
        reconcileDelayMs: () => 10_000, // exactly the default ceiling
        reconcile: () => [{ rel: 'a.txt' }],
      },
      disk,
      clock,
    )
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    expect(scannedDirs(client)).toEqual([LOCAL])
    expect(disk.store.size).toBe(1)
    const entry = JSON.parse([...disk.store.values()][0]!) as { split?: boolean }
    expect(entry.split).toBeUndefined()
    // Only the cold-prior count read the directory; the split path did not.
    expect(readdirMock).toHaveBeenCalledTimes(1)
  })

  it('does not split a slow batch that found no drift', async () => {
    // A slow-but-clean directory (a huge tree whose hashing cost is inherent)
    // would be re-hashed by every child batch if split — the parent already
    // hashed the whole subtree, so splitting multiplies work for zero new
    // information. It checkpoints the clean result instead; the freshness
    // ceiling schedules the rescan.
    const disk = fakeDisk()
    const clock = fakeClock()
    const client = await makeClient(
      {
        reconcileDelayMs: () => 20_000, // past the 10s ceiling
        reconcile: () => [], // …but nothing to reconcile
      },
      disk,
      clock,
    )
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    expect(scannedDirs(client)).toEqual([LOCAL])
    expect(client.scanDriftByDir.get(LOCAL)).toEqual([])
    expect(disk.store.size).toBe(1)
    const entry = JSON.parse([...disk.store.values()][0]!) as { files: unknown[]; split?: boolean }
    expect(entry.files).toEqual([])
    expect(entry.split).toBeUndefined()
    // Only the cold-prior count read the directory; the split path did not.
    expect(readdirMock).toHaveBeenCalledTimes(1)
  })

  // --- ④ resume from checkpoint ----------------------------------------------

  it('serves a checkpointed directory without spawning p4 (resume after restart)', async () => {
    const disk = fakeDisk()
    const first = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    first.setReconcileScope([LOCAL])
    await first.runReconcileScan()
    expect(reconcileScans()).toHaveLength(1)

    // A fresh client (new session) sharing the disk: the checkpoint answers
    // with zero p4 spawns.
    const second = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    second.setReconcileScope([LOCAL])
    await second.runReconcileScan()

    expect(reconcileScans()).toHaveLength(1)
    // Both sessions observe the same drift: the first from its own scan, the
    // second replayed from the checkpoint (zero spawns). Each client owns its
    // own resident drift set.
    expect(groupRows(first)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])
    expect(groupRows(second)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])
  })

  // --- ⑤ focus fingerprint ----------------------------------------------------

  it('a focus-scope change invalidates the checkpoint (different fingerprint)', async () => {
    const disk = fakeDisk()
    const client = await makeClient(
      {
        // Each mock row's rel sits UNDER the scanned directory (see the
        // scope-change suite note): the drift group filters out-of-scope rows.
        reconcile: (filespec) => {
          if (filespec === `${LOCAL}/A/...`) return [{ rel: 'A/in-a.txt' }]
          if (filespec === `${LOCAL}/B/...`) return [{ rel: 'B/in-b.txt' }]
          return undefined
        },
      },
      disk,
    )
    client.setReconcileScope([`${LOCAL}/A`])
    await client.runReconcileScan()
    expect(reconcileScans()).toHaveLength(1)

    client.setReconcileScope([`${LOCAL}/B`])
    await client.runReconcileScan()

    // B was never scanned under the old fingerprint — a new spawn answers it.
    expect(reconcileScans()).toHaveLength(2)
    // The scope change dropped the old drift set; only B's row survives.
    expect(scannedDirs(client)).toEqual([`${LOCAL}/B`])
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/B/in-b.txt`, letter: 'RM' }])
  })

  // --- ⑤b scope-change re-preheat --------------------------------------------
  //
  // A scope (or exclusion) change must cancel an in-flight round and re-preheat
  // the new scope in the SAME session — otherwise a giant repo keeps scanning
  // the old scope for tens of minutes after the user re-focuses. These drive the
  // armed path (`scheduleReconcileScan`): a direct `runReconcileScan` never sets
  // the armed flag, so the reset helper's guard would no-op on it.

  it('a scope change mid-scan cancels the in-flight round and re-preheats the new scope', async () => {
    const disk = fakeDisk()
    const client = await makeClient(
      {
        // Each mock row's rel must sit UNDER the scanned directory — a real
        // `reconcile -n <dir>/...` never reports a file outside that subtree, and
        // the drift group's scope filter now retracts such out-of-scope rows.
        reconcile: (filespec) => {
          if (filespec === `${LOCAL}/A/...`) return [{ rel: 'A/in-a.txt' }]
          if (filespec === `${LOCAL}/C/...`) return [{ rel: 'C/in-c.txt' }]
          return undefined
        },
        reconcileHold: (filespec) => filespec === `${LOCAL}/B/...`,
      },
      disk,
    )
    client.setReconcileScope([`${LOCAL}/A`, `${LOCAL}/B`])
    client.scheduleReconcileScan()
    // A completes and checkpoints; B is held open in flight.
    await vi.waitFor(() => expect(disk.store.size).toBe(1))

    // Re-focus onto C: the reset aborts the held B child and disarms.
    client.setReconcileScope([`${LOCAL}/C`])
    await client.whenReconcileScanSettled()
    // Let any settle-triggered replay round finish so no background scan leaks
    // into the next test (the scan is fire-and-forget, not auto-disposed).
    await nextMacrotask()
    await client.whenReconcileScanSettled()

    // B was killed exactly once (never re-walked); C was scanned by the re-armed round.
    const specs = reconcileScans().map((argv) => argv[argv.length - 1])
    expect(specs.filter((s) => s === `${LOCAL}/B/...`)).toHaveLength(1)
    expect(specs).toContain(`${LOCAL}/C/...`)
    // The scope change cleared the old drift; only C's row was merged this session.
    expect(scannedDirs(client)).toEqual([`${LOCAL}/C`])
    expect(driftFiles(client)).toEqual([`${LOCAL}/C/in-c.txt`])
    // Checkpoints on disk include A under the OLD fingerprint (orphaned) and C under the new.
    const keys = [...disk.store.keys()]
    expect(keys.some((k) => k.endsWith(`${LOCAL}/A`))).toBe(true)
    expect(keys.some((k) => k.endsWith(`${LOCAL}/C`))).toBe(true)
  })

  it('a scope change after the scan completed re-preheats the new scope', async () => {
    const client = await makeClient({
      reconcile: (filespec) => {
        if (filespec === `${LOCAL}/A/...`) return [{ rel: 'A/in-a.txt' }]
        if (filespec === `${LOCAL}/B/...`) return [{ rel: 'B/in-b.txt' }]
        return undefined
      },
    })
    client.setReconcileScope([`${LOCAL}/A`])
    client.scheduleReconcileScan()
    await client.whenReconcileScanSettled()
    expect(reconcileScans()).toHaveLength(1)
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/A/in-a.txt`, letter: 'RM' }])

    // No round in flight: the reset's own schedule re-arms immediately.
    client.setReconcileScope([`${LOCAL}/B`])
    await client.whenReconcileScanSettled()

    expect(reconcileScans()).toHaveLength(2)
    expect(scannedDirs(client)).toEqual([`${LOCAL}/B`])
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/B/in-b.txt`, letter: 'RM' }])
  })

  it('an exclusion change re-preheats under a new fingerprint without clearing unrelated drift', async () => {
    const disk = fakeDisk()
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    client.setReconcileScope([LOCAL])
    client.scheduleReconcileScan()
    await client.whenReconcileScanSettled()
    expect(reconcileScans()).toHaveLength(1)
    expect(driftFiles(client)).toEqual([`${LOCAL}/a.txt`])

    // The exclusion moves the checkpoint fingerprint, so the armed round re-preheats…
    client.setReconcileExcludes([`${LOCAL}/ignored`])
    await client.whenReconcileScanSettled()
    // Let any settle-triggered replay round finish so no background scan leaks
    // into the next test (the scan is fire-and-forget, not auto-disposed).
    await nextMacrotask()
    await client.whenReconcileScanSettled()

    // …but the drift set is NOT cleared (exclusions filter at assign time): the row survives.
    expect(fullScanScans().length).toBeGreaterThanOrEqual(2)
    expect(driftFiles(client)).toEqual([`${LOCAL}/a.txt`])
    // Two checkpoints under two different fingerprints.
    const fps = [...disk.store.keys()].map((k) => k.split(':')[0])
    expect(new Set(fps).size).toBe(2)
  })

  // --- ⑤c scope FILES (focus entries that name one file, not a directory) ------
  //
  // A focus entry can point at a file (`Source/Client/Run.bat`). Such an entry
  // must NEVER reach the recursive directory phase — `reconcile -n <file>/...` is
  // a no-such-file p4 answers as clean (exit 0, empty), and checkpointing that
  // empty answer would pin the file's drift verdict forever. Instead each scope
  // file is re-verified fresh every session by a narrow per-file `reconcile -n`
  // that is never checkpointed.

  it('a scope file is verified fresh every session and never checkpointed', async () => {
    const disk = fakeDisk()
    const runBat = `${LOCAL}/Source/Client/Run.bat`
    // The client's root doesn't exist on the real filesystem, so inject the
    // scope-file existence probe: Run.bat exists, anything else does not.
    const exists = { scopeFileExists: (p: string) => p === runBat }
    const client = await makeClient(
      {
        reconcile: (filespec) => {
          // The per-file query carries the file path itself (no `/...`).
          if (filespec === runBat) return [{ rel: 'Source/Client/Run.bat' }]
          return undefined
        },
      },
      disk,
      undefined,
      exists,
    )
    client.setReconcileScope([LOCAL], [runBat])
    await client.runReconcileScan()

    // The file was reported as drift via the narrow per-file query.
    expect(groupRows(client)).toEqual([{ path: runBat, letter: 'RM' }])
    // The only checkpoint on disk is the directory phase's — the scope file
    // itself was NEVER checkpointed (a checkpointed "clean" would freeze it).
    for (const key of disk.store.keys()) {
      expect(key.endsWith(runBat)).toBe(false)
    }
    // The narrow query carried the exact file path, never a `<file>/...` wildcard.
    const fileScans = narrowScans().filter((a) => a.some((x) => x === runBat))
    expect(fileScans.length).toBeGreaterThanOrEqual(1)
    expect(fullScanScans().some((a) => a.some((x) => x.startsWith(runBat)))).toBe(false)

    // A second session re-runs the narrow query rather than replaying a verdict:
    // the spawn count for the file grows, and the disk still holds no file key.
    const before = narrowScans().filter((a) => a.some((x) => x === runBat)).length
    const second = await makeClient(
      {
        reconcile: (filespec) => {
          if (filespec === runBat) return [{ rel: 'Source/Client/Run.bat' }]
          return undefined
        },
      },
      disk,
      undefined,
      exists,
    )
    second.setReconcileScope([LOCAL], [runBat])
    await second.runReconcileScan()
    expect(narrowScans().filter((a) => a.some((x) => x === runBat)).length).toBeGreaterThan(before)
    for (const key of disk.store.keys()) {
      expect(key.endsWith(runBat)).toBe(false)
    }
  })

  it('a missing scope file spawns no per-file query and reports nothing', async () => {
    // resolveFocusScope keeps a MISSING entry in `files` (never guessing it was a
    // directory). The scan's existence gate then skips the query entirely — a
    // vanished file has no drift to report.
    const gone = `${LOCAL}/Gone/Thing.txt`
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, undefined, undefined, {
      scopeFileExists: () => false,
    })
    client.setReconcileScope([LOCAL], [gone])
    await client.runReconcileScan()

    expect(narrowScans().some((a) => a.some((x) => x === gone))).toBe(false)
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])
  })

  it('the drift group retracts a row a stale merge left outside the current scope', async () => {
    // Defense in depth: whatever ends up in `_driftFiles`, the group only renders
    // rows inside the current scope. A file-only focus narrows the client to
    // `isScopeFile` matching, so a directory-scan row under the root is out of scope.
    const runBat = `${LOCAL}/Source/Client/Run.bat`
    const client = await makeClient(
      {
        reconcile: (filespec) => {
          if (filespec === runBat) return [{ rel: 'Source/Client/Run.bat' }]
          if (filespec === `${LOCAL}/...`) return [{ rel: 'elsewhere.txt' }]
          return undefined
        },
      },
      undefined,
      undefined,
      { scopeFileExists: (p) => p === runBat },
    )
    // File-only focus: dirs empty, files=[Run.bat]. The recursive phase is
    // skipped entirely (no dirs-or-root fallback — that would re-walk the whole
    // depot); only the per-file phase runs, so the group never sees a row for
    // anything but the scope file.
    client.setReconcileScope([], [runBat])
    await client.runReconcileScan()

    const rendered = groupRows(client).map((r) => r.path)
    expect(rendered).toContain(runBat)
    expect(rendered).not.toContain(`${LOCAL}/elsewhere.txt`)
    // The root recursive filespec must not be scanned at all — that is the whole
    // point of file-only focus.
    expect(fullScanScans().some((a) => a.some((x) => x === `${LOCAL}/...`))).toBe(false)
  })

  it('an unfocused client still falls back to the whole-client root scan', async () => {
    // Regression: the files-only narrowing made the `[this.root]` fallback
    // conditional — and briefly conditioned it on dirs being non-empty, so an
    // UNFOCUSED client (both buckets empty) scanned nothing at all. Empty scope
    // sets mean the whole-client default, not "no scan". The production caller
    // (applyReconcileScope) passes `[root]` explicitly even when unfocused, so
    // this is the defence-in-depth branch: a client whose scope was never set
    // must still scan the whole client.
    const client = await makeClient({
      reconcile: (filespec) => (filespec === `${ROOT}/...` ? [{ rel: 'a.txt' }] : undefined),
    })
    await client.runReconcileScan()

    expect(fullScanScans().some((a) => a.some((x) => x === `${ROOT}/...`))).toBe(true)
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])
  })

  it('file-only focus skips the directory phase instead of falling back to the root', async () => {
    // Regression: `runReconcileScan` used to fall back to `[this.root]` whenever
    // `_reconcileScopeDirs` was empty — with a files-only focus that re-walked
    // the whole depot (minutes on a large workspace), the exact narrowing the
    // focus exists to avoid. Now an empty dirs set with non-empty files runs
    // only the per-file phase.
    const runBat = `${LOCAL}/Source/Client/Run.bat`
    const client = await makeClient(
      {
        reconcile: (filespec) => {
          if (filespec === runBat) return [{ rel: 'Source/Client/Run.bat' }]
          if (filespec === `${LOCAL}/...`) return [{ rel: 'elsewhere.txt' }]
          return undefined
        },
      },
      undefined,
      undefined,
      { scopeFileExists: (p) => p === runBat },
    )
    client.setReconcileScope([], [runBat])
    await client.runReconcileScan()

    // Zero recursive spawns — the root fallback is gone.
    expect(fullScanScans()).toHaveLength(0)
    // The per-file phase still ran and published the file's drift.
    expect(narrowScans().filter((a) => a.some((x) => x === runBat)).length).toBeGreaterThanOrEqual(
      1,
    )
    expect(groupRows(client)).toEqual([{ path: runBat, letter: 'RM' }])
  })

  it('a failed per-file query keeps the file drift row instead of reading it clean', async () => {
    // Regression: `_queryWorkingTreeRows` used to mark every requested path as
    // "covered" even when its batch failed to run — the apply step then deleted
    // the file's existing drift row, reading a failure as clean (the extension's
    // hard rule: a failed query logs, it never resolves as clean).
    const runBat = `${LOCAL}/Source/Client/Run.bat`
    let failQueries = false
    const make = () =>
      makeClient(
        {
          reconcile: (filespec) => {
            if (filespec === runBat && !failQueries) return [{ rel: 'Source/Client/Run.bat' }]
            return undefined
          },
          reconcileExit: (filespec) => (filespec === runBat && failQueries ? 1 : undefined),
          reconcileStderr: () => 'Connection refused',
        },
        undefined,
        undefined,
        { scopeFileExists: (p) => p === runBat },
      )
    const client = await make()
    client.setReconcileScope([], [runBat])
    await client.runReconcileScan()
    expect(groupRows(client)).toEqual([{ path: runBat, letter: 'RM' }])

    // Every subsequent per-file query fails: the drift row must SURVIVE.
    failQueries = true
    await client.runReconcileScan()
    expect(groupRows(client)).toEqual([{ path: runBat, letter: 'RM' }])
  })

  it('the scope gate matches a file by exact path, never a sibling prefix', async () => {
    // `Run.bat` must be answerable but `Run2.bat` refused at the scope gate — the
    // file counterpart of the directory boundary. `_queryWorkingTreeRows` drops an
    // out-of-scope path BEFORE spawning, so Run2 produces neither a spawn nor a hint.
    const runBat = `${LOCAL}/Source/Client/Run.bat`
    const run2 = `${LOCAL}/Source/Client/Run2.bat`
    const client = await makeClient({
      reconcile: (filespec) => {
        if (filespec === runBat) return [{ rel: 'Source/Client/Run.bat' }]
        if (filespec === run2) return [{ rel: 'Source/Client/Run2.bat' }]
        return undefined
      },
    })
    // Scope ONLY Run.bat.
    client.setReconcileScope([], [runBat])
    const hints = await client.checkWorkingTree([runBat, run2])

    // Only the exact scope file came back; Run2 was filtered pre-spawn.
    expect(hints.map((h) => h.path)).toEqual([runBat])
    expect(narrowScans().some((a) => a.some((x) => x === run2))).toBe(false)
  })

  // --- ⑥ cancellation ---------------------------------------------------------

  it('stops on cancel; completed checkpoints survive', async () => {
    const disk = fakeDisk()
    const client = await makeClient(
      {
        reconcile: (filespec) => {
          if (filespec === `${LOCAL}/A/...`) return [{ rel: 'in-a.txt' }]
          return undefined
        },
        reconcileHold: (filespec) => filespec === `${LOCAL}/B/...`,
      },
      disk,
    )
    client.setReconcileScope([`${LOCAL}/A`, `${LOCAL}/B`])

    const scan = client.runReconcileScan()
    // Wait until A's batch has landed (B is held open).
    await vi.waitFor(() => expect(disk.store.size).toBe(1))

    client.cancelBusy()
    await scan

    // A completed before the cancel: checkpoint + publish survive. B never
    // answered: un-checkpointed, unpublished, and the loop did not continue.
    const keys = [...disk.store.keys()]
    expect(keys).toHaveLength(1)
    expect(keys[0]).toContain(`${LOCAL}/A`)
    expect(scannedDirs(client)).toEqual([`${LOCAL}/A`])
    expect(driftFiles(client)).toEqual([`${LOCAL}/in-a.txt`])
    // The held child was killed exactly once.
    const held = reconcileScans().filter((a) => a.includes(`${LOCAL}/B/...`))
    expect(held).toHaveLength(1)
  })

  // --- ⑦ opened filter ---------------------------------------------------------

  it('filters files already opened at publish time', async () => {
    const disk = fakeDisk()
    const client = await makeClient(
      {
        opened: () => [{ rel: 'a.txt' }],
        reconcile: () => [{ rel: 'a.txt' }, { rel: 'b.txt' }],
      },
      disk,
    )
    await client.refresh()
    client.setReconcileScope([LOCAL])
    await client.runReconcileScan()

    // The opened file is filtered at query time; only the unopened one renders.
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/b.txt`, letter: 'RM' }])
  })

  // --- ⑧ background-only side effects -----------------------------------------

  it('is read-only towards the SCM view: never emits a change', async () => {
    const disk = fakeDisk()
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    client.setReconcileScope([LOCAL])
    let changes = 0
    const sc = (client as unknown as { _sc: { count: number | undefined } })._sc
    client.onDidChange(() => {
      changes++
    })

    await client.runReconcileScan()

    // The badge counts working-tree drift alongside opened files, so the scan's
    // one drift row lands in `sc.count` (no opened files → count === 1)...
    expect(sc.count).toBe(1)
    // ...but the scan never emits a change: the only emits are the status-bar
    // bookkeeping — busy label push/pop (2) plus cancellable
    // registration/deregistration (2) plus the scan-progress start and terminal
    // flush (2). No publish or checkpoint emits anything, and the throttled
    // intermediate frames never fire (the scan finishes within one throttle
    // window).
    expect(changes).toBe(6)
  })

  it('badge counts opened files plus working-tree drift', async () => {
    const disk = fakeDisk()
    const client = await makeClient(
      {
        opened: () => [{ rel: 'opened.txt' }],
        reconcile: () => [{ rel: 'drift-a.txt' }, { rel: 'drift-b.txt' }],
      },
      disk,
    )
    const sc = (client as unknown as { _sc: { count: number | undefined } })._sc

    await client.refresh()
    // 1 opened, no drift yet.
    expect(sc.count).toBe(1)

    client.setReconcileScope([LOCAL])
    await client.runReconcileScan()
    // 1 opened + 2 drift rows.
    expect(sc.count).toBe(3)
  })

  // --- ⑨ filespec escaping (M2) ----------------------------------------------

  it('escapes filespec metacharacters in directory names (@ and #)', async () => {
    const disk = fakeDisk()
    const dir = `${LOCAL}/assets@2x/UI#2`
    const client = await makeClient({ reconcile: () => [] }, disk)
    client.setReconcileScope([dir])

    await client.runReconcileScan()

    // p4 must receive the percent-escaped filespec — the raw `@`/`#` would be
    // re-interpreted as a revision range / wildcard and silently change the scope.
    const specs = reconcileScans().map((argv) => argv[argv.length - 1])
    expect(specs).toEqual([`${LOCAL}/assets%402x/UI%232/...`])
  })

  // --- ⑩ mutation invalidation (M1) -------------------------------------------

  it('a mutation drops the checkpoint of every directory covering the mutated path', async () => {
    const disk = fakeDisk()
    const sub1 = join(LOCAL, 'sub1')
    const sub2 = join(LOCAL, 'sub2')
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    client.setReconcileScope([sub1, sub2])
    await client.runReconcileScan()
    expect(disk.store.size).toBe(2)

    // The same invalidation `_mutate` runs after a successful mutation.
    ;(
      client as unknown as { _invalidateAfterMutation(paths: readonly string[]): void }
    )._invalidateAfterMutation([join(sub1, 'a.txt')])

    // The covering directory's checkpoint is gone (memory + disk); the sibling's
    // survives — a mutation must never read as a clean directory next session.
    const keys = [...disk.store.keys()]
    expect(keys.some((k) => k.includes('sub1'))).toBe(false)
    expect(keys.some((k) => k.includes('sub2'))).toBe(true)

    // And the invalidated directory is rescanned rather than served stale.
    await client.runReconcileScan()
    const sub1Scans = reconcileScans().filter((argv) =>
      (argv[argv.length - 1] ?? '').includes('sub1'),
    )
    const sub2Scans = reconcileScans().filter((argv) =>
      (argv[argv.length - 1] ?? '').includes('sub2'),
    )
    expect(sub1Scans).toHaveLength(2)
    expect(sub2Scans).toHaveLength(1)
  })

  it('a whole-workspace mutation clears the whole scan namespace', async () => {
    const disk = fakeDisk()
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    client.setReconcileScope([LOCAL])
    await client.runReconcileScan()
    expect(disk.store.size).toBe(1)

    // Empty paths = whole-client mutation (submit / sync) → the full-clear branch.
    ;(
      client as unknown as { _invalidateAfterMutation(paths: readonly string[]): void }
    )._invalidateAfterMutation([])

    expect(disk.store.size).toBe(0)
  })

  // --- ⑪ checkpoint freshness (M1) --------------------------------------------

  it('rescans a directory whose checkpoint is older than the freshness ceiling', async () => {
    const disk = fakeDisk()
    const clock = fakeClock()
    const first = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk, clock)
    first.setReconcileScope([LOCAL])
    await first.runReconcileScan()
    expect(reconcileScans()).toHaveLength(1)

    // Next session, 25h later: the stale checkpoint proves nothing about the
    // disk any more, so the directory is rescanned instead of replayed.
    clock.advance(25 * 60 * 60 * 1000)
    const second = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk, clock)
    second.setReconcileScope([LOCAL])
    await second.runReconcileScan()

    expect(reconcileScans()).toHaveLength(2)
    // The expired entry was replaced by the fresh one, not left to replay again.
    const entry = JSON.parse([...disk.store.values()][0]!) as { completedAt: number }
    expect(entry.completedAt).toBe(clock.now())
  })

  it('still serves a checkpoint within the freshness ceiling', async () => {
    const disk = fakeDisk()
    const clock = fakeClock()
    const first = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk, clock)
    first.setReconcileScope([LOCAL])
    await first.runReconcileScan()

    clock.advance(60 * 60 * 1000) // 1h — well within the ceiling
    const second = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk, clock)
    second.setReconcileScope([LOCAL])
    await second.runReconcileScan()

    expect(reconcileScans()).toHaveLength(1)
  })

  // --- ⑫ split checkpoint resume (M4) -----------------------------------------

  it('a split checkpoint resumes at the subdirectories next session without re-running the parent', async () => {
    const disk = fakeDisk()
    const clock = fakeClock()
    const make = (clientClock: ReturnType<typeof fakeClock>) =>
      makeClient(
        {
          reconcile: (filespec) => {
            const dir = filespec.replace(/[/\\]\.\.\.$/, '')
            if (dir === LOCAL) {
              clientClock.advance(20_000)
              return [{ rel: 'top.txt' }]
            }
            if (dir === join(LOCAL, 'sub1')) return [{ rel: 'sub1/a.txt' }]
            return []
          },
        },
        disk,
        clientClock,
      )
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === LOCAL)
        return ['sub1', 'sub2'].map((name) => ({
          name,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        }))
      return []
    })

    const first = await make(clock)
    first.setReconcileScope([LOCAL])
    await first.runReconcileScan()
    const firstScans = reconcileScans()

    // Next session: the parent's split marker makes the scan enqueue the
    // subdirectories directly — the slow parent batch is never re-run, and the
    // subdirectory checkpoints answer with zero p4 spawns.
    const second = await make(clock)
    second.setReconcileScope([LOCAL])
    await second.runReconcileScan()

    expect(reconcileScans()).toEqual(firstScans)
    // The parent's own hints are not double-published by the split replay: in the
    // first session the parent batch published top.txt and each subdirectory its
    // own; in the second session the parent is served from its split marker (which
    // re-enqueues only the subdirectories), so its LOCAL key never re-enters the
    // second client's per-directory index.
    expect(scannedDirs(first)).toEqual([LOCAL, join(LOCAL, 'sub1'), join(LOCAL, 'sub2')])
    expect(driftFiles(first).sort()).toEqual([`${LOCAL}/sub1/a.txt`, `${LOCAL}/top.txt`])
    expect(scannedDirs(second)).toEqual([join(LOCAL, 'sub1'), join(LOCAL, 'sub2')])
    expect(driftFiles(second).sort()).toEqual([`${LOCAL}/sub1/a.txt`])
  })

  // --- ⑬ offline mid-scan (M3) -------------------------------------------------

  it('going offline stops the scan, drops no checkpoints of unscanned dirs, and disarms', async () => {
    const disk = fakeDisk()
    let holdB = true
    const client = await makeClient(
      {
        reconcile: (filespec) => {
          if (filespec === `${LOCAL}/A/...`) return [{ rel: 'in-a.txt' }]
          return undefined
        },
        reconcileHold: (filespec) => filespec === `${LOCAL}/B/...` && holdB,
      },
      disk,
    )
    client.setReconcileScope([`${LOCAL}/A`, `${LOCAL}/B`, `${LOCAL}/C`])

    const scan = client.runReconcileScan()
    // A completed and checkpointed; B is held open.
    await vi.waitFor(() => expect(disk.store.size).toBe(1))
    ;(client as unknown as { _goOffline(kind: 'offline'): void })._goOffline('offline')
    await scan

    // B was aborted (the held child is killed, so the scan settles) and the loop
    // stopped before spawning C — no failure storm of doomed p4 processes.
    const specs = reconcileScans().map((argv) => argv[argv.length - 1])
    expect(specs).toContain(`${LOCAL}/B/...`)
    expect(specs).not.toContain(`${LOCAL}/C/...`)
    // Offline disarmed the scan so a reconnect can re-arm it...
    expect((client as unknown as { _reconcileScanArmed: boolean })._reconcileScanArmed).toBe(false)

    // ...and the refresh after a reconnect (opened succeeds again) re-arms and
    // picks up the un-scanned directories.
    holdB = false
    await client.refresh()
    await client.whenReconcileScanSettled()

    const specsAfter = reconcileScans().map((argv) => argv[argv.length - 1])
    expect(specsAfter).toContain(`${LOCAL}/C/...`)
  })

  // --- ⑭ batch ceiling clamp (M9) ----------------------------------------------

  it('clamps the batch ceiling to the manifest minimum (1000ms)', async () => {
    const disk = fakeDisk()
    const clock = fakeClock()
    // Only LOCAL has a subdirectory: the cold-prior count walks recursively,
    // so a mock answering "one more subdirectory" for EVERY path would never
    // terminate.
    readdirMock.mockImplementation(async (dir: string) =>
      dir === LOCAL
        ? ['sub'].map((name) => ({ name, isDirectory: () => true, isSymbolicLink: () => false }))
        : [],
    )
    const client = await makeClient(
      {
        reconcile: () => {
          clock.advance(500) // a genuinely fast batch
          return []
        },
      },
      disk,
      clock,
    )
    client.setReconcileScanOptions({ maxBatchDurationMs: 0 })
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    // 500ms < the clamped 1000ms ceiling → no split: the directory checkpoints
    // as a single batch. An unclamped 0 would split every batch (readdir storm).
    // The two readdirs are the cold-prior count walking LOCAL and its one
    // subdirectory; the split path never touched it.
    expect(readdirMock).toHaveBeenCalledTimes(2)
    expect(disk.store.size).toBe(1)
  })

  // --- ⑮ dispose aborts in-flight batches (M8) ---------------------------------

  it('dispose aborts an in-flight held batch', async () => {
    const disk = fakeDisk()
    const client = await makeClient({ reconcileHold: () => true }, disk)
    client.setReconcileScope([LOCAL])

    const scan = client.runReconcileScan()
    await vi.waitFor(() => expect(reconcileScans()).toHaveLength(1))

    client.dispose()
    // Settling at all is the assertion: without the dispose-time abort the held
    // child never closes and the scan would hang until the test times out.
    await scan

    expect(scannedDirs(client)).toEqual([])
    expect(driftFiles(client)).toEqual([])
    expect(disk.store.size).toBe(0)
  })

  // --- ⑯ scan progress ---------------------------------------------------------

  it('reports scan progress as batches finish (done rises, pending falls)', async () => {
    const disk = fakeDisk()
    const client = await makeClient(
      {
        reconcile: (filespec) =>
          filespec === `${LOCAL}/A/...` ? [{ rel: 'in-a.txt' }] : undefined,
        reconcileHold: (filespec) => filespec === `${LOCAL}/B/...`,
      },
      disk,
    )
    client.setReconcileScope([`${LOCAL}/A`, `${LOCAL}/B`])

    const scan = client.runReconcileScan()
    // A has finished and B is held in flight: done counted A, pending still holds
    // B, and the current directory renders relative to the client root.
    await vi.waitFor(() => {
      expect(client.status.scanProgress?.currentDir).toBe('B')
    })
    expect(client.status.scanProgress).toMatchObject({ done: 1, pending: 1, driftFound: 1 })

    client.cancelBusy()
    await scan
    expect(client.status.scanProgress).toBeUndefined()
  })

  it('splitting a slow batch grows pending and keeps done + pending monotonic', async () => {
    const disk = fakeDisk()
    const clock = fakeClock()
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === LOCAL)
        return ['sub1', 'sub2'].map((name) => ({
          name,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        }))
      return []
    })
    const client = await makeClient(
      {
        reconcile: (filespec) => {
          const dir = filespec.replace(/[/\\]\.\.\.$/, '')
          if (dir === LOCAL) {
            clock.advance(20_000)
            return [{ rel: 'top.txt' }]
          }
          return undefined
        },
        reconcileHold: (filespec) => filespec === `${join(LOCAL, 'sub1')}/...`,
      },
      disk,
      clock,
    )
    client.setReconcileScope([LOCAL])

    const frames: Array<{ done: number; pending: number }> = []
    client.onDidChange(() => {
      const sp = client.status.scanProgress
      if (sp) frames.push({ done: sp.done, pending: sp.pending })
    })

    const scan = client.runReconcileScan()
    // The slow parent split into two subdirectories: pending grew from 1 to 2.
    await vi.waitFor(() => {
      expect(client.status.scanProgress?.pending).toBe(2)
    })
    const mid = client.status.scanProgress!
    expect(mid.done).toBe(1)
    expect(mid.driftFound).toBe(1)
    expect(mid.currentDir).toBe('sub1')
    frames.push({ done: mid.done, pending: mid.pending })

    client.cancelBusy()
    await scan
    expect(client.status.scanProgress).toBeUndefined()

    // `done + pending` never shrinks across every observed frame (start 1 → split 3).
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]!.done + frames[i]!.pending).toBeGreaterThanOrEqual(
        frames[i - 1]!.done + frames[i - 1]!.pending,
      )
    }
    expect(frames.some((f) => f.done === 1 && f.pending === 2)).toBe(true)
  })

  it('clears scanProgress once a scan finishes normally', async () => {
    const disk = fakeDisk()
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    client.setReconcileScope([LOCAL])

    const frames: Array<{ done: number; pending: number }> = []
    client.onDidChange(() => {
      const sp = client.status.scanProgress
      if (sp) frames.push({ done: sp.done, pending: sp.pending })
    })

    await client.runReconcileScan()

    expect(frames[0]).toMatchObject({ done: 0, pending: 1 })
    expect(client.status.scanProgress).toBeUndefined()
  })

  it('accumulates driftFound from successful batches only (failed batches add nothing)', async () => {
    const disk = fakeDisk()
    const client = await makeClient(
      {
        reconcile: (filespec) => {
          if (filespec === `${LOCAL}/A/...`) return [{ rel: 'a1.txt' }, { rel: 'a2.txt' }]
          return undefined
        },
        reconcileExit: (filespec) => (filespec === `${LOCAL}/B/...` ? 1 : undefined),
        reconcileStderr: () => 'Connect to server failed; TCP connect failed',
        reconcileHold: (filespec) => filespec === `${LOCAL}/C/...`,
      },
      disk,
    )
    client.setReconcileScope([`${LOCAL}/A`, `${LOCAL}/B`, `${LOCAL}/C`])

    const scan = client.runReconcileScan()
    // A (2 drift files) and B (failed → no drift) are done; C is held in flight.
    await vi.waitFor(() => {
      expect(client.status.scanProgress?.done).toBe(2)
    })
    expect(client.status.scanProgress).toMatchObject({ done: 2, pending: 1, driftFound: 2 })

    client.cancelBusy()
    await scan
    expect(client.status.scanProgress).toBeUndefined()
  })

  it('clears scanProgress when the scan throws mid-publish', async () => {
    const disk = fakeDisk()
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    client.setReconcileScope([LOCAL])

    // The renderer's resourceStates setter is what sinks each publish; a throw
    // there is the "renderer died" signal the scan loop must not let leak.
    reconcileGroupThrow = true

    await expect(client.runReconcileScan()).rejects.toThrow('publish boom')
    expect(client.status.scanProgress).toBeUndefined()
  })

  it('resume from checkpoint starts done at 0 and counts cache-served directories', async () => {
    const disk = fakeDisk()
    // Session 1: A completes (checkpointed), B is held then cancelled (un-checkpointed).
    const first = await makeClient(
      {
        reconcile: (filespec) =>
          filespec === `${LOCAL}/A/...` ? [{ rel: 'in-a.txt' }] : undefined,
        reconcileHold: (filespec) => filespec === `${LOCAL}/B/...`,
      },
      disk,
    )
    first.setReconcileScope([`${LOCAL}/A`, `${LOCAL}/B`])
    const firstScan = first.runReconcileScan()
    await vi.waitFor(() => expect(disk.store.size).toBe(1))
    first.cancelBusy()
    await firstScan

    // Session 2: A is served from cache; B spawns again and is held so progress
    // is observable mid-scan.
    const second = await makeClient(
      {
        reconcile: (filespec) =>
          filespec === `${LOCAL}/B/...` ? [{ rel: 'in-b.txt' }] : undefined,
        reconcileHold: (filespec) => filespec === `${LOCAL}/B/...`,
      },
      disk,
    )
    second.setReconcileScope([`${LOCAL}/A`, `${LOCAL}/B`])
    const frames: Array<{ done: number; pending: number }> = []
    second.onDidChange(() => {
      const sp = second.status.scanProgress
      if (sp) frames.push({ done: sp.done, pending: sp.pending })
    })

    const secondScan = second.runReconcileScan()
    await vi.waitFor(() => {
      expect(second.status.scanProgress?.done).toBe(1)
    })
    // This run's progress starts at 0 (not the prior session's completed count)
    // and the cache-served A counts as done while B is still in flight.
    expect(frames[0]).toMatchObject({ done: 0, pending: 2 })
    expect(second.status.scanProgress).toMatchObject({ done: 1, pending: 1 })

    second.cancelBusy()
    await secondScan
    expect(second.status.scanProgress).toBeUndefined()
    // A was served from cache in session 2 (one spawn across both sessions); B,
    // never checkpointed, spawned in both.
    expect(reconcileScans().filter((a) => a.includes(`${LOCAL}/A/...`))).toHaveLength(1)
    expect(reconcileScans().filter((a) => a.includes(`${LOCAL}/B/...`))).toHaveLength(2)
  })

  // --- ⑰ partial recovery on timeout (M11) ------------------------------------

  it("publishes a timed-out batch's streamed hints and checkpoints a split marker, never a result", async () => {
    // A batch whose child streamed drift rows before the watchdog killed it must
    // keep those rows (they are a lower bound of drift found), publish them, and
    // split — but NEVER checkpoint them as a complete result, which would freeze
    // the un-scanned remainder as clean into later sessions.
    setP4CommandTimeoutSeconds(1)
    try {
      const disk = fakeDisk()
      const clock = fakeClock()
      readdirMock.mockImplementation(async (dir: string) => {
        if (dir === LOCAL)
          return ['sub1', 'sub2'].map((name) => ({
            name,
            isDirectory: () => true,
            isSymbolicLink: () => false,
          }))
        return []
      })
      const client = await makeClient(
        {
          reconcileTimeout: (filespec) =>
            filespec === `${LOCAL}/...` ? [{ rel: 'top.txt' }] : undefined,
          reconcile: (filespec) => {
            const dir = filespec.replace(/[/\\]\.\.\.$/, '')
            if (dir === join(LOCAL, 'sub1') || dir === join(LOCAL, 'sub2')) return []
            return undefined
          },
        },
        disk,
        clock,
      )
      client.setReconcileScope([LOCAL])

      await client.runReconcileScan()

      // The timed-out parent still publishes the drift it streamed…
      expect(scannedDirs(client)).toEqual([LOCAL, join(LOCAL, 'sub1'), join(LOCAL, 'sub2')])
      expect(groupRows(client)).toEqual([{ path: `${LOCAL}/top.txt`, letter: 'RM' }])
      expect(client.scanDriftByDir.get(LOCAL)).toHaveLength(1)
      expect(client.scanDriftByDir.get(join(LOCAL, 'sub1'))).toEqual([])
      expect(client.scanDriftByDir.get(join(LOCAL, 'sub2'))).toEqual([])
      // …but its checkpoint is the SPLIT marker (no files), not a result entry.
      const keys = [...disk.store.keys()]
      expect(keys).toHaveLength(3)
      const parentKey = keys.find((k) => k.includes('reconcileScan/') && !k.includes('sub'))
      expect(parentKey).toBeDefined()
      const parentEntry = JSON.parse(disk.store.get(parentKey!)!) as {
        split?: boolean
        files: unknown[]
      }
      expect(parentEntry.split).toBe(true)
      expect(parentEntry.files).toEqual([])
    } finally {
      setP4CommandTimeoutSeconds(600)
    }
  })

  it('leaves a timed-out batch with no subdirectories un-checkpointed (next session retries)', async () => {
    setP4CommandTimeoutSeconds(1)
    try {
      const disk = fakeDisk()
      const clock = fakeClock()
      readdirMock.mockImplementation(async () => []) // cannot split
      const client = await makeClient({ reconcileTimeout: () => [{ rel: 'top.txt' }] }, disk, clock)
      client.setReconcileScope([LOCAL])

      await client.runReconcileScan()

      // The streamed hints still publish…
      expect(scannedDirs(client)).toEqual([LOCAL])
      expect(groupRows(client)).toEqual([{ path: `${LOCAL}/top.txt`, letter: 'RM' }])
      // …but with no subdirectories to split into there is nothing to checkpoint:
      // neither a result (partial) nor a split marker.
      expect(disk.store.size).toBe(0)
    } finally {
      setP4CommandTimeoutSeconds(600)
    }
  })

  it('splits a timed-out batch even when nothing streamed before the kill (ceiling larger than commandTimeout)', async () => {
    // A timeout that recovered zero rows still proves the directory is too big:
    // if it only split via the elapsed > maxBatchDurationMs heuristic, a ceiling
    // larger than `perforce.commandTimeout` would leave the doomed parent
    // un-checkpointed and re-run it every session. It must split (and write a
    // split marker, never a result checkpoint) regardless of the ceiling.
    setP4CommandTimeoutSeconds(1)
    try {
      const disk = fakeDisk()
      const clock = fakeClock()
      readdirMock.mockImplementation(async (dir: string) => {
        if (dir === LOCAL)
          return [{ name: 'sub1', isDirectory: () => true, isSymbolicLink: () => false }]
        return []
      })
      const client = await makeClient(
        {
          reconcileTimeout: (filespec) => (filespec === `${LOCAL}/...` ? [] : undefined),
          reconcileDelayMs: (filespec) => (filespec === `${LOCAL}/...` ? 2000 : 0),
          reconcile: (filespec) => {
            const dir = filespec.replace(/[/\\]\.\.\.$/, '')
            return dir === join(LOCAL, 'sub1') ? [] : undefined
          },
        },
        disk,
        clock,
      )
      client.setReconcileScope([LOCAL])
      // 60s ceiling ≫ the 1s command timeout — the split can only come from the
      // timeout itself, not from elapsed outlasting the ceiling.
      client.setReconcileScanOptions({ maxBatchDurationMs: 60_000 })

      await client.runReconcileScan()

      // The zero-drift parent published nothing, but still wrote a split marker…
      expect(scannedDirs(client)).toEqual([join(LOCAL, 'sub1')])
      const keys = [...disk.store.keys()]
      expect(keys).toHaveLength(2)
      const parentKey = keys.find((k) => k.includes('reconcileScan/') && !k.includes('sub'))
      expect(parentKey).toBeDefined()
      const parentEntry = JSON.parse(disk.store.get(parentKey!)!) as {
        split?: boolean
        files: unknown[]
      }
      expect(parentEntry.split).toBe(true)
      expect(parentEntry.files).toEqual([])
      // …and the clean subdirectory checkpointed as a normal result (no split).
      const subKey = keys.find((k) => k.includes('reconcileScan/') && k.includes('sub'))
      expect(subKey).toBeDefined()
      const subEntry = JSON.parse(disk.store.get(subKey!)!) as { split?: boolean; files: unknown[] }
      expect(subEntry.split).toBeUndefined()
      expect(subEntry.files).toEqual([])
    } finally {
      setP4CommandTimeoutSeconds(600)
    }
  })

  // --- ⑱ budget prediction (pre-scan split) ---------------------------------

  it('pre-splits via the warm prior: an expired checkpoint with elapsedMs over the ceiling spawns zero parent batches', async () => {
    const disk = fakeDisk()
    const clock = fakeClock()
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === LOCAL)
        return ['sub1', 'sub2'].map((name) => ({
          name,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        }))
      return []
    })
    const make = () =>
      makeClient(
        {
          reconcileDelayMs: (filespec) => (filespec === `${LOCAL}/...` ? 20_000 : 0),
          reconcile: (filespec) => {
            const dir = filespec.replace(/[/\\]\.\.\.$/, '')
            if (dir === join(LOCAL, 'sub1')) return [{ rel: 'sub1/a.txt' }]
            return []
          },
        },
        disk,
        clock,
      )

    // Session 1: a slow-but-clean parent checkpoints a RESULT carrying the
    // measured elapsed as the warm prior (slow-but-clean is not split — yet).
    const first = await make()
    first.setReconcileScope([LOCAL])
    await first.runReconcileScan()
    const parentKey = [...disk.store.keys()].find((k) => !k.includes('sub'))
    expect(parentKey).toBeDefined()
    const firstEntry = JSON.parse(disk.store.get(parentKey!)!) as {
      elapsedMs?: number
      split?: boolean
    }
    expect(firstEntry.elapsedMs).toBe(20_000)
    expect(firstEntry.split).toBeUndefined()

    // Session 2, past the freshness ceiling: the expired entry's warm prior
    // pre-splits the parent — it never spawns again, the split marker
    // replaces the result, and the subdirectories scan + checkpoint on their
    // own.
    clock.advance(25 * 60 * 60 * 1000)
    const second = await make()
    second.setReconcileScope([LOCAL])
    await second.runReconcileScan()

    const parentSpecs = reconcileScans().filter((a) => a.includes(`${LOCAL}/...`))
    expect(parentSpecs).toHaveLength(1) // session 1 only
    const marker = JSON.parse(disk.store.get(parentKey!)!) as { split?: boolean; files: unknown[] }
    expect(marker.split).toBe(true)
    expect(marker.files).toEqual([])
    // Each client owns its own drift state: session 1 saw the clean parent (its
    // slow-but-clean result, not a split), session 2's pre-split never accepted
    // the parent and saw only the subdirectories.
    expect(scannedDirs(first)).toEqual([LOCAL])
    expect(scannedDirs(second)).toEqual([join(LOCAL, 'sub1'), join(LOCAL, 'sub2')])
    expect(groupRows(second)).toEqual([{ path: `${LOCAL}/sub1/a.txt`, letter: 'RM' }])
    expect(disk.store.size).toBe(3)
  })

  it('still runs the batch when the warm prior fits the ceiling (no false pre-split)', async () => {
    const disk = fakeDisk()
    const clock = fakeClock()
    const make = () => makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk, clock)

    // Session 1: a fast batch checkpoints a small warm prior.
    const first = await make()
    first.setReconcileScope([LOCAL])
    await first.runReconcileScan()
    expect(reconcileScans()).toHaveLength(1)

    // Session 2, past the freshness ceiling: the expired entry's warm prior
    // is under the ceiling, so the directory rescans as one normal batch —
    // the measurement shields it from any size estimate.
    clock.advance(25 * 60 * 60 * 1000)
    const second = await make()
    second.setReconcileScope([LOCAL])
    await second.runReconcileScan()

    expect(reconcileScans()).toHaveLength(2)
    expect(disk.store.size).toBe(1)
    const entry = JSON.parse([...disk.store.values()][0]!) as { split?: boolean }
    expect(entry.split).toBeUndefined()
  })

  it('pre-splits a never-scanned directory whose local file count exceeds the threshold', async () => {
    const disk = fakeDisk()
    const overThreshold = Array.from(
      { length: RECONCILE_SCAN_PRESPLIT_FILE_COUNT_THRESHOLD + 1 },
      (_, i) => ({ name: `f${i}.bin`, isDirectory: () => false }),
    )
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === LOCAL)
        return [
          { name: 'sub1', isDirectory: () => true, isSymbolicLink: () => false },
          ...overThreshold,
        ]
      return []
    })
    const client = await makeClient(
      {
        reconcile: (filespec) => {
          const dir = filespec.replace(/[/\\]\.\.\.$/, '')
          if (dir === join(LOCAL, 'sub1')) return [{ rel: 'sub1/a.txt' }]
          return []
        },
      },
      disk,
    )
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    // The parent batch never ran — only the subdirectory's did.
    expect(reconcileScans().map((a) => a[a.length - 1])).toEqual([`${join(LOCAL, 'sub1')}/...`])
    // The parent checkpoints the split marker (its batch never produced a
    // result); the subdirectory checkpoints its own result and publishes.
    const keys = [...disk.store.keys()]
    expect(keys).toHaveLength(2)
    const parentKey = keys.find((k) => !k.includes('sub'))
    const parentEntry = JSON.parse(disk.store.get(parentKey!)!) as {
      split?: boolean
      files: unknown[]
    }
    expect(parentEntry.split).toBe(true)
    expect(parentEntry.files).toEqual([])
    const subEntry = JSON.parse(disk.store.get(keys.find((k) => k.includes('sub'))!)!) as {
      split?: boolean
      files: unknown[]
    }
    expect(subEntry.split).toBeUndefined()
    expect(subEntry.files).toHaveLength(1)
    expect(scannedDirs(client)).toEqual([join(LOCAL, 'sub1')])
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/sub1/a.txt`, letter: 'RM' }])
    // Early exit: the count stopped inside LOCAL's own listing and never
    // descended into sub1 — the third readdir is sub1's OWN cold count after
    // it was enqueued, not part of the parent's.
    expect(readdirMock.mock.calls.map((c) => c[0])).toEqual([LOCAL, LOCAL, join(LOCAL, 'sub1')])
  })

  it('still runs the batch when the cold file count is under the threshold (no false pre-split)', async () => {
    const disk = fakeDisk()
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === LOCAL)
        return [
          { name: 'sub1', isDirectory: () => true, isSymbolicLink: () => false },
          ...Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, isDirectory: () => false })),
        ]
      return []
    })
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    expect(reconcileScans()).toHaveLength(1)
    expect(reconcileScans()[0]![reconcileScans()[0]!.length - 1]).toBe(`${LOCAL}/...`)
    expect(disk.store.size).toBe(1)
    const entry = JSON.parse([...disk.store.values()][0]!) as { split?: boolean }
    expect(entry.split).toBeUndefined()
  })

  it('falls back to a normal batch when the cold count cannot read the directory', async () => {
    const disk = fakeDisk()
    readdirMock.mockImplementation(async () => {
      throw new Error('EPERM')
    })
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    // An unreadable count degrades to a normal scan — the prediction is an
    // optimization, never a gate (same fail-open tolerance as _listSubdirs).
    expect(reconcileScans()).toHaveLength(1)
    expect(disk.store.size).toBe(1)
  })

  it('falls back to a normal batch when a predicted split finds no subdirectories', async () => {
    const disk = fakeDisk()
    // Over the threshold in files but not one subdirectory to split into —
    // the prediction degrades to the normal batch, exactly like a post-hoc
    // split that finds nothing.
    const overThreshold = Array.from(
      { length: RECONCILE_SCAN_PRESPLIT_FILE_COUNT_THRESHOLD + 1 },
      (_, i) => ({ name: `f${i}.bin`, isDirectory: () => false }),
    )
    readdirMock.mockImplementation(async (dir: string) => (dir === LOCAL ? overThreshold : []))
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    expect(reconcileScans()).toHaveLength(1)
    expect(reconcileScans()[0]![reconcileScans()[0]!.length - 1]).toBe(`${LOCAL}/...`)
    expect(disk.store.size).toBe(1)
    const entry = JSON.parse([...disk.store.values()][0]!) as { split?: boolean }
    expect(entry.split).toBeUndefined()
  })

  it('compares the warm prior against the CURRENT ceiling (a raised ceiling un-splits)', async () => {
    const disk = fakeDisk()
    const clock = fakeClock()
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === LOCAL)
        return ['sub1'].map((name) => ({
          name,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        }))
      return []
    })
    const make = () =>
      makeClient(
        {
          reconcileDelayMs: (filespec) => (filespec === `${LOCAL}/...` ? 20_000 : 0),
          reconcile: () => [],
        },
        disk,
        clock,
      )

    // Session 1: a 20s batch → warm prior 20000 (over the default 10s ceiling).
    const first = await make()
    first.setReconcileScope([LOCAL])
    await first.runReconcileScan()
    expect(reconcileScans()).toHaveLength(1)

    // Session 2, past the freshness ceiling, with a raised ceiling: the
    // measurement is compared against the CURRENT budget, 20000 ≤ 60000 fits,
    // so the directory rescans as one normal batch instead of pre-splitting.
    clock.advance(25 * 60 * 60 * 1000)
    const second = await make()
    second.setReconcileScanOptions({ maxBatchDurationMs: 60_000 })
    second.setReconcileScope([LOCAL])
    await second.runReconcileScan()

    expect(reconcileScans()).toHaveLength(2)
    expect(disk.store.size).toBe(1)
    const entry = JSON.parse([...disk.store.values()][0]!) as { split?: boolean }
    expect(entry.split).toBeUndefined()
  })

  it('degrades to the cold prior for checkpoints written before elapsedMs existed', async () => {
    const disk = fakeDisk()
    const clock = fakeClock()
    const first = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk, clock)
    first.setReconcileScope([LOCAL])
    await first.runReconcileScan()
    expect(reconcileScans()).toHaveLength(1)

    // Strip the warm prior from the stored entry, simulating a checkpoint
    // written by an older build.
    const key = [...disk.store.keys()][0]!
    const legacy = JSON.parse(disk.store.get(key)!) as Record<string, unknown>
    delete legacy.elapsedMs
    disk.store.set(key, JSON.stringify(legacy))

    // Past the freshness ceiling: no warm prior → the cold count answers
    // instead (0 files here) and the directory rescans normally, re-earning
    // its warm prior.
    clock.advance(25 * 60 * 60 * 1000)
    const second = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk, clock)
    second.setReconcileScope([LOCAL])
    await second.runReconcileScan()

    expect(reconcileScans()).toHaveLength(2)
    // One cold count per session: the legacy entry furnishes no warm prior,
    // so session 2 must take the cold path (a warm prior would skip the
    // count and leave just session 1's).
    expect(readdirMock).toHaveBeenCalledTimes(2)
    const entry = JSON.parse(disk.store.get(key)!) as { elapsedMs?: number }
    expect(entry.elapsedMs).toBeTypeOf('number')
  })

  // --- ⑲ excluded directories (M12) ------------------------------------------

  it('skips an excluded scope subdirectory: not scanned, not published, not checkpointed', async () => {
    const disk = fakeDisk()
    const client = await makeClient(
      {
        reconcile: (filespec) => {
          if (filespec === `${LOCAL}/included/...`) return [{ rel: 'included/a.txt' }]
          if (filespec === `${LOCAL}/excluded/...`) return [{ rel: 'excluded/b.txt' }]
          return undefined
        },
      },
      disk,
    )
    client.setReconcileScope([`${LOCAL}/included`, `${LOCAL}/excluded`])
    client.setReconcileExcludes([`${LOCAL}/excluded`])

    await client.runReconcileScan()

    // Only the included directory is scanned and published; the excluded one
    // never reaches p4 (zero spawn for it) and leaves no checkpoint.
    const specs = reconcileScans().map((a) => a[a.length - 1])
    expect(specs).toEqual([`${LOCAL}/included/...`])
    expect(scannedDirs(client)).toEqual([`${LOCAL}/included`])
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/included/a.txt`, letter: 'RM' }])
    const keys = [...disk.store.keys()]
    expect(keys.some((k) => k.includes('included'))).toBe(true)
    expect(keys.some((k) => k.includes('excluded'))).toBe(false)
  })

  it('exits safely when the scope directory itself is excluded', async () => {
    const disk = fakeDisk()
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    client.setReconcileScope([LOCAL])
    client.setReconcileExcludes([LOCAL])

    await client.runReconcileScan()

    // Nothing to scan: no p4 spawn, no publish, no checkpoint.
    expect(reconcileScans()).toHaveLength(0)
    expect(scannedDirs(client)).toEqual([])
    expect(groupRows(client)).toEqual([])
    expect(disk.store.size).toBe(0)
  })

  it('an exclude change invalidates the checkpoint (different fingerprint)', async () => {
    const disk = fakeDisk()
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    client.setReconcileScope([LOCAL])
    await client.runReconcileScan()
    expect(reconcileScans()).toHaveLength(1)

    // The scope is unchanged but the exclusions change: the fingerprint must
    // change, or the directory would replay a checkpoint that answered a scan
    // that did NOT exclude anything.
    client.setReconcileExcludes([`${LOCAL}/ignored`])
    await client.runReconcileScan()

    // A new spawn proves the old checkpoint was orphaned rather than replayed.
    expect(reconcileScans()).toHaveLength(2)
  })

  it('does not enqueue an excluded subdirectory when splitting a slow batch', async () => {
    const disk = fakeDisk()
    const clock = fakeClock()
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === LOCAL)
        return ['included', 'excluded'].map((name) => ({
          name,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        }))
      return []
    })
    const client = await makeClient(
      {
        reconcile: (filespec) => {
          const dir = filespec.replace(/[/\\]\.\.\.$/, '')
          if (dir === LOCAL) {
            // The exclude lands mid-scan (hot config reload), after the queue
            // was built and after the carve decision for LOCAL — the split
            // below is what must filter it out.
            client.setReconcileExcludes([join(LOCAL, 'excluded')])
            clock.advance(20_000)
            return [{ rel: 'top.txt' }]
          }
          if (dir === join(LOCAL, 'included')) return [{ rel: 'included/a.txt' }]
          return undefined
        },
      },
      disk,
      clock,
    )
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    // The slow parent publishes and splits, but the excluded subdirectory is
    // filtered out of the split — only `included` is enqueued and scanned.
    expect(scannedDirs(client)).toEqual([LOCAL, join(LOCAL, 'included')])
    expect(groupRows(client)).toEqual([
      { path: `${LOCAL}/included/a.txt`, letter: 'RM' },
      { path: `${LOCAL}/top.txt`, letter: 'RM' },
    ])
    const specs = reconcileScans().map((a) => a[a.length - 1])
    expect(specs).toContain(`${join(LOCAL, 'included')}/...`)
    expect(specs).not.toContain(`${join(LOCAL, 'excluded')}/...`)
    const keys = [...disk.store.keys()]
    expect(keys.some((k) => k.includes('included'))).toBe(true)
    expect(keys.some((k) => k.includes('excluded'))).toBe(false)
  })

  it('carves a directory containing an excluded subtree instead of scanning it recursively', async () => {
    const disk = fakeDisk()
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === LOCAL)
        return [
          { name: 'top.txt', isDirectory: () => false, isSymbolicLink: () => false },
          { name: 'src', isDirectory: () => true, isSymbolicLink: () => false },
        ]
      if (dir === join(LOCAL, 'src'))
        return ['included', 'excluded'].map((name) => ({
          name,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        }))
      return []
    })
    const client = await makeClient({ reconcile: () => [{ rel: 'top.txt' }] }, disk)
    client.setReconcileScope([LOCAL])
    client.setReconcileExcludes([join(LOCAL, 'src', 'excluded')])

    await client.runReconcileScan()

    // One spawn, carved into the level's `/*` plus the clean subtree's `/...`:
    // a recursive parent filespec would drag the excluded subtree back into
    // p4's traversal, which is the bug this locks out.
    const scans = reconcileScans()
    expect(scans).toHaveLength(1)
    const argv = scans[0]!
    expect(argv).toContain(`${LOCAL}/*`)
    expect(argv).toContain(`${join(LOCAL, 'src')}/*`)
    expect(argv).toContain(`${join(LOCAL, 'src', 'included')}/...`)
    expect(argv).not.toContain(`${LOCAL}/...`)
    expect(argv.some((a) => a.includes('excluded'))).toBe(false)
  })

  it('a carved scan keeps the one-publish-per-directory shape and checkpoints once', async () => {
    const disk = fakeDisk()
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === LOCAL)
        return [{ name: 'src', isDirectory: () => true, isSymbolicLink: () => false }]
      if (dir === join(LOCAL, 'src'))
        return ['included', 'excluded'].map((name) => ({
          name,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        }))
      return []
    })
    const client = await makeClient({ reconcile: () => [{ rel: 'src/included/a.txt' }] }, disk)
    client.setReconcileScope([LOCAL])
    client.setReconcileExcludes([join(LOCAL, 'src', 'excluded')])

    await client.runReconcileScan()

    // The carve only swaps the filespec list — it must not change the
    // per-directory shape: one publish for LOCAL and one checkpoint.
    expect(scannedDirs(client)).toEqual([LOCAL])
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/src/included/a.txt`, letter: 'RM' }])
    expect(disk.store.size).toBe(1)
  })

  it('leaves a directory un-checkpointed when carving fails', async () => {
    const disk = fakeDisk()
    readdirMock.mockImplementation(async () => {
      throw new Error('readdir boom')
    })
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    client.setReconcileScope([LOCAL])
    client.setReconcileExcludes([join(LOCAL, 'src', 'excluded')])

    await client.runReconcileScan()

    // A failed carve has no safe fallback (the recursive filespec would
    // re-breach the exclusion) and must not checkpoint anything: a split
    // marker would pretend the scan can resume, an empty result would pretend
    // the directory is clean. The next session retries it.
    expect(reconcileScans()).toHaveLength(0)
    expect(scannedDirs(client)).toEqual([])
    expect(groupRows(client)).toEqual([])
    expect(disk.store.size).toBe(0)
  })

  it('filters excluded-directory rows at publish time even when p4 reports them', async () => {
    const disk = fakeDisk()
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === LOCAL)
        return [{ name: 'src', isDirectory: () => true, isSymbolicLink: () => false }]
      if (dir === join(LOCAL, 'src'))
        return ['included', 'excluded'].map((name) => ({
          name,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        }))
      return []
    })
    const client = await makeClient(
      {
        // p4 reports drift inside the excluded directory anyway — a path shape
        // the carve doesn't cover, or p4's own matching behavior. The publish
        // filter is the guarantee that drops it.
        reconcile: () => [{ rel: 'src/included/a.txt' }, { rel: 'src/excluded/bad.txt' }],
      },
      disk,
    )
    client.setReconcileScope([LOCAL])
    client.setReconcileExcludes([join(LOCAL, 'src', 'excluded')])

    await client.runReconcileScan()

    // The excluded row is dropped at assembly time. The per-directory index still
    // keeps the key (its contribution to the set is real), so this must assert on
    // the rendered group, not scanDriftByDir.
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/src/included/a.txt`, letter: 'RM' }])
    expect(scannedDirs(client)).toEqual([LOCAL])
  })

  it('skips a directory excluded mid-scan after the queue was built', async () => {
    const disk = fakeDisk()
    const client = await makeClient(
      {
        reconcile: (filespec) => {
          if (filespec === `${join(LOCAL, 'A')}/...`) {
            // Hot config reload while the scan is in flight: B becomes
            // excluded after the queue was already built from the scope, so
            // enqueue-time filtering can't see it.
            client.setReconcileExcludes([join(LOCAL, 'B')])
            return [{ rel: 'A/a.txt' }]
          }
          if (filespec === `${join(LOCAL, 'B')}/...`) return [{ rel: 'B/b.txt' }]
          return undefined
        },
      },
      disk,
    )
    client.setReconcileScope([join(LOCAL, 'A'), join(LOCAL, 'B')])

    await client.runReconcileScan()

    // B never reaches p4, publishes nothing and leaves no checkpoint.
    const specs = reconcileScans().map((a) => a[a.length - 1])
    expect(specs).toEqual([`${join(LOCAL, 'A')}/...`])
    expect(scannedDirs(client)).toEqual([join(LOCAL, 'A')])
    expect([...disk.store.keys()].some((k) => k.includes('B'))).toBe(false)
  })

  // --- ⑳ external-change watcher (M13) ---------------------------------------

  it('an external file change queries only the changed file, never the whole directory', async () => {
    const disk = fakeDisk()
    const wt = makeFakeWatcher()
    const client = await makeClient(
      // Drift is reported for whatever concrete file is asked about, so the
      // assertion below proves the argv carried `a.txt` rather than matching a
      // fixture the fake would have returned for any filespec.
      { reconcile: (spec) => (spec.endsWith('a.txt') ? [{ rel: 'a.txt' }] : []) },
      disk,
      fakeClock(),
      { createFileSystemWatcher: () => wt.watcher, watchRoot: ROOT, externalChangeDebounceMs: 0 },
    )
    client.setReconcileScope([LOCAL])

    // Session scan: clean → checkpointed as a (clean) result.
    client.scheduleReconcileScan()
    await client.whenReconcileScanSettled()
    expect(fullScanScans()).toHaveLength(1)
    expect(client.scanDriftByDir.get(LOCAL) ?? []).toEqual([])
    const firstEntry = [...disk.store.entries()].find(([k]) => k.endsWith(LOCAL))
    const firstCompletedAt = (JSON.parse(firstEntry![1]) as { completedAt: number }).completedAt

    // An external tool edits a file under the directory (git checkout, another
    // editor). The watcher answers with ONE narrow query about that exact file —
    // re-walking `<dir>/...` for a signal that already names the file is the cost
    // this design exists to avoid.
    wt.fire('change', `${LOCAL}/a.txt`)
    await nextMacrotask()
    await client.whenExternalFlushSettled()

    expect(fullScanScans()).toHaveLength(1)
    expect(narrowScans()).toHaveLength(1)
    expect(narrowScans()[0]).toContain(`${LOCAL}/a.txt`)
    // A watcher flush does NOT flush the reconcile group, so assert on the
    // synchronous drift maps here.
    expect(driftFiles(client)).toContain(`${LOCAL}/a.txt`)
    // The covering checkpoint is corrected in place, not dropped: the narrow
    // query's answer is authoritative for the paths it covered, so the next
    // session replays a checkpoint that already knows `a.txt` drifts. Dropping it
    // is what made every save cost the next workspace open a full re-walk.
    const entry = [...disk.store.entries()].find(([k]) => k.endsWith(LOCAL))
    expect(entry).toBeDefined()
    const patched = JSON.parse(entry![1]) as {
      completedAt: number
      files: readonly { clientFile?: string }[]
    }
    expect(patched.files.map((f) => f.clientFile)).toEqual([`${LOCAL}/a.txt`])
    // completedAt is the freshness anchor: renewing it on every save would keep
    // the 24h window sliding forward forever and truly stale data would never
    // expire.
    expect(patched.completedAt).toBe(firstCompletedAt)
  })

  it('folds a watcher-reported path into the clientRoot spelling before it lands', async () => {
    // The watcher's flush echoes rows back in the spelling the caller asked
    // with — the opened folder's (`x:/P4WS/main/...`), while the drift group's
    // resourceUris and mutation arguments must be the p4-reported clientRoot
    // spelling (`X:/p4ws/main/...`). On Windows the two differ only by case, so
    // the folded row must be respelled before it lands in `_driftFiles` / the
    // checkpoint: a resourceUri the case-sensitive `p4 opened <filespec>`
    // cannot match is what made SCM-directory Revert a silent no-op.
    if (process.platform !== 'win32') return
    const disk = fakeDisk()
    const wt = makeFakeWatcher()
    const client = await makeClient(
      { reconcile: () => [{ rel: 'a.txt', action: 'edit' }] },
      disk,
      fakeClock(),
      {
        createFileSystemWatcher: () => wt.watcher,
        watchRoot: ROOT,
        externalChangeDebounceMs: 0,
      },
    )
    client.setReconcileScope([LOCAL])
    client.scheduleReconcileScan()
    await client.whenReconcileScanSettled()

    wt.fire('change', 'x:/P4WS/main/a.txt')
    await nextMacrotask()
    await client.whenExternalFlushSettled()

    expect(driftFiles(client)).toEqual([`${LOCAL}/a.txt`])
    const entry = [...disk.store.entries()].find(([k]) => k.endsWith(LOCAL))
    expect(entry).toBeDefined()
    const patched = JSON.parse(entry![1]) as { files: readonly { clientFile?: string }[] }
    expect(patched.files.map((f) => f.clientFile)).toEqual([`${LOCAL}/a.txt`])
  })

  it('coalesces a bulk external change into one batched narrow query', async () => {
    const wt = makeFakeWatcher()
    const client = await makeClient({ reconcile: () => [] }, fakeDisk(), fakeClock(), {
      createFileSystemWatcher: () => wt.watcher,
      watchRoot: ROOT,
      externalChangeDebounceMs: 0,
    })
    client.setReconcileScope([LOCAL])
    client.scheduleReconcileScan()
    await client.whenReconcileScanSettled()
    expect(fullScanScans()).toHaveLength(1)

    // A bulk external change floods hundreds of events; the debounce folds them
    // into ONE flush, which the argv budget then splits into a handful of
    // batches — never one spawn per event, and never a directory re-walk.
    const fired = 600
    for (let i = 0; i < fired; i++) wt.fire('change', `${LOCAL}/f${i}.txt`)
    await nextMacrotask()
    await client.whenExternalFlushSettled()

    expect(fullScanScans()).toHaveLength(1)
    const narrow = narrowScans()
    expect(narrow.length).toBeGreaterThan(1) // batched by the argv budget…
    expect(narrow.length).toBeLessThan(20) // …not one spawn per event
    // Batching loses nothing: every fired path was asked about exactly once — by
    // its bare spec, plus the `<path>/...` companion every path that is gone from
    // disk carries (which case deleted it is unknowable from a path that is not
    // there, so both specs ride along).
    const specs = narrow.flat().filter((a) => a.startsWith(`${LOCAL}/f`))
    expect(new Set(specs.filter((s) => !WILDCARD_SPEC.test(s))).size).toBe(fired)
    expect(specs.filter((s) => WILDCARD_SPEC.test(s))).toHaveLength(fired)
  })

  it('degrades to invalidate-only past the narrow-query budget', async () => {
    const disk = fakeDisk()
    const wt = makeFakeWatcher()
    const client = await makeClient({ reconcile: () => [] }, disk, fakeClock(), {
      createFileSystemWatcher: () => wt.watcher,
      watchRoot: ROOT,
      externalChangeDebounceMs: 0,
    })
    client.setReconcileScope([LOCAL])
    client.scheduleReconcileScan()
    await client.whenReconcileScanSettled()
    expect(fullScanScans()).toHaveLength(1)
    expect([...disk.store.keys()].some((k) => k.endsWith(LOCAL))).toBe(true)

    // Switching a big branch reports tens of thousands of paths: past the budget
    // the narrow query would itself become hundreds of spawns, so the flush only
    // invalidates and leaves the tints to the next scan. Neither a narrow query
    // nor a directory re-walk is spawned.
    for (let i = 0; i <= 2000; i++) wt.fire('change', `${LOCAL}/f${i}.txt`)
    await nextMacrotask()
    await client.whenExternalFlushSettled()

    expect(narrowScans()).toHaveLength(0)
    expect(fullScanScans()).toHaveLength(1)
    expect([...disk.store.keys()].some((k) => k.endsWith(LOCAL))).toBe(false)
  })

  it('redoes the invalidation after a scan round that was in flight settles', async () => {
    const disk = fakeDisk()
    const wt = makeFakeWatcher()
    let hold = true
    const client = await makeClient(
      { reconcile: () => [], reconcileHold: (spec) => hold && spec.endsWith('/...') },
      disk,
      fakeClock(),
      { createFileSystemWatcher: () => wt.watcher, watchRoot: ROOT, externalChangeDebounceMs: 0 },
    )
    client.setReconcileScope([LOCAL])
    client.scheduleReconcileScan()
    await nextMacrotask()

    // The change lands while the round is mid-flight, so there is no checkpoint on
    // disk yet for the flush to correct — patching cannot fence a key that does
    // not exist, and the round's eventual write comes from a read that PREDATES
    // the change. The latch therefore invalidates on settle. Only the
    // invalidation is replayed — never a second round.
    wt.fire('change', `${LOCAL}/a.txt`)
    await nextMacrotask()
    await client.whenExternalFlushSettled()
    hold = false
    releaseHeld()
    await client.whenReconcileScanSettled()

    expect(fullScanScans()).toHaveLength(1)
    expect([...disk.store.keys()].some((k) => k.endsWith(LOCAL))).toBe(false)
  })

  it('keeps a checkpoint the flush patched, even when an in-flight round settles', async () => {
    const disk = fakeDisk()
    const wt = makeFakeWatcher()
    const clock = fakeClock()
    // Two scope dirs. B's batch is made to finish later than A's (reconcileDelayMs
    // advances the injected clock), so after a 24h advance A is stale and gets
    // rescanned while B is still fresh and patchable.
    const dirA = `${LOCAL}/A`
    const dirB = `${LOCAL}/B`
    let holdScan = false
    const client = await makeClient(
      {
        reconcile: (spec) => (spec.endsWith('b.txt') ? [{ rel: 'B/b.txt' }] : []),
        reconcileDelayMs: (spec) => (spec.endsWith('/B/...') ? 10000 : 0),
        reconcileHold: (spec) => holdScan && spec.endsWith('/A/...'),
      },
      disk,
      clock,
      { createFileSystemWatcher: () => wt.watcher, watchRoot: ROOT, externalChangeDebounceMs: 0 },
    )
    client.setReconcileScope([dirA, dirB])

    // Session 1: clean scan → both directories checkpointed. B's checkpoint is
    // written 5s later than A's.
    client.scheduleReconcileScan()
    await client.whenReconcileScanSettled()
    expect(fullScanScans()).toHaveLength(2)
    expect([...disk.store.keys()].some((k) => k.endsWith(dirA))).toBe(true)
    expect([...disk.store.keys()].some((k) => k.endsWith(dirB))).toBe(true)

    // A's checkpoint now ages out past the 24h ceiling; B's stays fresh. Round 2
    // therefore rescans A and holds its batch open, in flight.
    clock.advance(24 * 60 * 60 * 1000)
    ;(client as unknown as { _reconcileScanArmed: boolean })._reconcileScanArmed = false
    holdScan = true
    client.scheduleReconcileScan()
    await nextMacrotask()

    // An external change lands in B while the round is still held on A. Its flush
    // queries B's file and patches B's (still-fresh) checkpoint in place.
    wt.fire('change', `${LOCAL}/B/b.txt`)
    await nextMacrotask()
    await client.whenExternalFlushSettled()
    const entry = [...disk.store.entries()].find(([k]) => k.endsWith(dirB))
    expect(entry).toBeDefined()
    expect(
      (JSON.parse(entry![1]) as { files: readonly { clientFile?: string }[] }).files.map(
        (f) => f.clientFile,
      ),
    ).toEqual([`${LOCAL}/B/b.txt`])
    // completedAt is the freshness anchor: renewing it would slide the 24h window
    // forever and truly stale data would never expire.
    expect((JSON.parse(entry![1]) as { completedAt: number }).completedAt).toBe(11000)

    // The held round settles (it reaches B, serves the patched checkpoint, then
    // re-invalidates the latched path). It must NOT drop the patched checkpoint:
    // the patch already corrected it, and dropping it forces the next session to
    // re-walk the whole directory (the Bug D regression).
    holdScan = false
    releaseHeld()
    await client.whenReconcileScanSettled()

    const after = [...disk.store.entries()].find(([k]) => k.endsWith(dirB))
    expect(after).toBeDefined()
    expect(
      (JSON.parse(after![1]) as { files: readonly { clientFile?: string }[] }).files.map(
        (f) => f.clientFile,
      ),
    ).toEqual([`${LOCAL}/B/b.txt`])
  })

  it('remembers a patch across a second flush before the round settles', async () => {
    // The patched-path set must live as long as the latch set does — from the
    // latch to the round's settle — not be reset per flush. Two saves land while
    // one round is held: the first patches B's checkpoint, the second touches A,
    // whose checkpoint the held round already dropped as expired, so that flush
    // patches nothing. If the set were cleared at the top of each flush, the
    // second would erase the first's record and the settle-time replay would
    // drop B's checkpoint anyway — the full re-walk this branch exists to avoid.
    const disk = fakeDisk()
    const wt = makeFakeWatcher()
    const clock = fakeClock()
    const dirA = `${LOCAL}/A`
    const dirB = `${LOCAL}/B`
    let holdScan = false
    const client = await makeClient(
      {
        reconcile: (spec) => (spec.endsWith('b.txt') ? [{ rel: 'B/b.txt' }] : []),
        reconcileDelayMs: (spec) => (spec.endsWith('/B/...') ? 10000 : 0),
        reconcileHold: (spec) => holdScan && spec.endsWith('/A/...'),
      },
      disk,
      clock,
      { createFileSystemWatcher: () => wt.watcher, watchRoot: ROOT, externalChangeDebounceMs: 0 },
    )
    client.setReconcileScope([dirA, dirB])

    client.scheduleReconcileScan()
    await client.whenReconcileScanSettled()
    expect([...disk.store.keys()].some((k) => k.endsWith(dirB))).toBe(true)

    clock.advance(24 * 60 * 60 * 1000)
    ;(client as unknown as { _reconcileScanArmed: boolean })._reconcileScanArmed = false
    holdScan = true
    client.scheduleReconcileScan()
    await nextMacrotask()

    // First save: patches B's checkpoint and records B as answered.
    wt.fire('change', `${LOCAL}/B/b.txt`)
    await nextMacrotask()
    await client.whenExternalFlushSettled()
    // Second save under A, same round still held. A has no checkpoint left to
    // patch, so this flush merges nothing — it must not erase B's record.
    wt.fire('change', `${LOCAL}/A/x.txt`)
    await nextMacrotask()
    await client.whenExternalFlushSettled()

    holdScan = false
    releaseHeld()
    await client.whenReconcileScanSettled()

    const after = [...disk.store.entries()].find(([k]) => k.endsWith(dirB))
    expect(after).toBeDefined()
    expect(
      (JSON.parse(after![1]) as { files: readonly { clientFile?: string }[] }).files.map(
        (f) => f.clientFile,
      ),
    ).toEqual([`${LOCAL}/B/b.txt`])
  })

  it('re-adds reverted files as drift so they land in the Changes group', async () => {
    // The file is opened before the move and no longer opened after `revert -k`.
    let opened = true
    const client = await makeClient(
      {
        opened: () => (opened ? [{ rel: 'a.txt' }] : []),
        reconcile: (spec) => (spec.endsWith('a.txt') ? [{ rel: 'a.txt' }] : []),
      },
      fakeDisk(),
      fakeClock(),
      { createFileSystemWatcher: () => makeFakeWatcher().watcher, watchRoot: ROOT },
    )
    client.setReconcileScope([LOCAL])
    await client.refresh()

    const ok = await (async () => {
      opened = false
      return client.moveToReconcile([`${LOCAL}/a.txt`])
    })()
    expect(ok).toBe(true)

    // The reverted content is now uncollected drift: it must appear in the
    // reconcile group this session, not wait for the next session's scan.
    expect(driftFiles(client)).toContain(`${LOCAL}/a.txt`)
  })

  it('revert -k on a directory that is gone re-queries its subtree, not the bare path', async () => {
    // The directory was deleted on disk while its files were still opened, which
    // is exactly when "move to Reconcile" is reachable: the user collects the
    // deleted files rather than reverting them. A bare spec names no file — p4
    // expands a directory spec from the filesystem, and there is no directory any
    // more — so only the subtree form can still answer for the files that were
    // inside it, and without it the files stay invisible this session.
    const client = await makeClient(
      {
        reconcile: (_filespec, specs) =>
          specs.some((s) => s.endsWith('/...')) ? [{ rel: 'gone/a.txt', action: 'delete' }] : [],
      },
      fakeDisk(),
      fakeClock(),
      { createFileSystemWatcher: () => makeFakeWatcher().watcher, watchRoot: ROOT },
    )
    client.setReconcileScope([LOCAL])

    const ok = await client.moveToReconcile([`${LOCAL}/gone`])
    expect(ok).toBe(true)

    const query = reconcileScans().find((a) => reconcileSpecs(a).includes(`${LOCAL}/gone/...`))
    expect(query).toBeDefined()
    expect(reconcileSpecs(query!)).toContain(`${LOCAL}/gone`)
    expect(driftFiles(client)).toContain(`${LOCAL}/gone/a.txt`)
  })

  it('revert -k makes the file appear in the rendered reconcile group immediately', async () => {
    // Regression: _reapplyDriftForMutation queries with reconcile -n, but
    // _reconcileScanBatch filters rows by _openedPaths — a stale snapshot from
    // the last refresh. Without removing the reverted file from _openedPaths
    // before the query, the row is filtered out and the group stays empty.
    // The mock keeps reporting the file as opened even after revert -k,
    // simulating the stale snapshot.
    const client = await makeClient(
      {
        opened: () => [{ rel: 'a.txt' }],
        reconcile: (spec) => (spec.endsWith('a.txt') ? [{ rel: 'a.txt' }] : []),
      },
      fakeDisk(),
      fakeClock(),
      { createFileSystemWatcher: () => makeFakeWatcher().watcher, watchRoot: ROOT },
    )
    client.setReconcileScope([LOCAL])
    await client.refresh()

    const ok = await client.moveToReconcile([`${LOCAL}/a.txt`])
    expect(ok).toBe(true)

    // _applyDriftGroup is debounced; in a unit test with mock timers the cleanest
    // assertion is to call it directly (the real workspace verify covers the
    // timer path end-to-end).
    ;(client as unknown as { _applyDriftGroup: () => void })._applyDriftGroup()
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])
  })

  it('ignores external events outside the scope or inside an excluded directory', async () => {
    const wt = makeFakeWatcher()
    const client = await makeClient({ reconcile: () => [] }, fakeDisk(), fakeClock(), {
      createFileSystemWatcher: () => wt.watcher,
      watchRoot: ROOT,
      externalChangeDebounceMs: 0,
    })
    client.setReconcileScope([`${LOCAL}/sub`])
    // Applied before the scan so the exclusion takes effect in the same round —
    // setting it AFTER a settled armed scan would (deliberately) re-preheat.
    client.setReconcileExcludes([`${LOCAL}/sub/excluded`])
    client.scheduleReconcileScan()
    await client.whenReconcileScanSettled()
    expect(reconcileScans()).toHaveLength(1)

    wt.fire('change', `${LOCAL}/outside/a.txt`)
    wt.fire('change', `${LOCAL}/sub/excluded/b.txt`)
    await nextMacrotask()
    await nextMacrotask()

    // Neither path is queried at all: no narrow spawn, no directory re-walk,
    // zero new drift on disk.
    expect(narrowScans()).toHaveLength(0)
    expect(fullScanScans()).toHaveLength(1)
    expect(groupRows(client)).toEqual([])
    expect(driftFiles(client)).toEqual([])
  })

  it("does not treat the plugin's own mutation writes as external changes", async () => {
    const wt = makeFakeWatcher()
    const client = await makeClient(
      { reconcile: () => [], opened: () => [] },
      fakeDisk(),
      fakeClock(),
      { createFileSystemWatcher: () => wt.watcher, watchRoot: ROOT, externalChangeDebounceMs: 0 },
    )
    client.setReconcileScope([LOCAL])

    // The mutation's own path schedules the first scan round via its refresh tail.
    await client.reconcile([`${LOCAL}/a.txt`])
    const before = narrowScans().length
    // The watcher then reports the very files the mutation wrote…
    wt.fire('change', `${LOCAL}/a.txt`)
    await nextMacrotask()
    await client.whenExternalFlushSettled()
    await client.whenReconcileScanSettled()

    // …but self-mutation suppression means nothing is asked about them again.
    expect(narrowScans()).toHaveLength(before)
    expect(fullScanScans()).toHaveLength(1)
  })

  it("a held sync's own write flood never reaches the narrow query, and applied rows still leave the drift set", async () => {
    // A whole-workspace sync outlives the 5s self-mutation window, so its late
    // writes are dropped by the sync-lifecycle suspension instead — and counted
    // for the status bar. Its own writes must never become narrow queries, and
    // a pre-existing drift row the sync did NOT rewrite must survive untouched
    // (the dropped watcher event is not re-derived this session — known gap).
    const wt = makeFakeWatcher()
    const client = await makeClient(
      {
        opened: () => [],
        reconcile: (spec) =>
          spec.endsWith(`${LOCAL}/...`) ? [{ rel: 'a.txt' }, { rel: 'b.txt' }] : [],
        sync: () => ({
          stdout: `//depot/branch_x/a.txt#3 - updated as ${LOCAL}/a.txt`,
          hold: true,
        }),
      },
      fakeDisk(),
      fakeClock(),
      { createFileSystemWatcher: () => wt.watcher, watchRoot: ROOT, externalChangeDebounceMs: 0 },
    )
    client.setReconcileScope([LOCAL])
    client.scheduleReconcileScan()
    await client.whenReconcileScanSettled()
    expect(driftFiles(client)).toEqual([`${LOCAL}/a.txt`, `${LOCAL}/b.txt`])

    const run = client.sync('#head', { onProgress: () => {} })
    await vi.waitFor(() => expect(heldChildren.length).toBe(1))
    const before = narrowScans().length
    wt.fire('change', `${LOCAL}/a.txt`)
    wt.fire('change', `${LOCAL}/b.txt`)
    await nextMacrotask()
    await client.whenExternalFlushSettled()
    expect(narrowScans()).toHaveLength(before)

    releaseHeld()
    const res = await run
    expect(res.ok).toBe(true)
    // a.txt's row is subtracted (p4 rewrote it); b.txt's survives — its event
    // was dropped by the suspension and is only re-derived next session.
    expect(driftFiles(client)).toEqual([`${LOCAL}/b.txt`])
  })

  it('does not query on external events while offline', async () => {
    const wt = makeFakeWatcher()
    const client = await makeClient({ reconcile: () => [] }, fakeDisk(), fakeClock(), {
      createFileSystemWatcher: () => wt.watcher,
      watchRoot: ROOT,
      externalChangeDebounceMs: 0,
    })
    client.setReconcileScope([LOCAL])
    client.scheduleReconcileScan()
    await client.whenReconcileScanSettled()
    expect(fullScanScans()).toHaveLength(1)
    ;(client as unknown as { _goOffline(kind: string): void })._goOffline('offline')
    wt.fire('change', `${LOCAL}/a.txt`)
    await nextMacrotask()
    await client.whenExternalFlushSettled()

    expect(narrowScans()).toHaveLength(0)
    expect(fullScanScans()).toHaveLength(1)
  })

  it('dispose cancels a pending debounce and releases the watcher', async () => {
    const wt = makeFakeWatcher()
    const client = await makeClient({ reconcile: () => [] }, fakeDisk(), fakeClock(), {
      createFileSystemWatcher: () => wt.watcher,
      watchRoot: ROOT,
      externalChangeDebounceMs: 0,
    })
    client.setReconcileScope([LOCAL])
    client.scheduleReconcileScan()
    await client.whenReconcileScanSettled()
    expect(fullScanScans()).toHaveLength(1)

    wt.fire('change', `${LOCAL}/a.txt`)
    client.dispose()
    await nextMacrotask()
    await nextMacrotask()

    // No flush fired into the disposed client, and the watcher was released.
    expect(narrowScans()).toHaveLength(0)
    expect(fullScanScans()).toHaveLength(1)
    expect(wt.dispose).toHaveBeenCalled()
  })

  it('anchors the watch at the open folder, not the client root', async () => {
    // A game workspace's client root maps far more than the folder the user
    // opened. Anchoring at the client root would push the watcher base outside
    // the workspace, where the workbench arms an unfiltered in-main recursive
    // fs.watch over the whole mapping instead of joining its exclude-pruned
    // out-of-process plan.
    const opened = `${LOCAL}/Source/Client`
    const bases: string[] = []
    const wt = makeFakeWatcher()
    await makeClient({ reconcile: () => [] }, fakeDisk(), fakeClock(), {
      createFileSystemWatcher: (glob) => {
        bases.push((glob as unknown as { base: string }).base)
        return wt.watcher
      },
      watchRoot: opened,
      externalChangeDebounceMs: 0,
    })

    // Anchored at the opened subfolder, NOT at the (broader) client root ROOT.
    expect(bases).toEqual([opened])
  })

  it('does not watch at all when no open folder was supplied', async () => {
    const createFileSystemWatcher = vi.fn()
    await makeClient({ reconcile: () => [] }, fakeDisk(), fakeClock(), {
      createFileSystemWatcher,
      externalChangeDebounceMs: 0,
    })

    expect(createFileSystemWatcher).not.toHaveBeenCalled()
  })

  it('defers an external change queued before a mutation instead of dropping it', async () => {
    const clock = fakeClock()
    const wt = makeFakeWatcher()
    const client = await makeClient(
      // Drift is echoed for the file actually asked about: the narrow query only
      // keeps hints matching a requested path, so a fixed fixture row would be
      // filtered out and the assertion would prove nothing.
      {
        reconcile: (spec) => (spec.endsWith('elsewhere.txt') ? [{ rel: 'elsewhere.txt' }] : []),
        opened: () => [],
      },
      fakeDisk(),
      clock,
      { createFileSystemWatcher: () => wt.watcher, watchRoot: ROOT, externalChangeDebounceMs: 0 },
    )
    client.setReconcileScope([LOCAL])
    client.scheduleReconcileScan()
    await client.whenReconcileScanSettled()
    expect(fullScanScans()).toHaveLength(1)

    // The external change is queued FIRST; the mutation's suppression window
    // opens before the debounce flush runs. The queued path is real drift the
    // mutation's own narrow invalidation does not cover, so it must survive the
    // window rather than being dropped with the batch.
    wt.fire('change', `${LOCAL}/elsewhere.txt`)
    await client.reconcile([`${LOCAL}/a.txt`])
    await nextMacrotask()
    await nextMacrotask()
    await client.whenExternalFlushSettled()
    await client.whenReconcileScanSettled()

    // The deferred path was queried by name, and its drift published.
    expect(narrowScans().flat()).toContain(`${LOCAL}/elsewhere.txt`)
    expect(driftFiles(client)).toContain(`${LOCAL}/elsewhere.txt`)
  })

  it('a directory event is answered as a subtree, so the checkpoint is corrected not dropped', async () => {
    // `_pathKind` stats the path for real, so the event must name a path that
    // actually IS a directory on disk — a faked path reads as gone and takes the
    // deleted-path branch. (The row-attribution half — a subtree answer's rows
    // landing in the Changes group — is the `gone` case below, which can point
    // its rows into the fake workspace root; a real temp dir cannot.)
    const realDir = mkTempDir('p4-dirEvt-')
    try {
      const disk = fakeDisk()
      const wt = makeFakeWatcher()
      const client = await makeClient({ reconcile: () => [] }, disk, fakeClock(), {
        createFileSystemWatcher: () => wt.watcher,
        watchRoot: ROOT,
        externalChangeDebounceMs: 0,
      })
      client.setReconcileScope([realDir])
      client.scheduleReconcileScan()
      await client.whenReconcileScanSettled()
      expect(fullScanScans()).toHaveLength(1)
      expect([...disk.store.keys()].some((k) => k.endsWith(realDir))).toBe(true)

      // A directory event (new folder, moved subtree) names no file, so a bare
      // spec would match nothing and "no file(s) to reconcile" would be stamped
      // into the checkpoint as clean. It must be asked as a SUBTREE instead — and
      // then the answer ("this dir holds no drift") is a real answer, so the
      // checkpoint is patched in place rather than thrown away.
      wt.fire('change', realDir)
      await nextMacrotask()
      await client.whenExternalFlushSettled()

      const dirQuery = reconcileScans().find((a) => a.includes(`${realDir}/...`))
      expect(dirQuery).toBeDefined()
      // The subtree spec stands alone for a directory: there is no bare companion,
      // because a bare path names no file and would only add a junk spec.
      expect(reconcileSpecs(dirQuery!)).toEqual([`${realDir}/...`])
      // Patched, not dropped: the next session replays it instead of re-walking.
      expect([...disk.store.keys()].some((k) => k.endsWith(realDir))).toBe(true)
    } finally {
      rmSync(realDir, { recursive: true, force: true })
    }
  })

  it('a deleted directory is answered as a subtree, so its files land in the Changes group', async () => {
    // The reported bug: delete a folder in the editor (shell.trashItem = a
    // same-volume rename) and Windows reports ONE event for the directory path —
    // the files inside are moved with it and never get events of their own. A
    // path that no longer exists can't be classified by `stat`, and the old
    // reading of "stat threw, so it was a deleted FILE" sent a bare
    // `reconcile -n <dir>` — which p4 expands from the FILESYSTEM, so a vanished
    // directory is a single file spec that matches nothing and answers
    // "no file(s) to reconcile" (measured against a real server). The whole
    // subtree stayed invisible, and worse, that "clean" was stamped into the
    // checkpoint for the next 24h.
    const disk = fakeDisk()
    const wt = makeFakeWatcher()
    const client = await makeClient(
      {
        // Only the subtree form can answer for the directory: the bare path names
        // no file in the depot, so a per-file reading of this path is exactly the
        // false "clean" the real server hands back. Keyed on the SPEC list, not on
        // the (path-normalized) filespec, because the distinction between the two
        // specs in the batch is the whole point here.
        reconcile: (_filespec, specs) =>
          specs.some((s) => s.endsWith('/...'))
            ? [
                { rel: 'gone/a.txt', action: 'delete' },
                { rel: 'gone/b.txt', action: 'delete' },
              ]
            : [],
      },
      disk,
      fakeClock(),
      { createFileSystemWatcher: () => wt.watcher, watchRoot: ROOT, externalChangeDebounceMs: 0 },
    )
    client.setReconcileScope([LOCAL])
    client.scheduleReconcileScan()
    await client.whenReconcileScanSettled()
    expect(fullScanScans()).toHaveLength(1)
    const firstEntry = [...disk.store.entries()].find(([k]) => k.endsWith(LOCAL))
    const firstCompletedAt = (JSON.parse(firstEntry![1]) as { completedAt: number }).completedAt

    // `gone` is really absent from disk (ROOT is a fictional tree), which is the
    // only precondition this test needs — the event IS the user's delete.
    wt.fire('delete', `${LOCAL}/gone`)
    await nextMacrotask()
    await client.whenExternalFlushSettled()

    // The query must ask about the directory as a SUBTREE. The bare companion is
    // what covers "the deleted thing was a file", which cannot be known from a
    // path that is gone — so both specs ride in one batch.
    const argv = narrowScans()[0]
    expect(argv).toBeDefined()
    expect(argv).toContain(`${LOCAL}/gone`)
    expect(argv).toContain(`${LOCAL}/gone/...`)
    // Answering this by re-walking the directory would spend minutes of a large
    // workspace on a signal that already names the subtree.
    expect(fullScanScans()).toHaveLength(1)

    expect(driftFiles(client)).toEqual(
      expect.arrayContaining([`${LOCAL}/gone/a.txt`, `${LOCAL}/gone/b.txt`]),
    )
    // The action is what the panel renders as `RD` (delete, struck through).
    // Looked up by value: the drift set is keyed by `scopeKey`, which folds case
    // on Windows, so a literal key would only match on one platform.
    const deleted = [...client.scanDrift.values()].find(
      (r) => r.clientFile === `${LOCAL}/gone/a.txt`,
    )
    expect(deleted?.action).toBe('delete')

    // The covering checkpoint is corrected in place rather than dropped — the
    // answer is authoritative for the paths it covered, so the next session
    // replays the deletions instead of re-walking the workspace.
    const entry = [...disk.store.entries()].find(([k]) => k.endsWith(LOCAL))
    expect(entry).toBeDefined()
    const patched = JSON.parse(entry![1]) as {
      completedAt: number
      files: readonly { clientFile?: string; action?: string }[]
    }
    expect(patched.files.map((f) => f.clientFile)).toEqual(
      expect.arrayContaining([`${LOCAL}/gone/a.txt`, `${LOCAL}/gone/b.txt`]),
    )
    expect(patched.completedAt).toBe(firstCompletedAt)

    // And the panel renders them: a fresh scan replaying that checkpoint (zero
    // spawns) must turn the rows into the resident group's `RD` entries.
    await client.runReconcileScan()
    expect(fullScanScans()).toHaveLength(1)
    expect(groupRows(client)).toEqual(
      expect.arrayContaining([
        { path: `${LOCAL}/gone/a.txt`, letter: 'RD' },
        { path: `${LOCAL}/gone/b.txt`, letter: 'RD' },
      ]),
    )
  })

  it('a deleted file is answered by its bare spec, so the pair stays load-bearing', async () => {
    // The mirror of the directory case above. A path that is GONE gets BOTH
    // specs precisely because which one names a file cannot be known from a path
    // that is not there — and `<path>/...` on a deleted FILE names nothing (p4
    // resolves a directory spec from the filesystem, and there is no directory).
    // Dropping the bare companion in favour of the subtree form alone would make
    // every deleted file invisible: the same bug in a new coat. The responder
    // below mirrors the server by answering only for the concrete spec.
    const disk = fakeDisk()
    const wt = makeFakeWatcher()
    const client = await makeClient(
      {
        reconcile: (_filespec, specs) =>
          specs.some((s) => !WILDCARD_SPEC.test(s)) ? [{ rel: 'a.txt', action: 'delete' }] : [],
      },
      disk,
      fakeClock(),
      { createFileSystemWatcher: () => wt.watcher, watchRoot: ROOT, externalChangeDebounceMs: 0 },
    )
    client.setReconcileScope([LOCAL])
    client.scheduleReconcileScan()
    await client.whenReconcileScanSettled()

    wt.fire('delete', `${LOCAL}/a.txt`)
    await nextMacrotask()
    await client.whenExternalFlushSettled()

    const argv = narrowScans()[0]
    expect(argv).toBeDefined()
    expect(argv).toContain(`${LOCAL}/a.txt`)
    expect(argv).toContain(`${LOCAL}/a.txt/...`)
    expect(fullScanScans()).toHaveLength(1)
    // The bare spec is what answered, so the row is real and the covering
    // checkpoint carries it into the next session.
    expect(driftFiles(client)).toContain(`${LOCAL}/a.txt`)
    const entry = [...disk.store.entries()].find(([k]) => k.endsWith(LOCAL))
    expect(JSON.parse(entry![1]).files.map((f: { clientFile?: string }) => f.clientFile)).toEqual([
      `${LOCAL}/a.txt`,
    ])
  })

  it('an existing file is asked by its bare path alone, with no subtree companion', async () => {
    // The cost red line: a directory spec is only for directories. The commonest
    // external event by far is a save, and pairing every one of them with a
    // `<file>/...` spec would double the argv of the hot path — so the subtree
    // form must be reachable ONLY from the `dir`/`gone` branches. The path has to
    // exist on disk for this: `_pathKind` stats for real.
    const realDir = mkTempDir('p4-fileEvt-')
    const realFile = join(realDir, 'a.txt')
    writeFileSync(realFile, 'x')
    try {
      const wt = makeFakeWatcher()
      const client = await makeClient({ reconcile: () => [] }, undefined, fakeClock(), {
        createFileSystemWatcher: () => wt.watcher,
        watchRoot: ROOT,
        externalChangeDebounceMs: 0,
      })
      client.setReconcileScope([realDir])

      wt.fire('change', realFile)
      await nextMacrotask()
      await client.whenExternalFlushSettled()

      const argv = narrowScans()[0]
      expect(argv).toBeDefined()
      expect(reconcileSpecs(argv!)).toEqual([realFile])
    } finally {
      rmSync(realDir, { recursive: true, force: true })
    }
  })

  it('carves around an excluded subtree instead of widening to `<dir>/...`', async () => {
    // An excluded directory under an event's directory makes `<dir>/...` illegal
    // (it would pull the excluded subtree back into p4's traversal — the reconcile
    // carve module's red line), so the spec list is carved. The carve walks the
    // real tree, hence the real directories.
    const realDir = mkTempDir('p4-dirExcl-')
    const sub = join(realDir, 'sub')
    const excluded = join(sub, 'excluded')
    mkdirSync(excluded, { recursive: true })
    writeFileSync(join(sub, 'keep.txt'), 'x')
    // The mocked readdir must answer for real files here.
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    readdirMock.mockImplementation((dir: string) => actualFs.readdir(dir, { withFileTypes: true }))
    try {
      const wt = makeFakeWatcher()
      const client = await makeClient({ reconcile: () => [] }, undefined, fakeClock(), {
        createFileSystemWatcher: () => wt.watcher,
        watchRoot: ROOT,
        externalChangeDebounceMs: 0,
      })
      client.setReconcileScope([realDir])
      client.setReconcileExcludes([excluded])

      wt.fire('change', sub)
      await nextMacrotask()
      await client.whenExternalFlushSettled()

      // Looked up on `reconcileScans`, not `narrowScans`: a carve spells its level
      // spec `<dir>/*`, which is shape-identical to a scan batch — the classifier
      // cannot tell them apart, and this test is about the SPECS either way.
      const dirQuery = reconcileScans().find((a) =>
        reconcileSpecs(a).some((s) => s.startsWith(sub)),
      )
      expect(dirQuery).toBeDefined()
      const specs = reconcileSpecs(dirQuery!)
      // The level spec is what keeps locally deleted files visible on that level.
      expect(specs).toContain(`${sub}/*`)
      // Neither the widening nor a spec reaching into the exclusion.
      expect(specs).not.toContain(`${sub}/...`)
      expect(specs.some((s) => s.startsWith(excluded))).toBe(false)
    } finally {
      rmSync(realDir, { recursive: true, force: true })
    }
  })

  it('a directory revert invalidates only the touched subtree checkpoints, not siblings', async () => {
    const disk = fakeDisk()
    const dirA = join(LOCAL, 'A')
    const dirB = join(LOCAL, 'B')
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    client.setReconcileScope([dirA, dirB])
    await client.runReconcileScan()
    expect(disk.store.size).toBe(2)
    expect([...disk.store.keys()].some((k) => k.includes('A'))).toBe(true)
    expect([...disk.store.keys()].some((k) => k.includes('B'))).toBe(true)

    // A directory-scoped mutation rewrites only that subtree, so only its
    // checkpoints are stale — clearing the whole namespace here is what made
    // every directory Revert cost the next workspace open a full rescan.
    await client.revertReconcile([`${dirA}/...`])

    expect([...disk.store.keys()].some((k) => k.includes('A'))).toBe(false)
    expect([...disk.store.keys()].some((k) => k.includes('B'))).toBe(true)
  })

  // --- ㉒ Bug C: a directory revert clears the drift group --------------------
  //
  // The old post-mutation "invalidate only" left the resident drift set holding
  // rows for files the revert just cleaned, so the folder tint survived until the
  // next session rescan. The fix is to DROP the affected rows outright: the
  // whole-array group assignment then rebuilds the view, and a folder tint that
  // a row anchored disappears with it (ancestors included).

  it('a directory revert clears the drift group and the per-directory index', async () => {
    let cleaned = false
    const disk = fakeDisk()
    const client = await makeClient(
      {
        // Before the revert the directory has drift; after it the disk is clean,
        // and the post-revert refresh re-scans with that truth.
        reconcile: () => (cleaned ? [] : [{ rel: 'in-a.txt' }]),
      },
      disk,
    )
    client.setReconcileScope([LOCAL])
    await client.runReconcileScan()
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/in-a.txt`, letter: 'RM' }])
    expect(scannedDirs(client)).toEqual([LOCAL])

    cleaned = true
    await client.revertReconcile([`${LOCAL}/...`])
    // The revert's refresh schedules a background scan; drain it so it cannot
    // re-add rows after this test's assertions.
    await client.whenReconcileScanSettled()

    // The drift rows are dropped (not just invalidated) and the group is
    // whole-array assigned empty — the folder tint has nothing left to anchor on.
    // The per-directory index keeps LOCAL (with an empty list), which is fine: it
    // only records which directories contributed an observation, and the clean
    // scan re-recorded it.
    expect(driftFiles(client)).toEqual([])
    expect(groupRows(client)).toEqual([])
  })

  it('a subtree revert clears only its own rows, keeping siblings', async () => {
    let cleaned = false
    const disk = fakeDisk()
    const client = await makeClient(
      {
        // One batch for the whole scope returns both rows; flipping `cleaned`
        // makes the post-revert rescan answer only the sibling.
        reconcile: () =>
          cleaned ? [{ rel: 'top.txt' }] : [{ rel: 'sub/in-s.txt' }, { rel: 'top.txt' }],
      },
      disk,
    )
    client.setReconcileScope([LOCAL])
    await client.runReconcileScan()
    expect(driftFiles(client).sort()).toEqual([`${LOCAL}/sub/in-s.txt`, `${LOCAL}/top.txt`])
    expect(groupRows(client).sort()).toEqual([
      { path: `${LOCAL}/sub/in-s.txt`, letter: 'RM' },
      { path: `${LOCAL}/top.txt`, letter: 'RM' },
    ])

    cleaned = true
    await client.revertReconcile([`${join(LOCAL, 'sub')}/...`])
    await client.whenReconcileScanSettled()

    // Only the sub tree's row is gone; the sibling row survives its own tint.
    expect(driftFiles(client).sort()).toEqual([`${LOCAL}/top.txt`])
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/top.txt`, letter: 'RM' }])
  })

  it('a failed revert clears nothing', async () => {
    const disk = fakeDisk()
    const client = await makeClient(
      {
        reconcile: () => [{ rel: 'in-a.txt' }],
        cleanExit: 1,
        cleanStderr: 'clean failed: file(s) not opened on this client',
      },
      disk,
    )
    client.setReconcileScope([LOCAL])
    await client.runReconcileScan()
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/in-a.txt`, letter: 'RM' }])

    const ok = await client.revertReconcile([`${LOCAL}/...`])
    expect(ok).toBe(false)
    await client.whenReconcileScanSettled()

    // The disk was not cleaned, so the drift must survive the failed mutation.
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/in-a.txt`, letter: 'RM' }])
    expect(windowMock.showErrorMessage).toHaveBeenCalled()
  })

  it('a truncating reconcileLimit keeps the group at the cap but the index intact', async () => {
    const disk = fakeDisk()
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }, { rel: 'b.txt' }] }, disk)
    client.setReconcileScope([LOCAL])
    client.setReconcileLimit(1)
    await client.runReconcileScan()

    // The rendered group is capped at 1 row (sorted by clientFile, so a.txt),
    // while the scan index owns both — the cap is a display concern, not a
    // discovery one.
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])
    expect(driftFiles(client).sort()).toEqual([`${LOCAL}/a.txt`, `${LOCAL}/b.txt`])
  })
})

// ---------------------------------------------------------------------------
// The δ engine (`perforce.p4delta.*` → `PerforceClientOptions.p4delta`)
// ---------------------------------------------------------------------------
//
// The engine seam is `P4deltaService.prototype.run`: the client builds a real
// service around the exe it was handed (that is the production wiring, and the
// point of the option being just an exe), so the stub replaces only the process
// spawn — the argv the client built is what these tests assert on. Locks in:
//  1. One whole-scope run with the frozen argv (contract flags + scope entries
//     + `-`-prefixed exclusions), rows through the ordinary drift pipeline, and
//     ONE checkpoint under the client root.
//  2. A fresh checkpoint is replayed with zero spawns; past 24h it is rescanned.
//  3. δ failures (no summary, non-JSON stdout, usage error, run failure) fall
//     back to the native scan IN THE SAME ROUND — a broken engine costs a slow
//     scan, never a missing one — and count toward a 3-strike disarm.
//  4. A cancel is not a failure: no counter, no fallback.
//  5. `no-entry-matched` is a normal empty answer, not a failure.
//  6. The engine is part of the checkpoint fingerprint, so the two engines'
//     checkpoints never alias.

const { P4deltaService } = await import('../p4deltaService.js')
type P4deltaRecord = import('../p4deltaService.js').P4deltaRecord
type P4deltaRunResult = import('../p4deltaService.js').P4deltaRunResult

const P4DELTA_EXE = '/opt/p4delta'

/** δ argv per stubbed run, in call order. */
const p4deltaCalls: string[][] = []

/** The run options per stubbed run, in call order — how the write tests observe
 *  the watchdog policy a mutation forwarded to the engine. */
const p4deltaRunOptionList: Array<import('../p4deltaService.js').P4deltaRunOptions | undefined> = []

interface P4deltaReply {
  records?: P4deltaRecord[]
  progress?: P4deltaRecord[]
  log?: string[]
  code?: number
  sawNonJsonStdout?: boolean
  /** The run stays in flight until this resolves — for observing progress
   *  mid-run or cancelling it. */
  hold?: Promise<void>
}

let p4deltaRunSpy: { mockRestore: () => void } | undefined

/** Stub the δ run. The result is assembled the way the service assembles it
 *  (`sawSummary` from the records), so a test expresses "no summary" simply by
 *  leaving the summary record out. */
function stubP4deltaRun(reply: (args: readonly string[]) => P4deltaReply): void {
  p4deltaRunSpy = vi
    .spyOn(P4deltaService.prototype, 'run')
    .mockImplementation(async (args, options) => {
      const argv = [...args]
      p4deltaCalls.push(argv)
      p4deltaRunOptionList.push(options)
      const r = reply(argv)
      if (r.hold) await r.hold
      const records = r.records ?? []
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

/** One δ `kind:"file"` record in the contract's shape (`mode: "open"`). */
function deltaFile(rel: string, action: string, klass: string = action): P4deltaRecord {
  return {
    kind: 'file',
    mode: 'open',
    class: klass,
    action,
    depotFile: `//depot/branch_x/${rel}`,
    clientFile: `//${CLIENT}/${rel}`,
    rev: '1',
    applied: false,
  }
}

function deltaSummary(overrides: Record<string, unknown> = {}): P4deltaRecord {
  return {
    kind: 'summary',
    mode: 'open',
    ok: true,
    applied: false,
    total: 0,
    counts: {},
    scopeMatched: 1,
    unmatched: 0,
    elapsedMs: 42,
    reason: null,
    ...overrides,
  }
}

describe('PerforceClient.runReconcileScan — δ engine', () => {
  beforeEach(() => {
    resetScanHarness()
    p4deltaCalls.length = 0
  })

  afterEach(() => {
    p4deltaRunSpy?.mockRestore()
    p4deltaRunSpy = undefined
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  it('covers the whole scope in one δ run and checkpoints it under the root key', async () => {
    const disk = fakeDisk()
    const client = await makeClient({}, disk, fakeClock(), { p4delta: { exe: P4DELTA_EXE } })
    client.setReconcileScope([LOCAL])
    client.setReconcileExcludes([`${LOCAL}/ignored`])
    stubP4deltaRun(() => ({
      records: [
        deltaFile('a.txt', 'edit'),
        deltaFile('b.txt', 'add'),
        // δ's open mode also reports the `p4 revert -a` groups (action
        // `revert`) and hands undigestable files off to native p4; neither is a
        // drift row, and all of them must stay out of the group.
        deltaFile('c.txt', 'revert', 'revert_edit'),
        {
          kind: 'file',
          mode: 'open',
          class: 'handoff',
          handoff: 'reconcile',
          depotFile: '//depot/branch_x/x.bin',
          clientFile: `//${CLIENT}/x.bin`,
          applied: false,
        },
        deltaSummary({ total: 2, counts: { add: 1, edit: 1 } }),
      ],
      progress: [
        { kind: 'progress', phase: 'digest', step: 3, total: 5, message: 'Checking digests.' },
      ],
      log: ['Timestamp optimization: Skipped 3 of 40 files.'],
    }))

    await client.runReconcileScan()

    // ONE δ run, contract flags in the frozen order, then the scope entries:
    // the scanned directory plus every exclusion inside it, `-`-prefixed and
    // after `--` so they stay positional (δ applies the exclusions itself —
    // no carve, and `--json`/`--client-root`/`--no-scope-file` are exactly the
    // switches the contract defines).
    expect(p4deltaCalls).toEqual([
      [
        '--json',
        '--no-scope-file',
        '--client-root',
        ROOT,
        '--no-revert-groups',
        '--',
        `${LOCAL}/...`,
        `-${LOCAL}/ignored/...`,
      ],
    ])
    // The whole scope was answered by δ: the native walk spawned nothing.
    expect(reconcileScans()).toEqual([])
    // Only add/edit/delete become rows — they land in the drift set and the group.
    expect(groupRows(client)).toEqual([
      { path: `${LOCAL}/a.txt`, letter: 'RM' },
      { path: `${LOCAL}/b.txt`, letter: 'RA' },
    ])
    expect(driftFiles(client).sort()).toEqual([`${LOCAL}/a.txt`, `${LOCAL}/b.txt`])
    // ONE checkpoint, keyed by the client root (a δ snapshot is whole-scope).
    expect(disk.store.size).toBe(1)
    const [key] = [...disk.store.keys()]
    expect(key).toMatch(/^reconcileScan\/[0-9a-f]{16}:/)
    expect(key!.endsWith(`:${ROOT}`)).toBe(true)
    const entry = JSON.parse(disk.store.get(key!)!) as {
      completedAt: number
      files: unknown[]
      elapsedMs?: number
    }
    expect(entry.files).toHaveLength(2)
    expect(entry.completedAt).toBeTypeOf('number')
    expect(entry.elapsedMs).toBeTypeOf('number')
    expect(scannedDirs(client)).toEqual([ROOT])
  })

  it('reports δ phases instead of a fabricated directory count', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const client = await makeClient({}, undefined, fakeClock(), {
      p4delta: { exe: P4DELTA_EXE },
    })
    client.setReconcileScope([LOCAL])
    stubP4deltaRun(() => ({
      hold: held,
      records: [deltaFile('a.txt', 'edit'), deltaSummary({ total: 1, counts: { edit: 1 } })],
    }))

    const scan = client.runReconcileScan()
    // δ is a whole-scope call: the readout counts the phase ladder
    // (start/analyze/digest/report/done), and the native directory fields are
    // absent — the status bar renders the phase instead of "0/5 directories".
    await vi.waitFor(() => {
      expect(client.status.scanProgress?.phase).toBe('start')
    })
    expect(client.status.scanProgress).toMatchObject({ done: 0, pending: 5, step: 1 })
    expect(client.status.scanProgress?.currentDir).toBeUndefined()

    release()
    await scan
    expect(client.status.scanProgress).toBeUndefined()
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])
  })

  it('annotates the drift group with the phase ladder, not fabricated directory counts', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const client = await makeClient({}, undefined, fakeClock(), {
      p4delta: { exe: P4DELTA_EXE },
      // A scope FILE keeps the scan in flight after the δ run (the per-file
      // verification is a second δ call), which is the window the group title
      // is observed in.
      scopeFileExists: () => true,
    })
    client.setReconcileScope([LOCAL], [`${LOCAL}/a.txt`])
    let runs = 0
    stubP4deltaRun(() => {
      runs += 1
      return runs === 1
        ? {
            records: [deltaSummary()],
            progress: [
              {
                kind: 'progress',
                phase: 'digest',
                step: 3,
                total: 5,
                message: 'Checking digests.',
              },
            ],
          }
        : { hold: held, records: [deltaSummary()] }
    })

    const scan = client.runReconcileScan()
    // The δ run's terminal frame (`done`, the ladder's 5th ordinal) is the one
    // live while the per-file phase runs. `done`/`pending` count PHASES there,
    // so the title must render the phase — "scanning 5/5" is the same number
    // spelled as a directory count the whole-scope run never had.
    await vi.waitFor(() => {
      expect(client.reconcileGroupLabel).toBe('Changes (scanning done (5/5))')
    })

    release()
    await scan
    expect(client.reconcileGroupLabel).toBe('Changes')
  })

  it('falls back to the native scan when δ answers in another mode, and counts it', async () => {
    const disk = fakeDisk()
    const client = await makeClient(
      { reconcile: () => [{ rel: 'native.txt' }] },
      disk,
      fakeClock(),
      { p4delta: { exe: P4DELTA_EXE } },
    )
    client.setReconcileScope([LOCAL])
    // Records and `ok:true`, but the summary says the run answered `clean`. A
    // scan must not read another mode's file list as its own answer: publishing
    // it would invent drift rows, and the whole-scope checkpoint would persist
    // the wrong answer under δ's key for a day.
    stubP4deltaRun(() => ({
      records: [
        deltaFile('a.txt', 'edit'),
        deltaSummary({ mode: 'clean', applied: true, total: 1, counts: { edit: 1 } }),
      ],
    }))

    await client.runReconcileScan()

    expect(p4deltaCalls).toHaveLength(1)
    expect(client.p4deltaFallbackState).toEqual({ failures: 1, disarmed: false })
    expect(reconcileScans().length).toBe(1)
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/native.txt`, letter: 'RM' }])
    // …and the only checkpoint is the native per-directory one: δ's whole-scope
    // key was never written from the rejected records.
    const keys = [...disk.store.keys()]
    expect(keys).toHaveLength(1)
    expect(keys[0]!.endsWith(`:${LOCAL}`)).toBe(true)
  })

  it('replays a fresh whole-scope checkpoint with zero spawns, and rescans once expired', async () => {
    const disk = fakeDisk()
    const clock = fakeClock()
    const client = await makeClient({}, disk, clock, { p4delta: { exe: P4DELTA_EXE } })
    client.setReconcileScope([LOCAL])
    stubP4deltaRun(() => ({
      records: [deltaFile('a.txt', 'edit'), deltaSummary({ total: 1, counts: { edit: 1 } })],
    }))
    await client.runReconcileScan()
    expect(p4deltaCalls).toHaveLength(1)
    const [key] = [...disk.store.keys()]
    expect(key!.endsWith(`:${ROOT}`)).toBe(true)
    p4deltaCalls.length = 0

    // Next session, same disk: the snapshot is fresh, so the whole scope is
    // published from it with no engine (and no p4) spawned at all.
    const second = await makeClient({}, disk, clock, { p4delta: { exe: P4DELTA_EXE } })
    second.setReconcileScope([LOCAL])
    stubP4deltaRun(() => {
      throw new Error('δ must not run while a fresh checkpoint answers the scope')
    })
    await second.runReconcileScan()
    expect(p4deltaCalls).toEqual([])
    expect(groupRows(second)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])

    // Past the freshness ceiling the snapshot proves nothing: rescan.
    clock.advance(24 * 60 * 60 * 1000 + 1)
    const third = await makeClient({}, disk, clock, { p4delta: { exe: P4DELTA_EXE } })
    third.setReconcileScope([LOCAL])
    let runs = 0
    stubP4deltaRun(() => {
      runs++
      return { records: [deltaSummary()] }
    })
    await third.runReconcileScan()
    expect(runs).toBe(1)
  })

  it('falls back to the native scan when δ prints no summary, and counts it', async () => {
    const disk = fakeDisk()
    const client = await makeClient(
      { reconcile: () => [{ rel: 'native.txt' }] },
      disk,
      fakeClock(),
      { p4delta: { exe: P4DELTA_EXE } },
    )
    client.setReconcileScope([LOCAL])
    // Killed mid-stream: records but no `summary` — the contract's "no
    // conclusion", which must never be read as "nothing drifted".
    stubP4deltaRun(() => ({ records: [deltaFile('partial.txt', 'edit')] }))

    await client.runReconcileScan()

    expect(p4deltaCalls).toHaveLength(1)
    expect(client.p4deltaFallbackState).toEqual({ failures: 1, disarmed: false })
    // The round still answered — natively, in the same round.
    expect(reconcileScans().length).toBe(1)
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/native.txt`, letter: 'RM' }])
    // …and the checkpoint is the native per-directory one, not a δ snapshot.
    expect(scannedDirs(client)).toEqual([LOCAL])
    expect(disk.store.size).toBe(1)
    const [key] = [...disk.store.keys()]
    expect(key!.endsWith(`:${LOCAL}`)).toBe(true)
  })

  it('disarms the engine after three consecutive failures; only setP4delta re-arms it', async () => {
    const clock = fakeClock()
    const client = await makeClient({ reconcile: () => [] }, undefined, clock, {
      p4delta: { exe: P4DELTA_EXE },
    })
    client.setReconcileScope([LOCAL])
    stubP4deltaRun(() => ({ sawNonJsonStdout: true, records: [deltaSummary()] }))
    // Every round must really spawn the native walk, or the spawn count proves
    // nothing — past the freshness ceiling the checkpoint is rescanned instead
    // of replayed (the fallback round checkpoints like any native round).
    const advancePastCeiling = (): void => clock.advance(24 * 60 * 60 * 1000 + 1)

    for (let i = 0; i < 3; i++) {
      advancePastCeiling()
      await client.runReconcileScan()
    }

    expect(p4deltaCalls).toHaveLength(3)
    expect(client.p4deltaFallbackState).toEqual({ failures: 3, disarmed: true })
    // Every one of the three rounds still produced a native answer.
    expect(reconcileScans().length).toBe(3)

    // Disarmed: the next round goes straight to native, with no δ spawn at all.
    advancePastCeiling()
    await client.runReconcileScan()
    expect(p4deltaCalls).toHaveLength(3)
    expect(reconcileScans().length).toBe(4)

    // A reconfiguration is the only reset — the engine gets a clean ladder and
    // runs again (the disarm latch is not lifted by anything else).
    client.setP4delta(P4DELTA_EXE)
    expect(client.p4deltaFallbackState).toEqual({ failures: 0, disarmed: false })
    stubP4deltaRun(() => ({
      records: [deltaFile('a.txt', 'edit'), deltaSummary({ total: 1, counts: { edit: 1 } })],
    }))
    await client.runReconcileScan()
    expect(p4deltaCalls).toHaveLength(4)
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])
  })

  it('does not count a user cancel as a failure and does not fall back', async () => {
    const client = await makeClient({}, undefined, fakeClock(), { p4delta: { exe: P4DELTA_EXE } })
    client.setReconcileScope([LOCAL])
    stubP4deltaRun(() => {
      // The user cancels while the run is in flight: the service kills the
      // child, so the stream ends without a summary.
      client.cancelBusy()
      return { records: [deltaFile('partial.txt', 'edit')] }
    })

    await client.runReconcileScan()

    expect(p4deltaCalls).toHaveLength(1)
    expect(client.p4deltaFallbackState).toEqual({ failures: 0, disarmed: false })
    // Nothing was re-run and nothing was published: a cancel means "stop", not
    // "the engine is broken".
    expect(reconcileScans()).toEqual([])
    expect(groupRows(client)).toEqual([])

    // The engine is still this session's engine.
    await client.runReconcileScan()
    expect(p4deltaCalls).toHaveLength(2)
  })

  it('treats no-entry-matched as the normal empty answer, not a failure', async () => {
    const disk = fakeDisk()
    const client = await makeClient({}, disk, fakeClock(), { p4delta: { exe: P4DELTA_EXE } })
    client.setReconcileScope([`${LOCAL}/gone`])
    stubP4deltaRun(() => ({
      records: [
        { kind: 'unmatched', path: `${LOCAL}/gone` },
        { kind: 'unmatched', path: `${LOCAL}/gone/...` },
        deltaSummary({
          ok: false,
          total: 0,
          scopeMatched: 0,
          unmatched: 2,
          reason: 'no-entry-matched',
        }),
      ],
    }))

    await client.runReconcileScan()

    expect(p4deltaCalls).toHaveLength(1)
    expect(client.p4deltaFallbackState).toEqual({ failures: 0, disarmed: false })
    // "Every entry is gone" is a complete answer for the scope — no native
    // re-run, and the round is checkpointed as the empty answer it is (the δ
    // counterpart of "no file(s) to reconcile").
    expect(reconcileScans()).toEqual([])
    expect(groupRows(client)).toEqual([])
    expect(disk.store.size).toBe(1)
    const [key] = [...disk.store.keys()]
    expect(key!.endsWith(`:${ROOT}`)).toBe(true)
  })

  it('does not report a δ round complete when the per-file pass is cut short', async () => {
    const log: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const client = await makeClient({}, undefined, fakeClock(), {
      p4delta: { exe: P4DELTA_EXE },
      scopeFileExists: () => true,
      log: (m) => log.push(m),
    })
    client.setReconcileScope([LOCAL], [`${LOCAL}/a.txt`])
    let runs = 0
    stubP4deltaRun(() => {
      runs += 1
      return runs === 1 ? { records: [deltaSummary()] } : { hold: held, records: [deltaSummary()] }
    })

    const scan = client.runReconcileScan()
    await vi.waitFor(() => {
      expect(runs).toBe(2)
    })
    // Disposed while the per-file verification is in flight: the pass never
    // completed, so the round must not claim it did (the native walk returns
    // early on the same condition).
    client.dispose()
    release()
    await scan

    expect(log.join('\n')).not.toContain('reconcile-scan complete')
    expect(log.join('\n')).toContain('checkpoints kept')
  })

  it('keeps the two engines’ checkpoints apart (the engine is part of the fingerprint)', async () => {
    const disk = fakeDisk()
    // A native round writes its per-directory checkpoint…
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    client.setReconcileScope([LOCAL])
    await client.runReconcileScan()
    expect(disk.store.size).toBe(1)
    const [nativeKey] = [...disk.store.keys()]
    expect(nativeKey!.endsWith(`:${LOCAL}`)).toBe(true)

    // …which a δ round must NOT read as its whole-scope snapshot: the engine
    // marker puts it in another key space, so δ runs.
    client.setP4delta(P4DELTA_EXE)
    stubP4deltaRun(() => ({
      records: [deltaFile('b.txt', 'add'), deltaSummary({ total: 1, counts: { add: 1 } })],
    }))
    await client.runReconcileScan()
    expect(p4deltaCalls).toHaveLength(1)
    expect(disk.store.size).toBe(2)
    const deltaKey = [...disk.store.keys()].find((k) => k !== nativeKey)!
    expect(deltaKey.endsWith(`:${ROOT}`)).toBe(true)
    expect(deltaKey.split(':')[0]).not.toBe(nativeKey!.split(':')[0])

    // And back: switching the engine off replays the NATIVE checkpoint (its own
    // key was never shadowed by δ's), so the native engine spawns nothing —
    // proof the marker separated the two namespaces in both directions.
    client.setP4delta(undefined)
    await client.runReconcileScan()
    expect(reconcileScans().length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Narrow queries on the δ engine: the watcher flush / `checkWorkingTree` path
// follows the SCAN's engine pick, not a second opinion about the binary.
// ---------------------------------------------------------------------------
//
// Locks in:
//  1. A watcher flush is answered by ONE δ run with the frozen argv (contract
//     switches, the batch's specs, `-`-prefixed exclusions) and zero native
//     `reconcile -n` spawns; δ's rows take the ordinary drift pipeline.
//  2. `no-entry-matched` is a complete EMPTY answer: the queried paths are
//     covered and their stale drift rows are cleared, not counted as failures.
//  3. Every "no conclusion" stream (no summary, non-JSON stdout, `reason:
//     "error"`) leaves the paths' drift standing and counts on the shared
//     ladder — and is NOT re-run natively in the same round.
//  4. Three consecutive failures disarm the engine; later batches run native
//     with zero δ spawns.
//  5. A batch carrying a p4 filespec metacharacter routes native without
//     touching the ladder (routing, not health).
//  6. Under δ a directory is never carved: it asks `<dir>/...` and every
//     exclusion travels in the same argv.

/** A client whose SCAN round already ran — and on δ — so its narrow queries
 *  follow the δ engine too (the verdict is the scan's, see `_narrowQueryEngine`):
 *  before the first scan round a narrow query is native by design, so the δ
 *  narrow path is only reachable this way. `narrow` answers every later δ run;
 *  the scan itself answers an empty (or `scanRows`-seeded) ok:true stream. */
async function makeDeltaNarrowClient(
  narrow: (args: readonly string[]) => P4deltaReply,
  options: {
    /** Drift rows the δ SCAN answers with — they seed the drift set the narrow
     *  queries are then observed against. */
    readonly scanRows?: readonly P4deltaRecord[]
    /** Native `p4` replies: only a routed/fallback batch ever reaches them. */
    readonly responds?: RespondOptions
    readonly clientOptions?: PerforceClientOptions
    readonly disk?: P4CacheDiskBackend
  } = {},
): Promise<{ client: PerforceClientInstance; disk: P4CacheDiskBackend }> {
  const disk = options.disk ?? fakeDisk()
  const client = await makeClient(options.responds ?? {}, disk, fakeClock(), {
    p4delta: { exe: P4DELTA_EXE },
    ...options.clientOptions,
  })
  client.setReconcileScope([LOCAL])
  let phase: 'scan' | 'narrow' = 'scan'
  const scanRows = options.scanRows ?? []
  stubP4deltaRun((args) =>
    phase === 'scan' ? { records: [...scanRows, deltaSummary()] } : narrow(args),
  )
  await client.runReconcileScan()
  // The scan round is the one that selects the engine: it must have answered on
  // δ, or every test below would be measuring the native path.
  expect(client.p4deltaFallbackState).toEqual({ failures: 0, disarmed: false })
  expect(p4deltaCalls).toHaveLength(1)
  p4deltaCalls.length = 0
  phase = 'narrow'
  return { client, disk }
}

/** A watcher whose flush drives the narrow query (delay 0: one macrotask). */
function watchedClientOptions(wt: FakeWatcherController): PerforceClientOptions {
  return {
    createFileSystemWatcher: () => wt.watcher,
    watchRoot: ROOT,
    externalChangeDebounceMs: 0,
  }
}

/** Fire one event and drain the debounced flush it schedules. */
async function flushEvent(
  client: PerforceClientInstance,
  wt: FakeWatcherController,
  kind: 'create' | 'change' | 'delete',
  path: string,
): Promise<void> {
  wt.fire(kind, path)
  await nextMacrotask()
  await client.whenExternalFlushSettled()
}

describe('PerforceClient narrow queries — δ engine', () => {
  beforeEach(() => {
    resetScanHarness()
    p4deltaCalls.length = 0
  })

  afterEach(() => {
    p4deltaRunSpy?.mockRestore()
    p4deltaRunSpy = undefined
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  it('answers a watcher flush with ONE δ run: the frozen argv, no native reconcile spawn', async () => {
    const wt = makeFakeWatcher()
    const { client } = await makeDeltaNarrowClient(
      () => ({
        records: [
          deltaFile('gone/a.txt', 'delete'),
          deltaSummary({ total: 1, counts: { delete: 1 } }),
        ],
      }),
      { clientOptions: watchedClientOptions(wt) },
    )
    client.setReconcileExcludes([`${LOCAL}/ignored`])

    // A deleted directory: `_pathKind` stats for real and ROOT is a fictional
    // tree, so the path is GONE and the batch carries the spec pair — through δ,
    // in ONE call, with the exclusion handed over as a `-`-prefixed entry.
    await flushEvent(client, wt, 'delete', `${LOCAL}/gone`)

    expect(p4deltaCalls).toEqual([
      [
        '--json',
        '--no-scope-file',
        '--client-root',
        ROOT,
        '--no-revert-groups',
        '--',
        `${LOCAL}/gone`,
        `${LOCAL}/gone/...`,
        `-${LOCAL}/ignored/...`,
      ],
    ])
    // The answer is δ's: p4 was never asked to reconcile.
    expect(reconcileScans()).toEqual([])
    // δ's rows exit through the ordinary drift pipeline.
    expect(driftFiles(client)).toContain(`${LOCAL}/gone/a.txt`)
    expect(client.p4deltaFallbackState).toEqual({ failures: 0, disarmed: false })
  })

  it('treats no-entry-matched as a complete empty answer: the paths are covered, not failed', async () => {
    const wt = makeFakeWatcher()
    const { client } = await makeDeltaNarrowClient(
      (args) => ({
        records: [
          ...args.slice(args.indexOf('--') + 1).map((path) => ({ kind: 'unmatched', path })),
          deltaSummary({
            ok: false,
            total: 0,
            scopeMatched: 0,
            unmatched: 2,
            reason: 'no-entry-matched',
          }),
        ],
      }),
      { scanRows: [deltaFile('a.txt', 'edit')], clientOptions: watchedClientOptions(wt) },
    )
    expect(driftFiles(client)).toContain(`${LOCAL}/a.txt`)

    await flushEvent(client, wt, 'change', `${LOCAL}/a.txt`)

    expect(p4deltaCalls).toHaveLength(1)
    // No native re-run: the empty answer IS the answer.
    expect(reconcileScans()).toEqual([])
    // Covered, and that is observable here: `_applyDriftFromWatcher` clears the
    // drift of every covered path the answer left out, so a stale row standing
    // would mean the path was never covered (read as failed instead).
    expect(driftFiles(client)).not.toContain(`${LOCAL}/a.txt`)
    // An answered run is not a failure — the ladder is untouched.
    expect(client.p4deltaFallbackState).toEqual({ failures: 0, disarmed: false })
  })

  const noConclusionCases: ReadonlyArray<readonly [string, () => P4deltaReply]> = [
    ['no summary at all (killed mid-stream)', () => ({ records: [deltaFile('a.txt', 'edit')] })],
    [
      'a non-JSON stdout line (not the engine we think it is)',
      () => ({ records: [deltaSummary()], sawNonJsonStdout: true }),
    ],
    [
      'ok:false with reason "error" (a partial stream)',
      () => ({
        records: [
          deltaFile('a.txt', 'edit'),
          deltaSummary({ ok: false, total: 1, counts: { edit: 1 }, reason: 'error' }),
        ],
      }),
    ],
    [
      'a summary for another mode (an answer to a question nobody asked)',
      () => ({ records: [deltaSummary({ mode: 'clean', applied: true })] }),
    ],
  ]

  for (const [name, reply] of noConclusionCases) {
    it(`leaves the paths' drift standing and counts it when δ answers with ${name}`, async () => {
      const wt = makeFakeWatcher()
      const { client } = await makeDeltaNarrowClient(reply, {
        scanRows: [deltaFile('a.txt', 'edit')],
        clientOptions: watchedClientOptions(wt),
      })
      expect(driftFiles(client)).toContain(`${LOCAL}/a.txt`)

      await flushEvent(client, wt, 'change', `${LOCAL}/a.txt`)

      expect(p4deltaCalls).toHaveLength(1)
      // A failed batch never re-runs natively in the same round (the scan's
      // same-round fallback is a scan-only tradeoff), and the row survives
      // because an unanswered path is not covered — never read as clean.
      expect(reconcileScans()).toEqual([])
      expect(driftFiles(client)).toContain(`${LOCAL}/a.txt`)
      expect(client.p4deltaFallbackState).toEqual({ failures: 1, disarmed: false })
    })
  }

  it('disarms the engine after three consecutive failures; later narrow queries run native', async () => {
    const wt = makeFakeWatcher()
    const { client } = await makeDeltaNarrowClient(
      () => ({ records: [deltaFile('a.txt', 'edit')] }),
      {
        scanRows: [deltaFile('a.txt', 'edit')],
        responds: { reconcile: () => [] },
        clientOptions: watchedClientOptions(wt),
      },
    )

    for (let i = 0; i < 3; i++) {
      await flushEvent(client, wt, 'change', `${LOCAL}/a.txt`)
    }

    expect(p4deltaCalls).toHaveLength(3)
    expect(reconcileScans()).toEqual([])
    expect(client.p4deltaFallbackState).toEqual({ failures: 3, disarmed: true })

    // Disarmed: the next batch goes to p4 with no δ spawn at all.
    await flushEvent(client, wt, 'change', `${LOCAL}/a.txt`)
    expect(p4deltaCalls).toHaveLength(3)
    expect(narrowScans().length).toBe(1)
  })

  it('routes a batch carrying a p4 filespec metacharacter to p4, without counting it', async () => {
    const wt = makeFakeWatcher()
    const { client } = await makeDeltaNarrowClient(
      () => {
        throw new Error('δ must not be asked about a metacharacter batch')
      },
      {
        responds: { reconcile: () => [{ rel: 'weird@name.txt' }] },
        clientOptions: watchedClientOptions(wt),
      },
    )

    await flushEvent(client, wt, 'change', `${LOCAL}/weird@name.txt`)

    expect(p4deltaCalls).toEqual([])
    expect(narrowScans().length).toBe(1)
    // Routing is not a health verdict: the ladder is untouched.
    expect(client.p4deltaFallbackState).toEqual({ failures: 0, disarmed: false })
  })

  it('does not carve under δ: a directory with an excluded subtree asks `<dir>/...` plus the exclusion', async () => {
    const realDir = mkTempDir('p4-dirExcl-')
    const sub = join(realDir, 'sub')
    const excluded = join(sub, 'excluded')
    mkdirSync(excluded, { recursive: true })
    try {
      const wt = makeFakeWatcher()
      const { client } = await makeDeltaNarrowClient(() => ({ records: [deltaSummary()] }), {
        clientOptions: watchedClientOptions(wt),
      })
      client.setReconcileScope([realDir])
      client.setReconcileExcludes([excluded])

      await flushEvent(client, wt, 'change', sub)

      const argv = p4deltaCalls[0]
      expect(argv).toBeDefined()
      // One call, whole directory: δ applies the exclusion itself, which is the
      // entire point of not carving here.
      expect(argv).toContain(`${sub}/...`)
      expect(argv).not.toContain(`${sub}/*`)
      // …and the exclusion must actually be IN that call: an omission would pull
      // a directory the user excluded back into the answer.
      expect(argv).toContain(`-${excluded}/...`)
      expect(reconcileScans()).toEqual([])
    } finally {
      rmSync(realDir, { recursive: true, force: true })
    }
  })

  it('carves a metacharacter directory: its spec must not reach p4 un-carved', async () => {
    const realDir = mkTempDir('p4-metaExcl-')
    const weird = join(realDir, '50%_stuff')
    const excluded = join(weird, 'excluded')
    mkdirSync(excluded, { recursive: true })
    try {
      const wt = makeFakeWatcher()
      const { client } = await makeDeltaNarrowClient(() => ({ records: [deltaSummary()] }), {
        responds: { reconcile: () => [] },
        clientOptions: watchedClientOptions(wt),
      })
      client.setReconcileScope([realDir])
      client.setReconcileExcludes([excluded])

      await flushEvent(client, wt, 'change', weird)

      // A path δ's grammar reads differently takes the carve branch — that is
      // the only branch that can still apply the exclusions, because the client
      // routes every carve product native (they carry `*` / `%25`). Handing δ's
      // un-carved `<dir>/...` over instead would land it on native p4 and
      // re-widen the query past the exclusion the user configured.
      expect(p4deltaCalls).toEqual([])
      expect(reconcileScans()).toHaveLength(1)
      const specs = reconcileSpecs(reconcileScans()[0]!)
      expect(specs.some((s) => s.includes('50%25_stuff/*'))).toBe(true)
      expect(specs.some((s) => s.includes('excluded'))).toBe(false)
    } finally {
      rmSync(realDir, { recursive: true, force: true })
    }
  })

  it('splits a mixed batch: the metacharacter spec goes to p4, the δ-form spec stays on δ', async () => {
    const wt = makeFakeWatcher()
    const { client } = await makeDeltaNarrowClient(() => ({ records: [deltaSummary()] }), {
      responds: { reconcile: () => [{ rel: 'we@ird.txt', action: 'edit' }] },
      clientOptions: watchedClientOptions(wt),
    })

    // One flush = one batch, carrying a spec δ cannot read (the `@` name, which
    // native p4 must answer) next to a metachar-free one. Routing the whole
    // batch native would re-ask the δ spec without the exclusions that only ride
    // on the δ call — so each half goes to its own engine and the answers merge.
    wt.fire('change', `${LOCAL}/a.txt`)
    wt.fire('change', `${LOCAL}/we@ird.txt`)
    await nextMacrotask()
    await client.whenExternalFlushSettled()

    expect(p4deltaCalls).toHaveLength(1)
    expect(p4deltaCalls[0]).toContain(`${LOCAL}/a.txt`)
    expect(p4deltaCalls[0]).not.toContain(`${LOCAL}/we@ird.txt`)
    expect(narrowScans()).toHaveLength(1)
    expect(reconcileSpecs(narrowScans()[0]!)).toContain(`${LOCAL}/we@ird.txt`)
  })

  it('drops the whole batch when one half cannot answer, so no path is read as clean', async () => {
    const wt = makeFakeWatcher()
    const { client } = await makeDeltaNarrowClient(
      () => ({ records: [] }), // the δ half: no summary → no conclusion
      {
        responds: { reconcile: () => [{ rel: 'we@ird.txt', action: 'edit' }] },
        clientOptions: watchedClientOptions(wt),
      },
    )

    wt.fire('change', `${LOCAL}/a.txt`)
    wt.fire('change', `${LOCAL}/we@ird.txt`)
    await nextMacrotask()
    await client.whenExternalFlushSettled()

    // The native half answered, but a half-answer would let `covered` include
    // paths the δ half never answered for — they keep the drift they had.
    expect(p4deltaCalls).toHaveLength(1)
    expect(client.p4deltaFallbackState).toEqual({ failures: 1, disarmed: false })
    expect(driftFiles(client)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Writes on the δ engine: collect (`reconcile`), collect-into (`reconcileInto`)
// and clean (`revertReconcile`) follow the SCAN's engine pick, like narrow
// queries do. Locks in:
//  1. The frozen argv per operation — contract switches, the mode flag, `-a`,
//     `-c` before `--` only when a changelist is named, and EVERY exclusion —
//     with zero native reconcile/clean spawns, and a success that clears the
//     ladder and drops the touched paths out of the drift set.
//  2. Every "no conclusion" stream (no summary, `ok:false`) toasts, counts on
//     the shared ladder, and is NOT re-run natively in the same round.
//  3. Three consecutive failures disarm the engine; the next write is native
//     with zero δ spawns.
//  4. A spec δ's scope grammar cannot read (a carve product `<dir>/*`, the
//     `//...` whole-client wildcard) routes native without counting — routing,
//     not health — while the `//<depot>/...` spelling still goes to δ.
//  5. A user cancel is neither a failure nor a toast, and the clean direction
//     forwards the content-transfer watchdog policy (`timeoutMs: 0`).

describe('PerforceClient writes — δ engine', () => {
  beforeEach(() => {
    resetScanHarness()
    p4deltaCalls.length = 0
    p4deltaRunOptionList.length = 0
  })

  afterEach(() => {
    p4deltaRunSpy?.mockRestore()
    p4deltaRunSpy = undefined
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  /** The native APPLY spawns — `reconcile` without `-n`, and `clean`. The `-n`
   *  previews belong to the scan and to the narrow queries. */
  function writeSpawns(): string[][] {
    return calls.filter(
      (a) => subcommand(a) === 'clean' || (subcommand(a) === 'reconcile' && !a.includes('-n')),
    )
  }

  /** The write argv's fixed head, in the order the contract fixes it. */
  const DELTA_WRITE_HEAD = [
    '--json',
    '--no-scope-file',
    '--client-root',
    ROOT,
    '--no-revert-groups',
  ]

  it('collects through ONE δ run: the frozen argv, every exclusion, no native spawn', async () => {
    const { client } = await makeDeltaNarrowClient(
      () => ({
        records: [deltaSummary({ mode: 'open', applied: true, total: 1, counts: { edit: 1 } })],
        log: ['Applied 1 change.'],
      }),
      { scanRows: [deltaFile('a.txt', 'edit')] },
    )
    client.setReconcileExcludes([`${LOCAL}/ignored`])
    expect(driftFiles(client)).toContain(`${LOCAL}/a.txt`)

    const ok = await client.reconcile([`${LOCAL}/a.txt`, `${LOCAL}/dir/...`])

    expect(ok).toBe(true)
    // One call, applied (`-a`), with every exclusion `-`-prefixed after `--`: an
    // omission would let the write touch a directory the user excluded.
    expect(p4deltaCalls).toEqual([
      [
        ...DELTA_WRITE_HEAD,
        '-a',
        '--',
        `${LOCAL}/a.txt`,
        `${LOCAL}/dir/...`,
        `-${LOCAL}/ignored/...`,
      ],
    ])
    // The answer is δ's: p4 was never asked to apply a reconcile.
    expect(writeSpawns()).toEqual([])
    // A concluded run clears the ladder, and `_invalidateAfterMutation` drops the
    // rows the write touched.
    expect(client.p4deltaFallbackState).toEqual({ failures: 0, disarmed: false })
    expect(driftFiles(client)).not.toContain(`${LOCAL}/a.txt`)
    expect(client.reconcileUsesP4delta).toBe(true)
  })

  it('collects into a named changelist with -c before --, and without -c for default', async () => {
    const { client } = await makeDeltaNarrowClient(() => ({
      records: [deltaSummary({ mode: 'open', applied: true, total: 1, counts: { edit: 1 } })],
    }))

    expect(await client.reconcileInto('1234', [`${LOCAL}/a.txt`])).toBe(true)
    expect(await client.reconcileInto('default', [`${LOCAL}/b.txt`])).toBe(true)

    expect(p4deltaCalls[0]).toEqual([
      ...DELTA_WRITE_HEAD,
      '-c',
      '1234',
      '-a',
      '--',
      `${LOCAL}/a.txt`,
    ])
    expect(p4deltaCalls[1]).toEqual([...DELTA_WRITE_HEAD, '-a', '--', `${LOCAL}/b.txt`])
    expect(writeSpawns()).toEqual([])
  })

  it('cleans through δ with --clean -a and the content-transfer watchdog policy', async () => {
    const { client } = await makeDeltaNarrowClient(() => ({
      records: [
        deltaSummary({ mode: 'clean', applied: true, total: 2, counts: { delete: 1, revert: 1 } }),
      ],
    }))
    client.setReconcileExcludes([`${LOCAL}/ignored`])

    const ok = await client.revertReconcile([`${LOCAL}/dir/...`])

    expect(ok).toBe(true)
    expect(p4deltaCalls).toEqual([
      [...DELTA_WRITE_HEAD, '--clean', '-a', '--', `${LOCAL}/dir/...`, `-${LOCAL}/ignored/...`],
    ])
    // `clean` moves file content, so the native path disarms the watchdog for it
    // (CONTENT_TRANSFER_EXEC) — the engine is handed the same policy.
    expect(p4deltaRunOptionList.at(-1)?.timeoutMs).toBe(0)
    expect(writeSpawns()).toEqual([])
  })

  const noConclusionCases: ReadonlyArray<readonly [string, () => P4deltaReply]> = [
    [
      'no summary at all (killed mid-stream)',
      () => ({ records: [deltaFile('a.txt', 'edit')], log: ['Scanning the workspace.'] }),
    ],
    [
      'ok:false with reason "error" (a partial stream)',
      () => ({
        records: [deltaSummary({ ok: false, reason: 'error' })],
        log: ['Applied 3 change(s).', 'error: p4 add failed for //depot/branch_x/weird.txt'],
      }),
    ],
    [
      'ok:true without "applied" (a preview-shaped stream — nothing was written)',
      () => ({ records: [deltaSummary({ mode: 'open', applied: false })] }),
    ],
    [
      'ok:true for another mode (the other direction answered)',
      () => ({ records: [deltaSummary({ mode: 'clean', applied: true })] }),
    ],
  ]

  for (const [name, reply] of noConclusionCases) {
    it(`toasts and counts WITHOUT re-running natively when δ answers a write with ${name}`, async () => {
      const { client } = await makeDeltaNarrowClient(reply)

      const ok = await client.reconcile([`${LOCAL}/a.txt`])

      expect(ok).toBe(false)
      expect(p4deltaCalls).toHaveLength(1)
      expect(client.p4deltaFallbackState).toEqual({ failures: 1, disarmed: false })
      // No same-round native re-run, unlike the scan: `-a` means δ may already
      // have applied part of the change, and redoing it from a second
      // implementation's reading of the workspace would double it.
      expect(writeSpawns()).toEqual([])
      expect(windowMock.showErrorMessage).toHaveBeenCalledTimes(1)
      const message = String(windowMock.showErrorMessage.mock.calls[0]?.[0] ?? '')
      expect(message).toContain('Perforce reconcile failed')
      expect(message).toContain('p4delta')
    })
  }

  it('clears the ladder on the first concluded run after a failure', async () => {
    let run = 0
    const { client } = await makeDeltaNarrowClient(() =>
      (run += 1) === 1
        ? { records: [] }
        : { records: [deltaSummary({ mode: 'open', applied: true })] },
    )

    expect(await client.reconcile([`${LOCAL}/a.txt`])).toBe(false)
    expect(client.p4deltaFallbackState).toEqual({ failures: 1, disarmed: false })

    // A success resets the count, so a transient failure costs one slow round
    // rather than leaving the engine one strike from being disarmed all session.
    expect(await client.reconcile([`${LOCAL}/a.txt`])).toBe(true)
    expect(client.p4deltaFallbackState).toEqual({ failures: 0, disarmed: false })
  })

  it('disarms after three consecutive failed writes; the next write is native with zero δ spawns', async () => {
    const { client } = await makeDeltaNarrowClient(() => ({ records: [] }))

    for (let i = 0; i < 3; i++) {
      expect(await client.reconcile([`${LOCAL}/a.txt`])).toBe(false)
    }
    expect(p4deltaCalls).toHaveLength(3)
    expect(client.p4deltaFallbackState).toEqual({ failures: 3, disarmed: true })

    // Disarmed: the write goes to p4 with no δ spawn at all.
    expect(await client.reconcile([`${LOCAL}/a.txt`])).toBe(true)
    expect(p4deltaCalls).toHaveLength(3)
    expect(writeSpawns()).toHaveLength(1)
    expect(client.reconcileUsesP4delta).toBe(false)
  })

  it('routes specs δ cannot read to p4 without counting them, and still accepts //<depot>/...', async () => {
    const { client } = await makeDeltaNarrowClient(() => ({
      records: [deltaSummary({ mode: 'open', applied: true })],
    }))
    client.setReconcileExcludes([`${LOCAL}/ignored`])

    // A carve product (`<dir>/*`) the command layer should have skipped under δ,
    // and the whole-client wildcard: both native, and δ is never asked (the
    // counts below are what catches a spec that leaked through).
    expect(await client.reconcile([`${LOCAL}/dir/*`])).toBe(true)
    expect(await client.reconcile(['//...'])).toBe(true)
    expect(await client.revertReconcile([`${LOCAL}/dir/*`])).toBe(true)

    expect(p4deltaCalls).toEqual([])
    expect(writeSpawns()).toHaveLength(3)
    // Routing is not a health verdict: the ladder is untouched.
    expect(client.p4deltaFallbackState).toEqual({ failures: 0, disarmed: false })

    // …while the one depot spelling the contract translates does reach the engine.
    expect(await client.reconcile(['//depot/branch_x/...'])).toBe(true)
    expect(p4deltaCalls).toHaveLength(1)
    expect(p4deltaCalls[0]).toContain('//depot/branch_x/...')
    expect(writeSpawns()).toHaveLength(3)
  })

  it('warns when an un-carved δ-form spec has to fall back to p4', async () => {
    const log: string[] = []
    const { client } = await makeDeltaNarrowClient(() => ({ records: [deltaSummary()] }), {
      responds: { reconcile: () => [] },
      clientOptions: { log: (m) => log.push(m) },
    })

    // `<dir>/...` still carrying a `%` is what a MISSED carve gate looks like —
    // the command layer has to carve such a path before handing it over, because
    // this reject cannot: the raw path is gone by here. The call must still fall
    // back (slow, but the only safe option), and the output channel must say the
    // exclusions may not have been applied.
    expect(await client.reconcile([`${LOCAL}/50%25_stuff/...`])).toBe(true)
    expect(p4deltaCalls).toEqual([])
    expect(writeSpawns()).toHaveLength(1)
    expect(log.join('\n')).toContain('WARNING')
    expect(log.join('\n')).toContain('exclude folders may NOT have been applied')

    // A carve product (`<dir>/*`, and the escaped clean-subdir specs a carve
    // emits) is the legitimately native shape: routing it must stay silent.
    log.length = 0
    expect(await client.reconcile([`${LOCAL}/dir/*`, `${LOCAL}/dir/ok/...`])).toBe(true)
    expect(writeSpawns()).toHaveLength(2)
    expect(log.join('\n')).not.toContain('WARNING')
  })

  it('a reconfiguration retracts the scan verdict: writes run native until δ scans again', async () => {
    const { client } = await makeDeltaNarrowClient(() => ({ records: [deltaSummary()] }), {
      responds: { reconcile: () => [] },
    })
    expect(client.reconcileUsesP4delta).toBe(true)

    // Re-pointing the session at an engine that has never answered a scan HERE:
    // the proof belonged to the old binary, and the next click — a whole-set
    // collect, or a `--clean` — must not be handed to an unproven one.
    client.setP4delta(P4DELTA_EXE)
    expect(client.reconcileUsesP4delta).toBe(false)
    expect(await client.reconcile([`${LOCAL}/a.txt`])).toBe(true)
    expect(p4deltaCalls).toEqual([])
    expect(writeSpawns()).toHaveLength(1)

    // A scan round that answers on δ is what restores the routing.
    await client.runReconcileScan()
    expect(client.reconcileUsesP4delta).toBe(true)
  })

  it('treats a user cancel as neither a failure nor a toast', async () => {
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const { client } = await makeDeltaNarrowClient(() => ({ hold, records: [] }))

    const pending = client.reconcile([`${LOCAL}/a.txt`])
    // The δ run is in flight (the stub is holding it open) and cancellable.
    expect(p4deltaCalls).toHaveLength(1)
    client.cancelBusy()
    release()

    expect(await pending).toBe(false)
    expect(client.p4deltaFallbackState).toEqual({ failures: 0, disarmed: false })
    expect(windowMock.showErrorMessage).not.toHaveBeenCalled()
  })
})

describe('㉑ reconcile-scan checkpoint 跨 session 持久化（真磁盘）', () => {
  let root: string
  let disk: P4CacheDiskInstance

  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
    readdirMock.mockReset()
    // 同主 describe：冷 prior 文件计数默认空列表，只有测试关心 split 时才覆写。
    readdirMock.mockImplementation(async () => [])
    calls.length = 0
    groups.length = 0
    reconcileGroupThrow = false
    heldChildren.length = 0
    currentClock = undefined
    windowMock.showErrorMessage.mockClear()
    root = mkTempDir('p4cache-')
    disk = P4CacheDisk.open(root, 1024 * 1024)!
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
    rmSync(root, { recursive: true, force: true })
  })

  it('单个外部文件事件不得删除磁盘上的 checkpoint', async () => {
    const wt = makeFakeWatcher()
    const client = await makeClient(
      { reconcile: () => [{ rel: 'changed.txt', action: 'edit' }] },
      disk,
      fakeClock(),
      { createFileSystemWatcher: () => wt.watcher, watchRoot: ROOT, externalChangeDebounceMs: 0 },
    )
    client.setReconcileScope([LOCAL])
    client.scheduleReconcileScan()
    await client.whenReconcileScanSettled()

    // 扫描完成后 checkpoint 已物理落盘：reconcileScan/ 目录下恰好一个值文件。
    expect(readdirSync(join(root, 'reconcileScan'))).toHaveLength(1)

    wt.fire('change', `${LOCAL}/a.txt`)
    await nextMacrotask()
    await client.whenExternalFlushSettled()

    // 工作区内任意一个文件的 watcher 事件都命中 root checkpoint，但不能把
    // 磁盘上的那个值文件删掉 —— 否则下次重开工作区必然全量重扫。
    expect(readdirSync(join(root, 'reconcileScan'))).toHaveLength(1)
  })

  it('跨 session 复用 checkpoint，零重扫', async () => {
    const wt = makeFakeWatcher()
    const client1 = await makeClient(
      { reconcile: () => [{ rel: 'changed.txt', action: 'edit' }] },
      disk,
      fakeClock(),
      { createFileSystemWatcher: () => wt.watcher, watchRoot: ROOT, externalChangeDebounceMs: 0 },
    )
    client1.setReconcileScope([LOCAL])
    client1.scheduleReconcileScan()
    await client1.whenReconcileScanSettled()
    expect(fullScanScans()).toHaveLength(1)

    // 用户保存一个文件 → watcher flush → root checkpoint 被删（bug）。
    wt.fire('change', `${LOCAL}/a.txt`)
    await nextMacrotask()
    await client1.whenExternalFlushSettled()
    client1.dispose()

    // 重开工作区：新 client 对同一目录重新 open 一个 disk（真实场景）。
    calls.length = 0
    await nextMacrotask()
    const disk2 = P4CacheDisk.open(root, 1024 * 1024)!
    const client2 = await makeClient(
      { reconcile: () => [{ rel: 'changed.txt', action: 'edit' }] },
      disk2,
      fakeClock(),
    )
    client2.setReconcileScope([LOCAL])
    client2.scheduleReconcileScan()
    await client2.whenReconcileScanSettled()

    // checkpoint 新鲜、直接 served，零整目录 spawn。当前代码下 checkpoint 已被
    // 删除，client2 必然重扫。
    expect(fullScanScans()).toHaveLength(0)
  })
})

describe('PerforceClient.driftGroupPaths', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
    readdirMock.mockReset()
    readdirMock.mockImplementation(async () => [])
    calls.length = 0
    groups.length = 0
    reconcileGroupThrow = false
    heldChildren.length = 0
    currentClock = undefined
    windowMock.showErrorMessage.mockClear()
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  it('returns only the rows the group renders: not opened, not excluded, sorted', async () => {
    const client = await makeClient(
      {
        opened: () => [{ rel: 'opened.txt' }],
        reconcile: () => [
          { rel: 'zeta.txt' },
          { rel: 'opened.txt' },
          { rel: 'excluded/e.txt' },
          { rel: 'alpha.txt' },
        ],
      },
      fakeDisk(),
    )
    // Scan WITHOUT the exclusion first so excluded/e.txt is merged into
    // _driftFiles; the carve would otherwise keep p4 from ever reporting it,
    // and the `_isExcluded` filter inside driftGroupPaths would go untested.
    client.setReconcileScope([LOCAL])
    await client.refresh()
    await client.runReconcileScan()
    client.setReconcileExcludes([`${LOCAL}/excluded`])

    // opened.txt is dropped (still opened), excluded/e.txt is dropped (excluded
    // dir); the rest come back sorted by local path, matching _applyDriftGroup.
    expect(client.driftGroupPaths()).toEqual([`${LOCAL}/alpha.txt`, `${LOCAL}/zeta.txt`])
  })

  it('returns an empty list when every drift row is opened or excluded', async () => {
    const client = await makeClient(
      {
        opened: () => [{ rel: 'a.txt' }],
        reconcile: (spec) => (spec.endsWith('...') ? [{ rel: 'a.txt' }] : []),
      },
      fakeDisk(),
    )
    client.setReconcileScope([LOCAL])
    await client.refresh()
    await client.runReconcileScan()

    expect(client.driftGroupPaths()).toEqual([])
  })

  it('drops rows outside the current scope, mirroring the group filter', async () => {
    // Regression: `driftGroupPaths` filtered on opened/excluded only, so a
    // group-header collect-all would gather rows the narrowed group itself no
    // longer renders. The action targets must be exactly what the user sees.
    const client = await makeClient({ reconcile: () => [] }, fakeDisk())
    client.setReconcileScope([`${LOCAL}/other`])

    // Seed a drift row outside the scope directly (a stale checkpoint merge is
    // the real-world source of such a row; `_clearDrift` on the scope change
    // above makes a scan-then-narrow sequence useless for this).
    ;(
      client as unknown as {
        _applyDriftFromWatcher(
          covered: readonly string[],
          rows: readonly { clientFile?: string; depotFile: string; action: string; rev: string }[],
        ): void
      }
    )._applyDriftFromWatcher(
      [`${LOCAL}/other/in-scope.txt`, `${LOCAL}/elsewhere/out.txt`],
      [
        {
          clientFile: `${LOCAL}/other/in-scope.txt`,
          depotFile: '//depot/branch_x/other/in-scope.txt',
          action: 'edit',
          rev: '1',
        },
        {
          clientFile: `${LOCAL}/elsewhere/out.txt`,
          depotFile: '//depot/branch_x/elsewhere/out.txt',
          action: 'edit',
          rev: '1',
        },
      ],
    )

    // Both rows are in `_driftFiles`…
    expect(driftFiles(client).sort()).toEqual([
      `${LOCAL}/elsewhere/out.txt`,
      `${LOCAL}/other/in-scope.txt`,
    ])
    // …but the action targets exclude the out-of-scope one, exactly like the
    // rendered group does.
    expect(client.driftGroupPaths()).toEqual([`${LOCAL}/other/in-scope.txt`])
  })
})

/**
 * `sync` is the one pull entry point that does NOT route through `_mutate`, so it
 * never ran `_removeDriftUnder`. A force-get rewrites the local file to match its
 * (new) have revision — any drift row for it is stale — but the row survived to
 * the end of the session: the watcher's own writes are suppressed, and the
 * reconcile scan is armed once per session. These tests lock the fix: the sync
 * run subtracts exactly the files p4 reported as applied, and only those.
 */
describe('PerforceClient.sync and the drift set', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
    readdirMock.mockReset()
    readdirMock.mockImplementation(async () => [])
    calls.length = 0
    groups.length = 0
    reconcileGroupThrow = false
    heldChildren.length = 0
    currentClock = undefined
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  /** The sync argv seen so far. */
  function syncCalls(): string[][] {
    return calls.filter((a) => subcommand(a) === 'sync')
  }

  /** Seed `a.txt` into the drift set via a reconcile scan, returning the client. */
  async function clientWithDrift(
    sync: RespondOptions['sync'],
    rels: string[] = ['a.txt'],
  ): Promise<PerforceClientInstance> {
    const client = await makeClient({
      reconcile: () => rels.map((rel) => ({ rel, action: 'edit' })),
      ...(sync !== undefined ? { sync } : {}),
    })
    client.setReconcileScope([LOCAL])
    await client.runReconcileScan()
    return client
  }

  it('removes a drift row when a force get overwrites it (the reported bug)', async () => {
    const client = await clientWithDrift(() => ({
      stdout: `//depot/branch_x/a.txt#1 - refreshing ${LOCAL}/a.txt\n`,
    }))
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])

    const result = await client.syncFiles([`${LOCAL}/a.txt`], '#head', { force: true })

    expect(result.ok).toBe(true)
    // The force flag actually reached p4.
    expect(syncCalls().some((a) => a.includes('-f'))).toBe(true)
    // The row is gone from both the rendered group and the underlying drift set.
    expect(groupRows(client)).toEqual([])
    expect(driftFiles(client)).toEqual([])
  })

  it('keeps a drift row p4 refused to overwrite', async () => {
    const client = await clientWithDrift(() => ({
      stdout: `//depot/branch_x/a.txt#1 - can't update modified file ${LOCAL}/a.txt\n`,
    }))
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])

    // Non-force get: the allwrite/noclobber client refuses the locally-modified file.
    const result = await client.syncFiles([`${LOCAL}/a.txt`], '#head')

    expect(result.ok).toBe(true)
    expect(result.refusedFiles).toHaveLength(1)
    // The file on disk was NOT rewritten, so the drift must survive.
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])
    expect(driftFiles(client)).toEqual([`${LOCAL}/a.txt`])
  })

  it('removes only the applied rows from a mixed-scope drift set', async () => {
    const client = await clientWithDrift(
      () => ({ stdout: `//depot/branch_x/a.txt#1 - refreshing ${LOCAL}/a.txt\n` }),
      ['a.txt', 'b.txt'],
    )
    expect(
      groupRows(client)
        .map((r) => r.path)
        .sort(),
    ).toEqual([`${LOCAL}/a.txt`, `${LOCAL}/b.txt`])

    // The sync touched only a.txt; b.txt was never on the wire.
    await client.syncFiles([`${LOCAL}/a.txt`], '#head', { force: true })

    expect(driftFiles(client)).toEqual([`${LOCAL}/b.txt`])
  })

  it('leaves the drift set alone on an up-to-date early exit', async () => {
    const client = await clientWithDrift(() => ({
      stdout: '',
      stderr: 'file(s) up-to-date.\n',
    }))
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])
    const narrowBefore = narrowScans().length

    const result = await client.syncFiles([`${LOCAL}/a.txt`], '#head', { force: true })

    expect(result.ok).toBe(true)
    // applied === 0, so nothing is removed and the fallback narrow query must NOT
    // fire (no parse gap to backfill).
    expect(driftFiles(client)).toEqual([`${LOCAL}/a.txt`])
    expect(narrowScans().length).toBe(narrowBefore)
  })

  it('removes drift on the streaming (onProgress) path too', async () => {
    const client = await clientWithDrift(() => ({
      stdout: `//depot/branch_x/a.txt#1 - refreshing ${LOCAL}/a.txt\n`,
    }))
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])

    // runSync always streams: the summary is accumulated line-by-line and the
    // buffered stdout never materializes. This is the production hot path.
    const result = await client.sync('#head', { onProgress: () => {} })

    expect(result.ok).toBe(true)
    expect(result.summary?.applied).toBe(1)
    expect(driftFiles(client)).toEqual([])
  })

  it('does not delete a real drift row when an applied line extracts to a junk path', async () => {
    // `- updating as` with no trailing path is a degenerate line: extraction
    // succeeds but the "path" is the literal word `as`, which matches no drift
    // key. The row for the file actually on disk must survive — subtracting by
    // junk would be the destructive "delete too much" failure.
    const client = await clientWithDrift(() => ({
      stdout: '//depot/branch_x/a.txt#1 - updating as \n',
    }))
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])

    await client.syncFiles([`${LOCAL}/a.txt`], '#head', { force: true })

    expect(driftFiles(client)).toEqual([`${LOCAL}/a.txt`])
  })

  it('revalidates remaining drift via a narrow reconcile when asked (the gap fallback)', async () => {
    // The count-vs-extraction gap that triggers `_revalidateDriftAfterSync` is not
    // reachable through real sync text (the counter and the extractor share one
    // verb table), so drive the fallback directly, the same way the scope test
    // above drives `_applyDriftFromWatcher`. The directory scan seeds the row; the
    // narrow per-file re-query then reports the file clean (a filespec that names
    // the file directly), and the row is dropped.
    const client = await makeClient({
      reconcile: (filespec) =>
        filespec.endsWith('/a.txt') ? [] : [{ rel: 'a.txt', action: 'edit' }],
    })
    client.setReconcileScope([LOCAL])
    await client.runReconcileScan()
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])
    const narrowBefore = narrowScans().length

    await (
      client as unknown as { _revalidateDriftAfterSync(): Promise<void> }
    )._revalidateDriftAfterSync()

    expect(narrowScans().length).toBeGreaterThan(narrowBefore)
    expect(driftFiles(client)).toEqual([])
  })

  it('keeps drift rows when the fallback narrow query fails', async () => {
    // A failed narrow query reports "unknown", and unknown must never be recorded
    // as "clean" — the row is kept for the next scan to settle.
    const client = await makeClient({
      reconcile: (filespec) =>
        filespec.endsWith('/a.txt') ? undefined : [{ rel: 'a.txt', action: 'edit' }],
      reconcileExit: (filespec) => (filespec.endsWith('/a.txt') ? 1 : undefined),
      reconcileStderr: () => 'reconcile -n boom',
    })
    client.setReconcileScope([LOCAL])
    await client.runReconcileScan()
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])

    await (
      client as unknown as { _revalidateDriftAfterSync(): Promise<void> }
    )._revalidateDriftAfterSync()

    expect(driftFiles(client)).toEqual([`${LOCAL}/a.txt`])
  })

  it('removes rows applied before the run was cancelled', async () => {
    // Emit one applied line, then never close: cancelBusy kills the run, but the
    // file p4 already reported IS on disk matching its have revision. Driven on
    // the streaming path (onProgress) — the applied row is collected as it
    // arrives, so it survives the abort; a buffered run's stdout is lost with the
    // killed child and has nothing to subtract.
    const client = await makeClient({
      reconcile: () => [{ rel: 'a.txt', action: 'edit' }],
      sync: () => ({ stdout: `//depot/branch_x/a.txt#1 - refreshing ${LOCAL}/a.txt\n`, exit: 0 }),
    })
    client.setReconcileScope([LOCAL])
    await client.runReconcileScan()
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RM' }])

    const pending = client.sync('#head', { force: true, onProgress: () => {} })
    client.cancelBusy()
    const result = await pending

    expect(result.cancelled).toBe(true)
    expect(driftFiles(client)).toEqual([])
  })
})
