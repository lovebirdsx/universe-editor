/**
 * The graph's "local sync point" probe: `p4 changes -s submitted -m 1 <spec>#have`.
 *
 * Three properties carry the feature, and each has a way to break silently:
 *  - the `#have` suffix must be appended AFTER filespec escaping (a literal `#`
 *    in a path is `%23` by then — appending first would leave two revision
 *    specifiers in one filespec);
 *  - the probe must be scoped to the very same filespecs the listing used, or it
 *    can name a changelist the list does not contain and the badge never shows;
 *  - a failure must degrade to "no answer" (`failed: true`, and NOT cached, so the
 *    next load retries), while an empty answer ("nothing synced") IS an answer
 *    (`failed: false`) and IS cached — the renderer keeps its previous badge on
 *    the former and moves/clears it on the latter.
 *
 * `#have` rather than `@<client>`: same answer on a real server, but `@client`
 * first materializes the client's whole have list (~6s before it touches a path
 * on a million-file workspace, ~15s where `#have` answers in 340ms).
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
function installScmBridge(): void {
  const group = () => ({
    id: '',
    label: '',
    hideWhenEmpty: undefined,
    resourceStates: [],
    dispose() {},
  })
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
      createResourceGroup: group,
      dispose() {},
    }),
  }
}

const { PerforceClient } = await import('../client.js')
const { ConcurrencyGate } = await import('../concurrency.js')
const { buildScopeFilespec } = await import('../p4Filespec.js')

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const CLIENT = 'testclient'

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

/** Non-flag arguments (the filespecs), skipping the values of valued flags. */
function filespecs(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-Mj' || a === '-ztag') continue
    if (a === '-p' || a === '-u' || a === '-c' || a === '-s' || a === '-m') {
      i++
      continue
    }
    if (a.startsWith('-')) continue
    out.push(a)
  }
  return out
}

function changeRecord(id: string): string {
  return JSON.stringify({
    change: id,
    user: 'testuser',
    client: CLIENT,
    time: '1700000000',
    desc: `change ${id}`,
  })
}

interface HarnessOptions {
  /** Id the have probe answers with; null = an empty answer (nothing synced). */
  have?: string | null
  /** Exit code of the have probe (non-zero = failure). */
  haveExit?: number
  /** Listing ids. */
  list?: readonly string[]
}

interface Harness {
  haveArgvs: string[][]
  listArgvs: string[][]
  create: () => ReturnType<typeof PerforceClient.create>
}

/** Routes every `changes` spawn to the have/list bucket by its `#have` suffix. */
function harness(opts: HarnessOptions = {}): Harness {
  const haveArgvs: string[][] = []
  const listArgvs: string[][] = []
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[1] as string[]) ?? []
    const child = new FakeChildProcess()
    queueMicrotask(() => {
      const cmd = subcommand(argv)
      let stdout = ''
      let exit = 0
      if (cmd === 'info') {
        stdout = `... clientName ${CLIENT}\n... clientRoot ${ROOT}\n... userName testuser\n\n`
      } else if (cmd === 'changes') {
        if (filespecs(argv).some((f) => f.endsWith('#have'))) {
          haveArgvs.push(argv)
          const id = opts.have ?? null
          stdout = id ? changeRecord(id) : ''
          exit = opts.haveExit ?? 0
        } else {
          listArgvs.push(argv)
          stdout = (opts.list ?? ['4522', '4521']).map(changeRecord).join('\n')
        }
      }
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      child.emit('close', exit)
    })
    return child
  })
  return {
    haveArgvs,
    listArgvs,
    create: () =>
      PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
        enabled: true,
        workspaceTtlMs: 30_000,
      }),
  }
}

const SCOPES = ['X:/p4ws/main/a.txt', 'X:/p4ws/main/some dir/...']

