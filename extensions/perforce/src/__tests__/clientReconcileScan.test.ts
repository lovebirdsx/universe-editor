/**
 * Unit tests for `PerforceClient.runReconcileScan` — the background dry-run
 * `reconcile -n` walk that tints Explorer folders ahead of their files being
 * rendered. This locks in:
 *  1. Each directory batch is published to the renderer the moment it lands and
 *     checkpointed into the persistent cache (per-directory resume points).
 *  2. A clean directory is a RESULT (checkpointed with an empty hint list), a
 *     failed batch is not — failure must never be cached as "nothing to see"
 *     (a SLOW failure only writes a split marker, never hints).
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
 *  7. Files already opened are filtered out at publish time.
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
 */
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
/** Every `publishWorkingTreeScan` batch every client pushed. */
const published: Array<{ directory: string; changes: Array<{ path: string }> }> = []
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
      createResourceGroup: (id: string) => ({
        id,
        label: '',
        hideWhenEmpty: undefined,
        resourceStates: [],
        dispose() {},
      }),
      setSupplementaryDecorations: () => {},
      publishWorkingTreeScan: (
        entries: Array<{ directory: string; changes: Array<{ path: string }> }>,
      ) => {
        published.push(...entries)
      },
      dispose() {},
    }),
  }
}

const { PerforceClient } = await import('../client.js')
const { ConcurrencyGate } = await import('../concurrency.js')
const { setP4CommandTimeoutSeconds } = await import('../p4Service.js')
const { RECONCILE_SCAN_PRESPLIT_FILE_COUNT_THRESHOLD } = await import('../reconcileScanBudget.js')
type PerforceClientInstance = import('../client.js').PerforceClient
type P4CacheDiskBackend = import('../p4Cache.js').P4CacheDiskBackend

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
}

const calls: string[][] = []

