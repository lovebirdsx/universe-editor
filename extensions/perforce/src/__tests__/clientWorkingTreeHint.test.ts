/**
 * Unit tests for `PerforceClient.checkWorkingTree` — the on-demand, read-only
 * working-tree hint channel behind the Explorer's per-row drift badge. It answers
 * "which of these visible rows have disk drift that isn't visible anywhere else"
 * without turning on reconcile discovery. This locks in:
 *  1. The three filter predicates the hint shares with the reconcile group
 *     (opened, out-of-scope, dismissed) each drop their rows.
 *  2. Empty input / everything-filtered return `[]` with zero p4 spawns.
 *  3. The returned DTOs are sourced from `toReconcileResourceState`, so a row's
 *     badge can never disagree with the resource group's (letter `RC`, colour,
 *     tooltip, strike-through).
 *  4. The call is read-only: it never persists, never writes the group, never
 *     emits a change, and never flips the sticky reconcile-discovery switch.
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
 *  can be inspected (and its identity asserted) after the client mutates them. */
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
const { toReconcileResourceState } = await import('../p4Decoration.js')
type PerforceClientInstance = import('../client.js').PerforceClient
type ReconcileStore = import('../client.js').ReconcileStore
type ReconcilePersistState = import('../client.js').ReconcilePersistState
type ReconcileFile = import('../reconcileParser.js').ReconcileFile

const ROOT = process.platform === 'win32' ? 'X:\\p4ws\\main' : '/p4ws/main'
const LOCAL = process.platform === 'win32' ? 'X:/p4ws/main' : '/p4ws/main'
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
      const { stdout, stderr, exit } = handle(argv, opts)
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
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

function handle(
  argv: string[],
  opts: RespondOptions,
): { stdout: string; stderr?: string; exit?: number } {
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
    // `clientFile` is client syntax (`//clientName/rel`), not a local path —
    // `parseReconcile(records, root)` translates it. Emitting a local path here
    // would mask the client-syntax → local-path translation.
    const rows = opts.reconcile?.() ?? []
    return {
      stdout: rows
        .map((r) =>
          JSON.stringify({
            depotFile: `//depot/branch_x/${r.rel}`,
            clientFile: `//${CLIENT}/${r.rel}`,
            action: r.action ?? 'edit',
            rev: '1',
          }),
        )
        .join('\n'),
    }
  }
  // changes / fstat / describe — succeed silently with no records.
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

