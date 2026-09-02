/**
 * Unit tests for `PerforceClient.checkWorkingTree` — the on-demand, read-only
 * working-tree hint channel behind the Explorer's per-row drift badge, and the
 * only channel that surfaces uncollected drift. It answers "which of these
 * visible rows have disk drift that isn't visible anywhere else" at a cost
 * proportional to the rows asked about. This locks in:
 *  1. The two filter predicates (opened, out-of-scope) each drop their rows.
 *  2. Empty input / everything-filtered return `[]` with zero p4 spawns.
 *  3. The returned DTOs are sourced from `toReconcileResourceState`, so a row's
 *     badge can never disagree with the SCM decorations (letter `RC`, colour,
 *     tooltip, strike-through).
 *  4. The call is read-only: it never writes shared state (the opened set) and
 *     never emits a change.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = { end: vi.fn() }
  kill(): boolean {
    // Simulate a killed child: `close` with a non-zero code, which is how a
    // SpawnWatchdog kill surfaces to the scan path.
    this.emit('close', 1)
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
      createResourceGroup: (id: string) => ({
        id,
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
const { toReconcileResourceState } = await import('../p4Decoration.js')
const { setP4CommandTimeoutSeconds } = await import('../p4Service.js')
type PerforceClientInstance = import('../client.js').PerforceClient
type ReconcileFile = import('../reconcileParser.js').ReconcileFile

const ROOT = process.platform === 'win32' ? 'X:\\p4ws\\main' : '/p4ws/main'
const LOCAL = process.platform === 'win32' ? 'X:/p4ws/main' : '/p4ws/main'
const CLIENT = 'testclient'

interface RespondOptions {
  /** Reconcile candidates returned by any `reconcile -n` scan (as client-syntax rows). */
  reconcile?: () => { rel: string; action?: string }[]
  /** Emit these reconcile rows, then never close — the SpawnWatchdog kills the
   *  child. The hint channel must NOT recover partial output from a timeout. */
  reconcileTimeout?: () => { rel: string; action?: string }[] | undefined
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
    // `clientFile` is client syntax (`//clientName/rel`), not a local path —
    // `parseReconcile(records, root)` translates it. Emitting a local path here
    // would mask the client-syntax → local-path translation.
    const timeoutRows = opts.reconcileTimeout?.()
    if (timeoutRows) return { stdout: reconcileRows(timeoutRows), hold: true }
    const rows = opts.reconcile?.() ?? []
    return { stdout: reconcileRows(rows) }
  }
  // changes / fstat / describe — succeed silently with no records.
  return { stdout: '' }
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

/** All `reconcile -n` argv seen so far (each is the full p4 argv). */
function reconcileScans(): string[][] {
  return calls.filter((a) => subcommand(a) === 'reconcile' && a.includes('-n'))
}

async function makeClient(opts: RespondOptions = {}): Promise<PerforceClientInstance> {
  respond(opts)
  const client = await PerforceClient.create(
    ROOT,
    {},
    new ConcurrencyGate(4),
    { enabled: true, workspaceTtlMs: 4000 },
    undefined,
  )
  expect(client).toBeDefined()
  return client!
}

describe('PerforceClient.checkWorkingTree', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
    calls.length = 0
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  // --- ① the two shared predicates ------------------------------------------

  it('omits paths already opened (the changelist decoration is authoritative)', async () => {
    const client = await makeClient({
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
    const client = await makeClient({
      reconcile: () => [{ rel: 'Client/in.txt' }, { rel: 'outside.txt' }],
    })
    client.setReconcileScope([`${LOCAL}/Client`])
    calls.length = 0

    const result = await client.checkWorkingTree([`${LOCAL}/Client/in.txt`, `${LOCAL}/outside.txt`])

    const paths = result.map((d) => d.path)
    expect(paths).toContain(`${LOCAL}/Client/in.txt`)
    expect(paths).not.toContain(`${LOCAL}/outside.txt`)
  })

  // --- ② zero p4 calls when there is nothing to scan -------------------------

  it('returns [] for empty input without spawning p4', async () => {
    const client = await makeClient()
    calls.length = 0

    const result = await client.checkWorkingTree([])

    expect(result).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('returns [] and spawns nothing when every path is filtered out', async () => {
    const client = await makeClient({ opened: () => [{ rel: 'a.txt' }] })
    await client.refresh()
    calls.length = 0

    const result = await client.checkWorkingTree([`${LOCAL}/a.txt`])

    expect(result).toEqual([])
    expect(calls).toHaveLength(0)
  })

  // --- ③ badge consistency with the resource group ---------------------------

  it('sources its DTOs from toReconcileResourceState (letter RC, colour, tooltip, strike)', async () => {
    const client = await makeClient({
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
      // row, so the badge letter/color/tooltip/strike-through all live in one place.
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

  it('is read-only: never writes shared state, never emits a change', async () => {
    const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] })
    const openedBefore = (client as unknown as { _openedPaths: ReadonlySet<string> })._openedPaths
    let changes = 0
    client.onDidChange(() => {
      changes++
    })

    const result = await client.checkWorkingTree([`${LOCAL}/a.txt`])

    expect(result).toHaveLength(1)
    expect(changes).toBe(0)
    // The channel is read-only by construction: it must not grow the opened set,
    // or a later refresh would treat these scanned paths as already-tracked and
    // the Explorer badge would silently disappear after one clean refresh.
    expect((client as unknown as { _openedPaths: ReadonlySet<string> })._openedPaths).toBe(
      openedBefore,
    )
  })

  // --- extra: only echo back the paths actually asked about -------------------

  it('reports only the paths it was asked about (drops an unrequested rename half)', async () => {
    const client = await makeClient({
      reconcile: () => [{ rel: 'a.txt' }, { rel: 'b.txt' }],
    })

    const result = await client.checkWorkingTree([`${LOCAL}/a.txt`])

    expect(result.map((d) => d.path)).toEqual([`${LOCAL}/a.txt`])
  })

  // --- extra: the echo map's two sides are spelled by different parties --------

  it.runIf(process.platform === 'win32')(
    'echoes back the caller spelling when it differs in case from the client root',
    async () => {
      const client = await makeClient({ reconcile: () => [{ rel: 'a.txt' }] })

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

  // --- extra: a timeout is a hard failure, never a partial answer ------------

  it('does not recover partial results on timeout (the channel answers "which exactly?")', async () => {
    // This channel's contract is "which of exactly these paths drifted": a
    // partial answer would let the renderer pin the un-covered paths as clean
    // forever. So a watchdog kill must surface as "no answer", not as the rows
    // the command happened to stream before the kill.
    setP4CommandTimeoutSeconds(1)
    try {
      const client = await makeClient({ reconcileTimeout: () => [{ rel: 'a.txt' }] })

      const result = await client.checkWorkingTree([`${LOCAL}/a.txt`])

      expect(result).toEqual([])
    } finally {
      setP4CommandTimeoutSeconds(600)
    }
  })
})