function respond(opts: RespondOptions = {}): void {
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[1] as string[]) ?? []
    calls.push(argv)
    const child = new FakeChildProcess()
    queueMicrotask(() => {
      const { stdout, stderr, exit, hold } = handle(argv, opts)
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      if (hold) return
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
  // changes / fstat / describe — succeed silently with no records.
  return { stdout: '' }
}

/** All `reconcile -n` argv seen so far (each is the full p4 argv). */
function reconcileScans(): string[][] {
  return calls.filter((a) => subcommand(a) === 'reconcile' && a.includes('-n'))
}

let currentClock: ReturnType<typeof fakeClock> | undefined

async function makeClient(
  opts: RespondOptions = {},
  disk?: ReturnType<typeof fakeDisk>,
  clock = fakeClock(),
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
    undefined,
  )
  expect(client).toBeDefined()
  return client!
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
    published.length = 0
    currentClock = undefined
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

    expect(published).toHaveLength(1)
    expect(published[0]!.directory).toBe(LOCAL)
    // The hint derives from the same reconcile row style as the resource group:
    // letter RC, never the action letter.
    expect(published[0]!.changes).toEqual([
      expect.objectContaining({ path: `${LOCAL}/a.txt`, letter: 'RC' }),
    ])
    // One checkpoint under the scan namespace.
    expect(disk.store.size).toBe(1)
    const [key] = [...disk.store.keys()]
    expect(key).toContain('reconcileScan/')
    const entry = JSON.parse(disk.store.get(key!)!) as { completedAt: number; hints: unknown[] }
    expect(entry.completedAt).toBeTypeOf('number')
    expect(entry.hints).toHaveLength(1)
  })

  it('checkpoints a clean directory as a result (empty hint list)', async () => {
    const disk = fakeDisk()
    const client = await makeClient({ reconcile: () => [] }, disk)
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    expect(published).toEqual([{ directory: LOCAL, changes: [] }])
    expect(disk.store.size).toBe(1)
    const entry = JSON.parse([...disk.store.values()][0]!) as { hints: unknown[] }
    expect(entry.hints).toEqual([])
  })

  // --- ② failure is never cached as clean ------------------------------------

  it('leaves a failed directory un-checkpointed and unpushed', async () => {
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

    expect(published).toHaveLength(0)
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

    expect(published).toEqual([{ directory: LOCAL, changes: [] }])
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
    expect(published.map((p) => p.directory)).toEqual([
      LOCAL,
      join(LOCAL, 'sub1'),
      join(LOCAL, 'sub2'),
    ])
    expect(published[0]!.changes).toHaveLength(1)
    expect(published[1]!.changes).toHaveLength(1)
    expect(published[2]!.changes).toHaveLength(0)
    // The slow parent checkpoints the SPLIT itself (a marker with no hints — its
    // result was published just above), so the next session resumes at the
    // subdirectories instead of re-running the slow batch; the two fast
    // subdirectories checkpoint their results.
    const keys = [...disk.store.keys()]
    expect(keys).toHaveLength(3)
    const parentKey = keys.find((k) => k.includes('reconcileScan/') && !k.includes('sub'))
    expect(parentKey).toBeDefined()
    const parentEntry = JSON.parse(disk.store.get(parentKey!)!) as {
      split?: boolean
      hints: unknown[]
    }
    expect(parentEntry.split).toBe(true)
    expect(parentEntry.hints).toEqual([])
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
    expect(published.map((p) => p.directory)).toEqual([join(LOCAL, 'sub1'), join(LOCAL, 'sub2')])
    expect(published[0]!.changes).toHaveLength(1)
    expect(published[1]!.changes).toHaveLength(0)
    // The parent checkpoints the SPLIT marker (no hints — there was no result);
    // the subdirectories checkpoint their results, so the next session resumes
    // at the subdirectories instead of re-running the doomed parent batch.
    const keys = [...disk.store.keys()]
    expect(keys).toHaveLength(3)
    const parentKey = keys.find((k) => k.includes('reconcileScan/') && !k.includes('sub'))
    expect(parentKey).toBeDefined()
    const parentEntry = JSON.parse(disk.store.get(parentKey!)!) as {
      split?: boolean
      hints: unknown[]
    }
    expect(parentEntry.split).toBe(true)
    expect(parentEntry.hints).toEqual([])
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

    expect(published).toHaveLength(0)
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

    expect(published).toHaveLength(0)
    expect(disk.store.size).toBe(0)
  })

  it('does not split a fast batch', async () => {
    const disk = fakeDisk()
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] }, disk)
    client.setReconcileScope([LOCAL])

    await client.runReconcileScan()

    expect(published).toHaveLength(1)
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

    expect(published).toHaveLength(1)
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

    expect(published).toEqual([{ directory: LOCAL, changes: [] }])
    expect(disk.store.size).toBe(1)
    const entry = JSON.parse([...disk.store.values()][0]!) as { hints: unknown[]; split?: boolean }
    expect(entry.hints).toEqual([])
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
    expect(published).toHaveLength(2)
    expect(published[1]!.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: `${LOCAL}/a.txt` })]),
    )
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
    const pushed = published.flatMap((p) => p.changes.map((c) => c.path))
    expect(pushed).toContain(`${LOCAL}/in-b.txt`)
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
    expect(published.map((p) => p.directory)).toEqual([`${LOCAL}/A`])
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

    const pushed = published.flatMap((p) => p.changes.map((c) => c.path))
    expect(pushed).not.toContain(`${LOCAL}/a.txt`)
    expect(pushed).toContain(`${LOCAL}/b.txt`)
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
    // The parent's own hints are not double-published by the split replay; the
    // subdirectory checkpoints publish theirs.
    expect(published.map((p) => p.directory)).toEqual([
      LOCAL,
      join(LOCAL, 'sub1'),
      join(LOCAL, 'sub2'),
      join(LOCAL, 'sub1'),
      join(LOCAL, 'sub2'),
    ])
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

    expect(published).toHaveLength(0)
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
    const sc = client as unknown as {
      _sc: { publishWorkingTreeScan: (entries: unknown) => void }
    }
    sc._sc.publishWorkingTreeScan = () => {
      throw new Error('publish boom')
    }

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
      expect(published.map((p) => p.directory)).toEqual([
        LOCAL,
        join(LOCAL, 'sub1'),
        join(LOCAL, 'sub2'),
      ])
      expect(published[0]!.changes).toHaveLength(1)
      expect(published[0]!.changes[0]!.path).toBe(`${LOCAL}/top.txt`)
      // …but its checkpoint is the SPLIT marker (no hints), not a result entry.
      const keys = [...disk.store.keys()]
      expect(keys).toHaveLength(3)
      const parentKey = keys.find((k) => k.includes('reconcileScan/') && !k.includes('sub'))
      expect(parentKey).toBeDefined()
      const parentEntry = JSON.parse(disk.store.get(parentKey!)!) as {
        split?: boolean
        hints: unknown[]
      }
      expect(parentEntry.split).toBe(true)
      expect(parentEntry.hints).toEqual([])
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
      expect(published).toHaveLength(1)
      expect(published[0]!.changes).toHaveLength(1)
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
      expect(published.map((p) => p.directory)).toEqual([join(LOCAL, 'sub1')])
      const keys = [...disk.store.keys()]
      expect(keys).toHaveLength(2)
      const parentKey = keys.find((k) => k.includes('reconcileScan/') && !k.includes('sub'))
      expect(parentKey).toBeDefined()
      const parentEntry = JSON.parse(disk.store.get(parentKey!)!) as {
        split?: boolean
        hints: unknown[]
      }
      expect(parentEntry.split).toBe(true)
      expect(parentEntry.hints).toEqual([])
      // …and the clean subdirectory checkpointed as a normal result (no split).
      const subKey = keys.find((k) => k.includes('reconcileScan/') && k.includes('sub'))
      expect(subKey).toBeDefined()
      const subEntry = JSON.parse(disk.store.get(subKey!)!) as { split?: boolean; hints: unknown[] }
      expect(subEntry.split).toBeUndefined()
      expect(subEntry.hints).toEqual([])
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
    const marker = JSON.parse(disk.store.get(parentKey!)!) as { split?: boolean; hints: unknown[] }
    expect(marker.split).toBe(true)
    expect(marker.hints).toEqual([])
    expect(published.map((p) => p.directory)).toEqual([
      LOCAL,
      join(LOCAL, 'sub1'),
      join(LOCAL, 'sub2'),
    ])
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
      hints: unknown[]
    }
    expect(parentEntry.split).toBe(true)
    expect(parentEntry.hints).toEqual([])
    const subEntry = JSON.parse(disk.store.get(keys.find((k) => k.includes('sub'))!)!) as {
      split?: boolean
      hints: unknown[]
    }
    expect(subEntry.split).toBeUndefined()
    expect(subEntry.hints).toHaveLength(1)
    expect(published.map((p) => p.directory)).toEqual([join(LOCAL, 'sub1')])
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
    expect(published.map((p) => p.directory)).toEqual([`${LOCAL}/included`])
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
    expect(published).toHaveLength(0)
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
    expect(published.map((p) => p.directory)).toEqual([LOCAL, join(LOCAL, 'included')])
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
    expect(published).toHaveLength(1)
    expect(published[0]!.directory).toBe(LOCAL)
    expect(published[0]!.changes.map((c) => c.path)).toEqual([`${LOCAL}/src/included/a.txt`])
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
    expect(published).toHaveLength(0)
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

    expect(published).toHaveLength(1)
    expect(published[0]!.changes.map((c) => c.path)).toEqual([`${LOCAL}/src/included/a.txt`])
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
    expect(published.map((p) => p.directory)).toEqual([join(LOCAL, 'A')])
    expect([...disk.store.keys()].some((k) => k.includes('B'))).toBe(false)
  })
})
