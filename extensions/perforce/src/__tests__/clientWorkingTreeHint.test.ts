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

/** The extension window, mocked so a refused write can surface its toast
 *  without a real host. */
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
import { NO_SCOPE_CONFIG, scopeFixture } from './scopeFixture.js'
import { clientSpecReply, isClientSpecProbe } from './discoveryProbe.js'
type PerforceClientInstance = import('../client.js').PerforceClient
type ReconcileFile = import('../reconcileParser.js').ReconcileFile
type ScopeRead = import('./scopeFixture.js').ScopeRead
type SyncScopeTarget = import('../p4Filespec.js').SyncScopeTarget

const ROOT = process.platform === 'win32' ? 'X:\\p4ws\\main' : '/p4ws/main'
const DISCOVERY_SPEC = clientSpecReply(ROOT)
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
  if (isClientSpecProbe(argv)) {
    return { stdout: DISCOVERY_SPEC }
  }
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

/**
 * A client with a pre-resolved daily scope (see `scopeFixture`): the scope is
 * what bounds every hint query, and production resolves it during activation
 * (`refreshScope`), so the injected answer is applied the same way here. The
 * default scope is the whole client root — "the whole workspace, no exclusions",
 * the answer a folder with no `.p4delta-scope` resolves to.
 */
async function makeClient(
  opts: RespondOptions = {},
  readScope: ScopeRead = scopeFixture([LOCAL]),
): Promise<PerforceClientInstance> {
  respond(opts)
  const client = await PerforceClient.create(
    ROOT,
    {},
    new ConcurrencyGate(4),
    { enabled: true, workspaceTtlMs: 4000 },
    { readScope },
  )
  expect(client).toBeDefined()
  await client!.refreshScope()
  return client!
}

