/**
 * The graph's "local sync point" probe: `p4 changes -s submitted -m 1 <spec>@<client>`.
 *
 * Three properties carry the feature, and each has a way to break silently:
 *  - the `@<client>` suffix must be appended AFTER filespec escaping (a literal
 *    `@` in a path is `%40` by then — appending first would leave two revision
 *    specifiers in one filespec);
 *  - the probe must be scoped to the very same filespecs the listing used, or it
 *    can name a changelist the list does not contain and the badge never shows;
 *  - a failure must degrade to "no badge" (null) and must NOT be cached, while an
 *    empty answer ("nothing synced") IS an answer and IS cached.
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

/** Routes every `changes` spawn to the have/list bucket by its `@<client>` suffix. */
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
        if (filespecs(argv).some((f) => f.includes('@'))) {
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

  it('asks for the newest have-list change, one `@<client>` suffix per filespec', async () => {
    const h = harness({ have: '4519' })
    const client = await h.create()
    const id = await client!.getGraphHaveChange(SCOPES)

    expect(id).toBe('4519')
    const argv = h.haveArgvs[0]!
    expect(argv.slice(argv.indexOf('changes'))).toEqual([
      'changes',
      '-s',
      'submitted',
      '-m',
      '1',
      `${SCOPES[0]}@${CLIENT}`,
      `${SCOPES[1]}@${CLIENT}`,
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
    expect(h.haveArgvs[0]!.filter((a) => a.endsWith(`@${CLIENT}`))).toEqual([
      `${SCOPES[0]}@${CLIENT}`,
      `${SCOPES[1]}@${CLIENT}`,
    ])
    client!.dispose()
  })

  it('appends the client AFTER escaping, leaving a path @ as %40', async () => {
    const h = harness({ have: '4521' })
    const client = await h.create()
    const scope = buildScopeFilespec('X:/p4ws/main/a@b.txt', false)
    await client!.getGraphHaveChange([scope])

    const spec = h.haveArgvs[0]!.find((a) => a.includes('a%40b'))!
    expect(spec).toBe(`X:/p4ws/main/a%40b.txt@${CLIENT}`)
    // Exactly one unescaped `@` in the whole spec, and it is the suffix.
    expect(spec.split('@')).toHaveLength(2)
    client!.dispose()
  })

  it('degrades to null on a failed probe without disturbing the listing', async () => {
    const h = harness({ haveExit: 1 })
    const client = await h.create()
    expect(await client!.getGraphHaveChange(SCOPES)).toBeNull()
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
    expect(await client!.getGraphHaveChange(SCOPES)).toBeNull()
    expect(await client!.getGraphHaveChange(SCOPES)).toBeNull()
    expect(h.haveArgvs.length).toBe(1)
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

  it('issues nothing when the client name is unknown (a bare @ means nothing)', async () => {
    const h = harness()
    // Bypasses discovery: `p4 info` without a clientName falls back to a
    // `p4 clients` scan, which would answer "no client" and disable the provider.
    const client = PerforceClient.createForClient(
      { clientName: '', clientRoot: ROOT },
      {},
      new ConcurrencyGate(4),
      { enabled: true, workspaceTtlMs: 30_000 },
    )
    expect(await client.getGraphHaveChange(SCOPES)).toBeNull()
    expect(h.haveArgvs.length).toBe(0)
    client.dispose()
  })

  it('issues nothing for an empty scope list (no filespec to hang `@<client>` on)', async () => {
    // Without the guard this degrades into a bare `-m 1` — the newest change
    // anywhere in the depot, i.e. the opposite of a have point — and it would
    // answer successfully, so the wrong answer would even be cached.
    const h = harness({ have: '4599' })
    const client = await h.create()
    expect(await client!.getGraphHaveChange([])).toBeNull()
    expect(h.haveArgvs.length).toBe(0)
    expect(h.listArgvs.length).toBe(0)
    client!.dispose()
  })
})
