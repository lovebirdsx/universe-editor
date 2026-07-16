/**
 * The "changes to reconcile" group persists across sessions and supports
 * permanently dismissing entries ("move out of the list"). This locks in four
 * behaviours:
 *  1. Moving a file out of a changelist re-scans only that path — never a full
 *     `reconcile -n //...` (or folder-scope) walk (the large-depot slowdown).
 *  2. A dismissed file stays out of the group even after a full Clean Refresh.
 *  3. Restoring at startup renders the persisted list WITHOUT any `reconcile -n`.
 *  4. Collecting a previously dismissed file re-includes it (drops the dismissal).
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = { end: vi.fn() }
  kill(): boolean {
    return true
  }
}

const spawnMock = vi.fn<(...args: unknown[]) => FakeChildProcess>()
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

const BRIDGE_KEY = '__universeExtensionHostBridge__'
/** Capture every created resource group so the reconcile group's resourceStates
 *  can be inspected after the client mutates them. */
const createdGroups: { id: string; resourceStates: unknown[] }[] = []
function installScmBridge(): void {
  const group = (id: string) => {
    const g = { id, label: '', hideWhenEmpty: undefined, resourceStates: [], dispose() {} }
    createdGroups.push(g)
    return g
  }
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
      createResourceGroup: (id: string) => group(id),
      dispose() {},
    }),
  }
}

const { PerforceClient } = await import('../client.js')
const { ConcurrencyGate } = await import('../concurrency.js')
const { MAX_PATH_ARGS_CHARS } = await import('../p4Service.js')
type PerforceClientInstance = import('../client.js').PerforceClient
type ReconcileStore = import('../client.js').ReconcileStore
type ReconcilePersistState = import('../client.js').ReconcilePersistState

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const LOCAL = process.platform === 'win32' ? 'C:/ws' : '/ws'
const CLIENT = 'testclient'

/** In-memory ReconcileStore; records every save so persistence is observable. */
function memStore(initial?: ReconcilePersistState): ReconcileStore & {
  saves: ReconcilePersistState[]
  current: ReconcilePersistState
} {
  let current: ReconcilePersistState = initial ?? { files: [], dismissed: [] }
  const saves: ReconcilePersistState[] = []
  return {
    saves,
    get current() {
      return current
    },
    load: () => current,
    save: (s) => {
      current = s
      saves.push(s)
    },
  }
}

interface RespondOptions {
  /** Reconcile candidates returned by any `reconcile -n` scan (as client-syntax rows). */
  reconcile?: () => { rel: string; action?: string }[]
}

const calls: string[][] = []

