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
 *     `reconcile -n` about those exact files plus an incremental drift merge — never
 *     by re-walking `<dir>/...`; the covering checkpoint is PATCHED in place with
 *     that answer (preserving `completedAt`) rather than dropped, because with a
 *     root-level scope every file covers the single root checkpoint and dropping
 *     it cost the next session a full re-walk. Three cases still invalidate: a
 *     bulk change past the path budget, a directory event (the query is per-file
 *     and would read a directory as clean), and a failed query. An in-flight
 *     round is fenced by re-invalidating once it settles — a patch cannot fence a
 *     checkpoint that round has not written yet. Excluded / out-of-scope /
 *     self-mutation / offline / disposed events query nothing at all.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileSystemWatcher } from '@universe-editor/extension-api'
import { expandP4Argv } from './expandP4Argv.js'

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
   *  special handling" (empty success). */
  reconcile?: (filespec: string) => { rel: string; action?: string }[] | undefined
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
    // The filespec is the trailing arg of `reconcile -n -a -e -d <filespec>`.
    const filespec = argv[argv.length - 1] ?? ''
    const delay = opts.reconcileDelayMs?.(filespec)
    if (delay) currentClock?.advance(delay)
    const timeoutRows = opts.reconcileTimeout?.(filespec)
    if (timeoutRows) return { stdout: reconcileRows(timeoutRows), hold: true }
    if (opts.reconcileHold?.(filespec)) return { stdout: '', hold: true }
    const exit = opts.reconcileExit?.(filespec)
    if (exit !== undefined && exit !== 0) {
      return { stdout: '', stderr: opts.reconcileStderr?.(filespec) ?? 'reconcile failed', exit }
    }
    const rows = opts.reconcile?.(filespec) ?? []
    return { stdout: reconcileRows(rows) }
  }
  if (cmd === 'clean') {
    const exit = opts.cleanExit
    if (exit !== undefined && exit !== 0) {
      return { stdout: '', stderr: opts.cleanStderr ?? 'clean failed', exit }
    }
    return { stdout: '' }
  }
  // changes / fstat / describe — succeed silently with no records.
  return { stdout: '' }
}

/** All `reconcile -n` argv seen so far (each is the full p4 argv). */
function reconcileScans(): string[][] {
  return calls.filter((a) => subcommand(a) === 'reconcile' && a.includes('-n'))
}

/**
 * The background scan's own spawns: a `reconcile -n` carrying at least one
 * recursive/wildcard filespec (`<dir>/...` or a carved `<dir>/*`).
 *
 * Split from {@link narrowScans} because BOTH are `reconcile -n` — asserting on
 * `reconcileScans().length` cannot tell "re-walked the whole directory" from
 * "asked about three files", which is exactly the distinction the watcher's
 * narrow-query design turns on.
 */
function fullScanScans(): string[][] {
  return reconcileScans().filter((a) => a.some((arg) => /[/\\](\.\.\.|\*)$/.test(arg)))
}

/** The per-file spawns: a `reconcile -n` whose filespecs are all concrete paths
 *  (the watcher flush and `checkWorkingTree`). */