describe('PerforceClient.checkWorkingTree', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
    calls.length = 0
    createdGroups.length = 0
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  // --- ① the three shared predicates ----------------------------------------

  it('omits paths already opened (the changelist decoration is authoritative)', async () => {
    const store = memStore()
    const client = await makeClient(store, {
      opened: () => [{ rel: 'a.txt' }],
      reconcile: () => [{ rel: 'a.txt' }, { rel: 'b.txt' }],
    })
    await client.refresh()
    calls.length = 0

    const result = await client.checkWorkingTree([`${LOCAL}/a.txt`, `${LOCAL}/b.txt`])

    const paths = result.map((d) => d.path)
    expect(paths).not.toContain(`${LOCAL}/a.txt`)
    expect(paths).toContain(`${LOCAL}/b.txt`)
    // The opened path is dropped before the scan — it never even reaches p4.
    for (const argv of reconcileScans()) {
      expect(argv).not.toContain(`${LOCAL}/a.txt`)
    }
  })

  it('omits paths outside the reconcile discovery scope', async () => {
    const store = memStore()
    const client = await makeClient(store, {
      reconcile: () => [{ rel: 'Client/in.txt' }, { rel: 'outside.txt' }],
    })
    client.setReconcileScope([`${LOCAL}/Client`])
    calls.length = 0

    const result = await client.checkWorkingTree([`${LOCAL}/Client/in.txt`, `${LOCAL}/outside.txt`])

    const paths = result.map((d) => d.path)
    expect(paths).toContain(`${LOCAL}/Client/in.txt`)
    expect(paths).not.toContain(`${LOCAL}/outside.txt`)
  })

  it('omits paths the user dismissed from the reconcile list', async () => {
    const store = memStore()
    const client = await makeClient(store, {
      reconcile: () => [{ rel: 'a.txt' }, { rel: 'b.txt' }],
    })
    await client.refresh({ reconcile: true })
    client.dismissReconcile([`${LOCAL}/a.txt`])
    calls.length = 0

    const result = await client.checkWorkingTree([`${LOCAL}/a.txt`, `${LOCAL}/b.txt`])

    const paths = result.map((d) => d.path)
    expect(paths).not.toContain(`${LOCAL}/a.txt`)
    expect(paths).toContain(`${LOCAL}/b.txt`)
  })

  // --- ② zero p4 calls when there is nothing to scan -------------------------

  it('returns [] for empty input without spawning p4', async () => {
    const store = memStore()
    const client = await makeClient(store)
    calls.length = 0

    const result = await client.checkWorkingTree([])

    expect(result).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('returns [] and spawns nothing when every path is filtered out', async () => {
    const store = memStore()
    const client = await makeClient(store, { opened: () => [{ rel: 'a.txt' }] })
    await client.refresh()
    calls.length = 0

    const result = await client.checkWorkingTree([`${LOCAL}/a.txt`])

    expect(result).toEqual([])
    expect(calls).toHaveLength(0)
  })

  // --- ③ badge consistency with the resource group ---------------------------

  it('sources its DTOs from toReconcileResourceState (letter RC, colour, tooltip, strike)', async () => {
    const store = memStore()
    const client = await makeClient(store, {
      reconcile: () => [
        { rel: 'a.txt', action: 'edit' },
        { rel: 'b.txt', action: 'delete' },
      ],
    })

    const result = await client.checkWorkingTree([`${LOCAL}/a.txt`, `${LOCAL}/b.txt`])

    expect(result).toHaveLength(2)
    for (const dto of result) {
      // The `RC` letter is the public contract — never the action letter E/A/D.
      expect(dto.letter).toBe('RC')

      const rel = dto.path === `${LOCAL}/a.txt` ? 'a.txt' : 'b.txt'
      const file: ReconcileFile = {
        depotFile: `//depot/branch_x/${rel}`,
        clientFile: `${LOCAL}/${rel}`,
        action: rel === 'a.txt' ? 'edit' : 'delete',
        rev: '1',
      }
      const state = toReconcileResourceState(file)
      expect(state).toBeDefined()
      // Every presentation field must come from the same source as the resource
      // group, or the badge would jump between Clean Refresh and the hint path.
      expect(dto.color).toBe(state!.decorations?.color)
      expect(dto.tooltip).toBe(state!.decorations?.tooltip)
      expect(dto.strikeThrough).toBe(state!.decorations?.strikeThrough)
    }
    // Delete carries the strike-through; edit does not.
    const del = result.find((d) => d.path === `${LOCAL}/b.txt`)
    const edit = result.find((d) => d.path === `${LOCAL}/a.txt`)
    expect(del?.strikeThrough).toBe(true)
    expect(edit?.strikeThrough).toBeUndefined()
  })

  // --- ④ read-only -----------------------------------------------------------

  it('is read-only: never saves, never writes the group, never emits a change', async () => {
    const store = memStore()
    const client = await makeClient(store, { reconcile: () => [{ rel: 'a.txt' }] })
    const saveSpy = vi.spyOn(store, 'save')
    const group = reconcileGroup()!
    const statesBefore = group.resourceStates
    let changes = 0
    client.onDidChange(() => {
      changes++
    })

    const result = await client.checkWorkingTree([`${LOCAL}/a.txt`])

    expect(result).toHaveLength(1)
    expect(saveSpy).not.toHaveBeenCalled()
    expect(group.resourceStates).toBe(statesBefore)
    expect(group.resourceStates).toHaveLength(0)
    expect(changes).toBe(0)
  })

  it('does not turn on sticky reconcile discovery', async () => {
    const store = memStore()
    const client = await makeClient(store, { reconcile: () => [{ rel: 'a.txt' }] })

    await client.checkWorkingTree([`${LOCAL}/a.txt`])

    // Read the flag directly, on purpose. With an empty file list the two states
    // are behaviourally identical (`_refreshReconcile` short-circuits to `none`
    // either way), so a black-box assertion here could not fail — and a guard
    // that cannot fail is worse than none. The risk being pinned is a later
    // "while we're scanning anyway, let's remember it" edit turning this
    // read-only channel into sticky discovery.
    expect((client as unknown as { _reconcileActive: boolean })._reconcileActive).toBe(false)

    // The observable half of the same guarantee: an ordinary refresh afterwards
    // still does no reconcile work and leaves the group empty.
    calls.length = 0
    await client.refresh()
    expect(client.status.reconcileCount).toBe(0)
    expect(reconcileGroup()?.resourceStates).toHaveLength(0)
    expect(reconcileScans()).toHaveLength(0)
  })

  // --- extra: only echo back the paths actually asked about -------------------

  it('reports only the paths it was asked about (drops an unrequested rename half)', async () => {
    const store = memStore()
    const client = await makeClient(store, {
      reconcile: () => [{ rel: 'a.txt' }, { rel: 'b.txt' }],
    })

    const result = await client.checkWorkingTree([`${LOCAL}/a.txt`])

    expect(result.map((d) => d.path)).toEqual([`${LOCAL}/a.txt`])
  })

  // --- extra: the echo map's two sides are spelled by different parties --------

  it.runIf(process.platform === 'win32')(
    'echoes back the caller spelling when it differs in case from the client root',
    async () => {
      const store = memStore()
      const client = await makeClient(store, { reconcile: () => [{ rel: 'a.txt' }] })

      // The host spells the path the way the user opened the folder; the scan
      // spells it from the `p4 info` client root. On a case-insensitive
      // filesystem these name the same file, so the hint must still come back —
      // and come back under the caller's spelling, or the renderer's cache key
      // (which it derived from that same string) will not match.
      const asAsked = `${LOCAL.toUpperCase()}/A.txt`
      const result = await client.checkWorkingTree([asAsked])

      expect(result).toHaveLength(1)
      expect(result[0]?.path).toBe(asAsked)
    },
  )
})