function respond(opts: RespondOptions = {}): void {
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[1] as string[]) ?? []
    calls.push(argv)
    const child = new FakeChildProcess()
    queueMicrotask(() => {
      const { stdout, exit } = handle(argv, opts)
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
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

function handle(argv: string[], opts: RespondOptions): { stdout: string; exit?: number } {
  const cmd = subcommand(argv)
  if (cmd === 'info') {
    return { stdout: `... clientName ${CLIENT}\n... clientRoot ${ROOT}\n... userName bob\n\n` }
  }
  if (cmd === 'opened' || cmd === 'changes') return { stdout: '' }
  if (cmd === 'reconcile' && argv.includes('-n')) {
    const rows = opts.reconcile?.() ?? []
    const stdout = rows
      .map((r) =>
        JSON.stringify({
          depotFile: `//depot/${r.rel}`,
          clientFile: `//${CLIENT}/${r.rel}`,
          action: r.action ?? 'edit',
          rev: '1',
        }),
      )
      .join('\n')
    return { stdout }
  }
  // revert -k / reconcile (real) / clean — succeed silently.
  return { stdout: '' }
}

/** All `reconcile -n` argv seen so far (each is the full p4 argv). */
function reconcileScans(): string[][] {
  return calls.filter((a) => subcommand(a) === 'reconcile' && a.includes('-n'))
}

function reconcileGroup(): { resourceStates: unknown[] } | undefined {
  return createdGroups.find((g) => g.id === 'reconcile')
}

async function makeClient(
  store: ReconcileStore,
  opts: RespondOptions = {},
): Promise<PerforceClientInstance> {
  respond(opts)
  const client = await PerforceClient.create(
    ROOT,
    {},
    new ConcurrencyGate(4),
    { enabled: true, workspaceTtlMs: 4000 },
    undefined,
    store,
  )
  expect(client).toBeDefined()
  return client!
}

describe('PerforceClient reconcile persistence + dismiss', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
    calls.length = 0
    createdGroups.length = 0
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  it('move out of changelist re-scans only the moved path, never a full-scope walk', async () => {
    const store = memStore()
    const client = await makeClient(store, { reconcile: () => [{ rel: 'a.txt' }] })
    calls.length = 0

    await client.moveToReconcile([`${LOCAL}/a.txt`])

    const scans = reconcileScans()
    expect(scans.length).toBeGreaterThan(0)
    for (const argv of scans) {
      expect(argv).not.toContain('//...')
      expect(argv).not.toContain(`${LOCAL}/...`)
      expect(argv).toContain(`${LOCAL}/a.txt`)
    }
    // The moved file surfaced in the reconcile group.
    expect(client.status.reconcileCount).toBe(1)
  })

  it('reconcileInto collects a not-yet-opened file straight into a numbered changelist', async () => {
    const store = memStore()
    const client = await makeClient(store, { reconcile: () => [{ rel: 'a.txt' }] })
    calls.length = 0

    await client.reconcileInto('1000', [`${LOCAL}/a.txt`])

    // The real reconcile (no `-n`) must target the changelist via `-c 1000`.
    const real = calls.find(
      (a) => subcommand(a) === 'reconcile' && !a.includes('-n') && a.includes(`${LOCAL}/a.txt`),
    )
    expect(real).toBeDefined()
    // `-c 1000` (the changelist), distinct from any global `-c <client>` option.
    expect(real![real!.indexOf('1000') - 1]).toBe('-c')
  })

  it('reconcileInto default omits the changelist flag', async () => {
    const store = memStore()
    const client = await makeClient(store, { reconcile: () => [{ rel: 'a.txt' }] })
    calls.length = 0

    await client.reconcileInto('default', [`${LOCAL}/a.txt`])

    const real = calls.find(
      (a) => subcommand(a) === 'reconcile' && !a.includes('-n') && a.includes(`${LOCAL}/a.txt`),
    )
    expect(real).toBeDefined()
    // No changelist targeting — the literal 'default' is never passed to reconcile.
    expect(real).not.toContain('default')
  })

  it('restores the persisted list at startup without any reconcile scan', async () => {
    const store = memStore({
      files: [
        { depotFile: '//depot/a.txt', clientFile: `${LOCAL}/a.txt`, action: 'edit', rev: '1' },
      ],
      dismissed: [],
    })
    const client = await makeClient(store)
    calls.length = 0

    client.restoreReconcile()

    expect(reconcileScans()).toHaveLength(0)
    expect(client.status.reconcileCount).toBe(1)
    expect(reconcileGroup()?.resourceStates).toHaveLength(1)
  })

  it('a dismissed file stays out of the group even after a full Clean Refresh', async () => {
    // Both files diverge on every scan.
    const store = memStore()
    const client = await makeClient(store, {
      reconcile: () => [{ rel: 'a.txt' }, { rel: 'b.txt' }],
    })
    // Populate the group via a clean refresh.
    await client.refresh({ reconcile: true })
    expect(client.status.reconcileCount).toBe(2)

    client.dismissReconcile([`${LOCAL}/a.txt`])
    expect(client.status.reconcileCount).toBe(1)
    expect(store.current.dismissed).toContain(`${LOCAL.toLowerCase()}/a.txt`)

    // A full Clean Refresh re-discovers a.txt, but it must remain dismissed.
    await client.refresh({ reconcile: true })
    expect(client.status.reconcileCount).toBe(1)
    const states = (reconcileGroup()?.resourceStates ?? []) as { resourceUri?: string }[]
    expect(states.some((s) => (s.resourceUri ?? '').includes('a.txt'))).toBe(false)
  })

  it('collecting a dismissed file drops the dismissal', async () => {
    const store = memStore()
    const client = await makeClient(store, { reconcile: () => [{ rel: 'a.txt' }] })
    await client.refresh({ reconcile: true })
    client.dismissReconcile([`${LOCAL}/a.txt`])
    expect(store.current.dismissed).toContain(`${LOCAL.toLowerCase()}/a.txt`)

    await client.reconcile([`${LOCAL}/a.txt`])

    expect(store.current.dismissed).not.toContain(`${LOCAL.toLowerCase()}/a.txt`)
  })

  it('serializes overlapping reconcile passes so a late one cannot clobber an earlier commit', async () => {
    // Repro for the move-to-reconcile race. Two incremental reconcile passes for the
    // same path can overlap: the file watcher fires one while the file is still
    // opened, and `moveToReconcile` fires another after `revert -k`. If the two run
    // interleaved they read-modify-write the shared reconcile state on stale
    // snapshots and the moved file can be dropped back out. The fix serializes every
    // reconcile pass; this asserts the invariant directly — a second pass's
    // `reconcile -n` must not start until the first pass has fully completed.
    const store = memStore()
    const client = await makeClient(store, { reconcile: () => [{ rel: 'a.txt' }] })

    // Re-arm spawn: hold the first reconcile scan open, and record scan ordering so
    // we can prove the second scan only starts after the first finishes.
    let releaseFirst: (() => void) | undefined
    let firstScan = true
    const scanStarted: number[] = []
    const scanFinished: number[] = []
    let seq = 0
    spawnMock.mockImplementation((...args: unknown[]) => {
      const argv = (args[1] as string[]) ?? []
      calls.push(argv)
      const child = new FakeChildProcess()
      const isScan = subcommand(argv) === 'reconcile' && argv.includes('-n')
      const id = seq++
      const finish = () => {
        const { stdout, exit } = handle(argv, { reconcile: () => [{ rel: 'a.txt' }] })
        if (stdout) child.stdout.emit('data', Buffer.from(stdout))
        if (isScan) scanFinished.push(id)
        child.emit('close', exit ?? 0)
      }
      if (isScan) scanStarted.push(id)
      if (isScan && firstScan) {
        firstScan = false
        releaseFirst = finish
      } else {
        queueMicrotask(finish)
      }
      return child
    })
    calls.length = 0
    scanStarted.length = 0
    scanFinished.length = 0

    const passA = client.refreshReconcilePaths([`${LOCAL}/a.txt`])
    await Promise.resolve()
    const passB = client.refreshReconcilePaths([`${LOCAL}/a.txt`])
    // Give B a chance to (wrongly) start its scan if it isn't serialized behind A.
    await new Promise((r) => setTimeout(r, 5))
    // Only the first pass's scan may have started; B must be queued behind it.
    expect(scanStarted).toHaveLength(1)
    releaseFirst?.()
    await Promise.all([passA, passB])

    // Both scans ran, strictly in series (first finished before second started).
    expect(scanStarted).toHaveLength(2)
    expect(scanFinished[0]).toBe(0)
    // The file survives once both settle — no clobber.
    expect(client.status.reconcileCount).toBe(1)
    const states = (reconcileGroup()?.resourceStates ?? []) as { resourceUri?: string }[]
    expect(states.some((s) => (s.resourceUri ?? '').includes('a.txt'))).toBe(true)
  })

  // Regression (ENAMETOOLONG): a huge changed-path set must be split across
  // several `reconcile -n` scans so no single argv overflows the command line.
  it('splits a huge incremental path set into multiple bounded reconcile scans', async () => {
    const store = memStore()
    // Every scanned path comes back as a reconcile candidate so all survive.
    const client = await makeClient(store, {
      reconcile: () => [],
    })
    calls.length = 0

    // ~3000 long paths → well past the 8000-char argv budget for one command.
    const paths = Array.from(
      { length: 3000 },
      (_, i) => `${LOCAL}/very/deeply/nested/directory/structure/file_${i}.uasset`,
    )
    await client.refreshReconcilePaths(paths)

    const scans = reconcileScans()
    // Must have fanned out into more than one scan.
    expect(scans.length).toBeGreaterThan(1)
    // No scan's path portion exceeds the budget, and no path is lost.
    const seen = new Set<string>()
    for (const argv of scans) {
      const scanPaths = argv.filter((a) => a.startsWith(LOCAL))
      const len = scanPaths.reduce((n, p) => n + p.length + 1, 0)
      expect(len).toBeLessThanOrEqual(MAX_PATH_ARGS_CHARS)
      for (const p of scanPaths) seen.add(p)
    }
    for (const p of paths) expect(seen.has(p)).toBe(true)
  })
})