describe('PerforceClient.getGraphHaveChange', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  it('asks for the newest have-list change, one `#have` suffix per filespec', async () => {
    const h = harness({ have: '4519' })
    const client = await h.create()
    const answer = await client!.getGraphHaveChange(SCOPES)

    expect(answer).toEqual({ id: '4519', failed: false })
    const argv = h.haveArgvs[0]!
    expect(argv.slice(argv.indexOf('changes'))).toEqual([
      'changes',
      '-s',
      'submitted',
      '-m',
      '1',
      `${SCOPES[0]}#have`,
      `${SCOPES[1]}#have`,
    ])
    client!.dispose()
  })

  it('probes with the same filespecs the listing used (no suffix on the list call)', async () => {
    // The renderer badges the row whose id comes back, so a probe scoped any
    // differently than the listing could name a row that is not there.
    const h = harness({ have: '4521' })
    const client = await h.create()
    await client!.getGraphChanges(10, SCOPES)
    await client!.getGraphHaveChange(SCOPES)

    const list = h.listArgvs[0]!
    expect(list.slice(list.indexOf('changes'))).toEqual([
      'changes',
      '-s',
      'submitted',
      '-l',
      '-m',
      '11',
      ...SCOPES,
    ])
    expect(h.haveArgvs[0]!.filter((a) => a.endsWith('#have'))).toEqual([
      `${SCOPES[0]}#have`,
      `${SCOPES[1]}#have`,
    ])
    client!.dispose()
  })

  it('appends `#have` AFTER escaping, leaving path metacharacters escaped', async () => {
    const h = harness({ have: '4521' })
    const client = await h.create()
    await client!.getGraphHaveChange([
      buildScopeFilespec('X:/p4ws/main/a@b.txt', false),
      buildScopeFilespec('X:/p4ws/main/a#b.txt', false),
    ])

    const argv = h.haveArgvs[0]!
    expect(argv).toContain('X:/p4ws/main/a%40b.txt#have')
    expect(argv).toContain('X:/p4ws/main/a%23b.txt#have')
    // Exactly one unescaped `#` per spec, and it is the suffix: had the suffix
    // been appended before escaping, the path's own `#` would collide with it.
    for (const spec of argv.filter((a) => a.includes('a%'))) {
      expect(spec.split('#')).toHaveLength(2)
    }
    client!.dispose()
  })

  it('passes a client-root wildcard through verbatim (the whole-repo carve-out)', async () => {
    // `//...` cannot carry a revision specifier at all (`Path 'E:/...' is not
    // under client's root`), so the whole-repo probe asks the client root's
    // wildcard instead. Nothing here strips or re-derives the scope — the
    // extension resolves it, this layer only appends the suffix.
    const h = harness({ have: '4521' })
    const client = await h.create()
    await client!.getGraphHaveChange([buildScopeFilespec('//depot/branch_x', true)])

    expect(h.haveArgvs[0]!).toContain('//depot/branch_x/...#have')
    client!.dispose()
  })

  it('answers `failed` (never an empty id) on a failed probe, without disturbing the listing', async () => {
    const h = harness({ haveExit: 1 })
    const client = await h.create()
    // `failed`, not `{ id: null }`: the renderer must keep the badge it has rather
    // than read this as "nothing is synced here".
    expect(await client!.getGraphHaveChange(SCOPES)).toEqual({ id: null, failed: true })
    const listing = await client!.getGraphChanges(10, SCOPES)
    expect(listing?.changes.map((c) => c.id)).toEqual(['4522', '4521'])
    client!.dispose()
  })

  it('does not cache a failure (the next load retries it)', async () => {
    const h = harness({ haveExit: 1 })
    const client = await h.create()
    await client!.getGraphHaveChange(SCOPES)
    await client!.getGraphHaveChange(SCOPES)
    expect(h.haveArgvs.length).toBe(2)
    client!.dispose()
  })

  it('caches an empty answer (nothing synced is a real answer)', async () => {
    const h = harness({ have: null })
    const client = await h.create()
    expect(await client!.getGraphHaveChange(SCOPES)).toEqual({ id: null, failed: false })
    expect(await client!.getGraphHaveChange(SCOPES)).toEqual({ id: null, failed: false })
    expect(h.haveArgvs.length).toBe(1)
    client!.dispose()
  })

  it('re-runs a cached answer only when asked to (explicit reload)', async () => {
    // Re-running the probe costs the SIZE of the scope (tens of seconds over a
    // whole workspace), so only the explicit reload path passes `force`.
    const h = harness({ have: '4521' })
    const client = await h.create()
    await client!.getGraphHaveChange(SCOPES)
    await client!.getGraphHaveChange(SCOPES)
    expect(h.haveArgvs.length).toBe(1)

    expect(await client!.getGraphHaveChange(SCOPES, true)).toEqual({ id: '4521', failed: false })
    expect(h.haveArgvs.length).toBe(2)
    client!.dispose()
  })

  it('is order-independent: the same scope set probed twice spawns once', async () => {
    const h = harness({ have: '4521' })
    const client = await h.create()
    await client!.getGraphHaveChange(SCOPES)
    await client!.getGraphHaveChange([...SCOPES].reverse())
    expect(h.haveArgvs.length).toBe(1)
    client!.dispose()
  })

  it('issues nothing for an empty scope list (no filespec to hang `#have` on)', async () => {
    // Without the guard this degrades into a bare `-m 1` — the newest change
    // anywhere in the depot, i.e. the opposite of a have point — and it would
    // answer successfully, so the wrong answer would even be cached.
    const h = harness({ have: '4599' })
    const client = await h.create()
    expect(await client!.getGraphHaveChange([])).toEqual({ id: null, failed: true })
    expect(h.haveArgvs.length).toBe(0)
    expect(h.listArgvs.length).toBe(0)
    client!.dispose()
  })
})