function narrowScans(): string[][] {
  return reconcileScans().filter((a) => !a.some((arg) => /[/\\](\.\.\.|\*)$/.test(arg)))
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
    // path is the local file and the letter is RC, never the action letter.
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RC' }])
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
    expect(groupRows(first)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RC' }])
    expect(groupRows(second)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RC' }])
  })

  // --- ⑤ focus fingerprint ----------------------------------------------------

  it('a focus-scope change invalidates the checkpoint (different fingerprint)', async () => {
    const disk = fakeDisk()
    const client = await makeClient(
      {
        reconcile: (filespec) => {
          if (filespec === `${LOCAL}/A/...`) return [{ rel: 'in-a.txt' }]
          if (filespec === `${LOCAL}/B/...`) return [{ rel: 'in-b.txt' }]
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
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/in-b.txt`, letter: 'RC' }])
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
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/b.txt`, letter: 'RC' }])
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

    // The scan never touches the SCM view's state...
    expect(sc.count).toBeUndefined()
    // ...and the only change emits are the status-bar bookkeeping: busy label
    // push/pop (2) plus cancellable registration/deregistration (2) plus the
    // scan-progress start and terminal flush (2). No publish or checkpoint
    // emits anything, and the throttled intermediate frames never fire (the scan
    // finishes within one throttle window).
    expect(changes).toBe(6)
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
      expect(groupRows(client)).toEqual([{ path: `${LOCAL}/top.txt`, letter: 'RC' }])
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
      expect(groupRows(client)).toEqual([{ path: `${LOCAL}/top.txt`, letter: 'RC' }])
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
    expect(groupRows(second)).toEqual([{ path: `${LOCAL}/sub1/a.txt`, letter: 'RC' }])
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
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/sub1/a.txt`, letter: 'RC' }])
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
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/included/a.txt`, letter: 'RC' }])
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
      { path: `${LOCAL}/included/a.txt`, letter: 'RC' },
      { path: `${LOCAL}/top.txt`, letter: 'RC' },
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
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/src/included/a.txt`, letter: 'RC' }])
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
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/src/included/a.txt`, letter: 'RC' }])
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
    // Batching loses nothing: every fired path was asked about exactly once.
    const asked = narrow.flat().filter((a) => a.startsWith(`${LOCAL}/f`))
    expect(new Set(asked).size).toBe(fired)
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

  it('re-adds reverted files as drift so they land in Working Tree Changes', async () => {
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

  it('ignores external events outside the scope or inside an excluded directory', async () => {
    const wt = makeFakeWatcher()
    const client = await makeClient({ reconcile: () => [] }, fakeDisk(), fakeClock(), {
      createFileSystemWatcher: () => wt.watcher,
      watchRoot: ROOT,
      externalChangeDebounceMs: 0,
    })
    client.setReconcileScope([`${LOCAL}/sub`])
    client.scheduleReconcileScan()
    await client.whenReconcileScanSettled()
    expect(reconcileScans()).toHaveLength(1)

    client.setReconcileExcludes([`${LOCAL}/sub/excluded`])
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

  it('a directory event invalidates the covering checkpoint instead of reading it as clean', async () => {
    // _isDirectoryPath stats the path for real, so the event must name a path
    // that actually IS a directory on disk — a faked path would read as a file
    // and take the narrow-query branch this test exists to prove is skipped.
    const realDir = mkdtempSync(join(tmpdir(), 'p4-dirEvt-'))
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

      // A directory event (new folder, moved subtree) names no file, so a
      // per-file narrow query would read it as clean and stamp that lie into the
      // checkpoint. The flush must refuse to merge and drop the checkpoint instead.
      wt.fire('change', realDir)
      await nextMacrotask()
      await client.whenExternalFlushSettled()

      expect(narrowScans()).toHaveLength(0)
      expect(fullScanScans()).toHaveLength(1)
      expect([...disk.store.keys()].some((k) => k.endsWith(realDir))).toBe(false)
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
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/in-a.txt`, letter: 'RC' }])
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
      { path: `${LOCAL}/sub/in-s.txt`, letter: 'RC' },
      { path: `${LOCAL}/top.txt`, letter: 'RC' },
    ])

    cleaned = true
    await client.revertReconcile([`${join(LOCAL, 'sub')}/...`])
    await client.whenReconcileScanSettled()

    // Only the sub tree's row is gone; the sibling row survives its own tint.
    expect(driftFiles(client).sort()).toEqual([`${LOCAL}/top.txt`])
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/top.txt`, letter: 'RC' }])
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
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/in-a.txt`, letter: 'RC' }])

    const ok = await client.revertReconcile([`${LOCAL}/...`])
    expect(ok).toBe(false)
    await client.whenReconcileScanSettled()

    // The disk was not cleaned, so the drift must survive the failed mutation.
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/in-a.txt`, letter: 'RC' }])
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
    expect(groupRows(client)).toEqual([{ path: `${LOCAL}/a.txt`, letter: 'RC' }])
    expect(driftFiles(client).sort()).toEqual([`${LOCAL}/a.txt`, `${LOCAL}/b.txt`])
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
    root = mkdtempSync(join(tmpdir(), 'p4cache-'))
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