describe('PerforceClient.checkWorkingTree', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
    calls.length = 0
    windowMock.showWarningMessage.mockClear()
    windowMock.showInformationMessage.mockClear()
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

  it('omits paths outside the daily scope', async () => {
    const client = await makeClient(
      { reconcile: () => [{ rel: 'Client/in.txt' }, { rel: 'outside.txt' }] },
      scopeFixture([`${LOCAL}/Client`]),
    )
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

  it('sources its DTOs from toReconcileResourceState (letter, colour, tooltip, strike)', async () => {
    const client = await makeClient({
      reconcile: () => [
        { rel: 'a.txt', action: 'edit' },
        { rel: 'b.txt', action: 'delete' },
      ],
    })

    const result = await client.checkWorkingTree([`${LOCAL}/a.txt`, `${LOCAL}/b.txt`])

    expect(result).toHaveLength(2)
    for (const dto of result) {
      const rel = dto.path === `${LOCAL}/a.txt` ? 'a.txt' : 'b.txt'
      const file: ReconcileFile = {
        depotFile: `//depot/branch_x/${rel}`,
        clientFile: `${LOCAL}/${rel}`,
        action: rel === 'a.txt' ? 'edit' : 'delete',
        rev: '1',
      }
      const state = toReconcileResourceState(file)
      expect(state).toBeDefined()
      // The letter is the public contract and must be the one the resource row
      // derives — never mapped a second time. edit → RM, delete → RD.
      expect(dto.letter).toBe(state!.contextValue)
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

  // --- extra: excluded directories ------------------------------------------

  it('spawns nothing when every path is inside an excluded directory', async () => {
    const client = await makeClient(
      { reconcile: () => [{ rel: 'Excluded/in.txt' }] },
      scopeFixture([LOCAL], [`${LOCAL}/Excluded`]),
    )
    calls.length = 0

    const result = await client.checkWorkingTree([
      `${LOCAL}/Excluded/in.txt`,
      `${LOCAL}/Excluded/out.txt`,
    ])

    expect(result).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('omits paths inside an excluded directory (the excluded sibling is never scanned)', async () => {
    const client = await makeClient(
      { reconcile: () => [{ rel: 'Excluded/in.txt' }, { rel: 'in.txt' }] },
      scopeFixture([LOCAL], [`${LOCAL}/Excluded`]),
    )
    calls.length = 0

    const result = await client.checkWorkingTree([`${LOCAL}/Excluded/in.txt`, `${LOCAL}/in.txt`])

    const paths = result.map((d) => d.path)
    expect(paths).not.toContain(`${LOCAL}/Excluded/in.txt`)
    expect(paths).toContain(`${LOCAL}/in.txt`)
    // The excluded path is dropped before the scan — it never reaches p4.
    for (const argv of reconcileScans()) {
      expect(argv).not.toContain(`${LOCAL}/Excluded/in.txt`)
    }
  })

  // --- extra: excluded FILES ------------------------------------------------

  it('omits an excluded FILE, which δ reports for the config file itself', async () => {
    // A file exclusion is a different shape from a directory one: no walk skips
    // it, so it has to be filtered by path — otherwise the config file the scope
    // shields shows up as drift in the very row the user is looking at.
    const config = `${LOCAL}/.p4delta-scope`
    const client = await makeClient(
      { reconcile: () => [{ rel: 'in.txt' }] },
      scopeFixture([LOCAL], [{ path: config, isDirectory: false }]),
    )
    calls.length = 0

    const result = await client.checkWorkingTree([config, `${LOCAL}/in.txt`])

    const paths = result.map((d) => d.path)
    expect(paths).not.toContain(config)
    expect(paths).toContain(`${LOCAL}/in.txt`)
    for (const argv of reconcileScans()) {
      expect(argv).not.toContain(config)
    }
  })

  it('reports the file exclusion to the command layer', async () => {
    const config = `${LOCAL}/.p4delta-scope`
    const client = await makeClient(
      {},
      scopeFixture([LOCAL], [{ path: config, isDirectory: false }]),
    )

    expect(client.reconcileExcludeFiles).toEqual([config])
    expect(client.isReconcileTargetExcluded(config)).toBe(true)
  })

  // --- extra: the native-expressibility verdict ------------------------------

  it('refuses a native range that would reach an excluded file', async () => {
    // The carve is exact for excluded SUBTREES but covers a level with `<dir>/*`
    // (kept because `reconcile -d` must see deleted files), and `*` matches an
    // excluded file too — under `p4 clean -a` that deletes the file the scope
    // shields, the config file above all. The client refuses inside the native
    // branch, on the very range that branch is about to run.
    const config = `${LOCAL}/src/.p4delta-scope`
    const client = await makeClient(
      {},
      scopeFixture([LOCAL], [{ path: config, isDirectory: false }]),
    )
    const run = (target: SyncScopeTarget): Promise<boolean> =>
      client.reconcile({ targets: [target] })

    expect(await run({ path: LOCAL, isDirectory: true })).toBe(false)
    expect(await run({ path: `${LOCAL}/src`, isDirectory: true })).toBe(false)
    expect(String(windowMock.showWarningMessage.mock.calls.at(-1)?.[0] ?? '')).toContain(config)
    // A target the excluded file is NOT under is expressible as it stands.
    expect(await run({ path: `${LOCAL}/other`, isDirectory: true })).toBe(true)
    expect(await run({ path: `${LOCAL}/in.txt`, isDirectory: false })).toBe(true)
    // The excluded file itself is not a range anything may run over.
    expect(await run({ path: config, isDirectory: false })).toBe(false)
  })

  it('always carries the config file’s own exclusion, spelled out — not hidden in a snapshot', async () => {
    const client = await makeClient({}, scopeFixture([LOCAL], [`${LOCAL}/Excluded`]))
    const config = `${LOCAL}/.p4delta-scope`
    // A config the user believes is in force must not read as drift, and no
    // native clean may be handed a range that reaches it: the file the rules
    // live in is part of the rules, on both sides of the contract.
    expect(client.reconcileExcludeFiles).toEqual([config])
    expect(await client.reconcile({ targets: [{ path: LOCAL, isDirectory: true }] })).toBe(false)
    expect(
      await client.reconcile({ targets: [{ path: `${LOCAL}/other`, isDirectory: true }] }),
    ).toBe(true)
  })

  it('has no file exclusion at all when the folder has no config', async () => {
    const client = await makeClient({}, () => NO_SCOPE_CONFIG)
    expect(client.scopeState).toBe('ready')
    expect(client.reconcileExcludeFiles).toEqual([])
    expect(await client.reconcile({ targets: [{ path: LOCAL, isDirectory: true }] })).toBe(true)
  })

  // --- extra: the explicit-target gate ---------------------------------------

  it('narrows "obey the scope" to the in-scope parts instead of dropping them', async () => {
    // The config file's own self-exclusion makes every ancestor directory "not
    // covered WHOLE", so a root-level collect does open the dialog — but obeying
    // must still run over the root with the exclusions applied, not report
    // "nothing is in scope" and do nothing.
    const config = `${LOCAL}/.p4delta-scope`
    const client = await makeClient(
      {},
      scopeFixture([`${LOCAL}/src`], [{ path: config, isDirectory: false }]),
    )

    const check = await client.checkScopeTargets([
      { path: LOCAL, isDirectory: true },
      { path: 'X:/elsewhere', isDirectory: true },
    ])

    // Boundary-wise: the root narrows to the include, the unrelated folder is out.
    expect(check.inside).toEqual([{ path: `${LOCAL}/src`, isDirectory: true }])
    expect(check.outside.map((t) => t.path)).toEqual([LOCAL, 'X:/elsewhere'])
  })

  it('keeps a holed but in-scope directory whole for the obey path', async () => {
    const config = `${LOCAL}/src/.p4delta-scope`
    const client = await makeClient(
      {},
      scopeFixture([LOCAL], [{ path: config, isDirectory: false }]),
    )

    const check = await client.checkScopeTargets([{ path: `${LOCAL}/src`, isDirectory: true }])

    expect(check.inside).toEqual([{ path: `${LOCAL}/src`, isDirectory: true }])
    // Still "not covered whole", so the dialog offers the choice.
    expect(check.outside.map((t) => t.path)).toEqual([`${LOCAL}/src`])
  })

  it('omits paths inside an excluded directory when the scope covers the whole client', async () => {
    const client = await makeClient(
      { reconcile: () => [{ rel: 'Excluded/in.txt' }, { rel: 'in.txt' }] },
      scopeFixture([LOCAL], [`${LOCAL}/Excluded`]),
    )
    calls.length = 0

    const result = await client.checkWorkingTree([`${LOCAL}/Excluded/in.txt`, `${LOCAL}/in.txt`])

    // Exclusion wins over coverage: the include covers everything and the
    // excluded path is still dropped, the same order δ's own answer uses.
    const paths = result.map((d) => d.path)
    expect(paths).not.toContain(`${LOCAL}/Excluded/in.txt`)
    expect(paths).toContain(`${LOCAL}/in.txt`)
    for (const argv of reconcileScans()) {
      expect(argv).not.toContain(`${LOCAL}/Excluded/in.txt`)
    }
  })
})
