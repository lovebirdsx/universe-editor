/**
 * `PerforceClient.listBehindChangelists` semantics: the two-command "which
 * changelists am I missing" picker. The cheap `changes -s submitted -l -m 51`
 * listing (the +1 probes for older history), the `cstat <scope>@<oldest>,#head`
 * classification pass that bounds the revision range to the listed window, and
 * the three degradations — changes failure, cstat failure, cstat empty — each of
 * which must never read as "everything is synced".
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

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  showMessage: vi.fn(),
}))

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

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const ROOT_FWD = process.platform === 'win32' ? 'C:/ws' : '/ws'

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

/** Every argv the client spawned, for asserting what a command actually ran. */
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

const DISCOVERY = `... clientName testclient\n... clientRoot ${ROOT}\n... userName testuser\n\n`

function changeRecord(id: number): string {
  return [
    `... change ${id}`,
    '... time 1788093183',
    '... user testuser',
    '... client testclient',
    '... status submitted',
    '... changeType public',
    `... desc change ${id} description`,
    '',
  ].join('\n')
}

function changeRecords(ids: readonly number[]): string {
  return ids.map(changeRecord).join('\n')
}

function cstatRecord(id: number, status: string): string {
  return [`... change ${id}`, `... status ${status}`, ''].join('\n')
}

function cstatRecords(entries: ReadonlyArray<readonly [number, string]>): string {
  return entries.map(([id, status]) => cstatRecord(id, status)).join('\n')
}

function makeHandler(
  changesReply: (argv: string[]) => Reply,
  cstatReply: (argv: string[]) => Reply,
): (argv: string[]) => Reply {
  return (argv) => {
    const cmd = subcommand(argv)
    if (cmd === 'info') return { stdout: DISCOVERY }
    if (cmd === 'changes') return changesReply(argv)
    if (cmd === 'cstat') return cstatReply(argv)
    return { stdout: '' }
  }
}

async function makeClient(
  changesReply: (argv: string[]) => Reply,
  cstatReply: (argv: string[]) => Reply,
  log?: (msg: string) => void,
) {
  respond(makeHandler(changesReply, cstatReply))
  const client = await PerforceClient.create(
    ROOT,
    {},
    new ConcurrencyGate(4),
    { enabled: true, workspaceTtlMs: 4000 },
    log,
  )
  expect(client).toBeDefined()
  return client!
}

/** The argv of the `changes` listing, sliced from the subcommand name. */
function changesArgv(): string[] | undefined {
  const argv = spawned.filter((a) => subcommand(a) === 'changes').at(-1)
  if (!argv) return undefined
  return argv.slice(argv.indexOf('changes'))
}

/** The argv of the `cstat` classification pass, sliced from the subcommand name. */
function cstatArgv(): string[] | undefined {
  const argv = spawned.filter((a) => subcommand(a) === 'cstat').at(-1)
  if (!argv) return undefined
  return argv.slice(argv.indexOf('cstat'))
}

beforeEach(() => {
  installBridge()
  spawnMock.mockReset()
  spawned.length = 0
  vi.clearAllMocks()
  mocks.executeCommand.mockResolvedValue(undefined)
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
})

describe('PerforceClient.listBehindChangelists', () => {
  it('lists with -m 51 and classifies via cstat bounded to the oldest id', async () => {
    const client = await makeClient(
      () => ({ stdout: changeRecords([103, 102, 101]) }),
      () => ({
        stdout: cstatRecords([
          [103, 'have'],
          [102, 'need'],
          [101, 'partial'],
        ] as const),
      }),
    )

    const res = await client.listBehindChangelists()

    expect(changesArgv()).toEqual(['changes', '-s', 'submitted', '-l', '-m', '51', '//...'])
    expect(cstatArgv()).toEqual(['cstat', '//...@101,#head'])
    expect(res.classified).toBe(true)
    expect(res.ok).toBe(true)
    expect(res.changes.map((c) => c.id)).toEqual(['102', '101'])
    expect(res.changes.map((c) => c.status)).toEqual(['need', 'partial'])
  })

  it('appends @<oldest>,#head to every scope for cstat', async () => {
    const client = await makeClient(
      () => ({ stdout: changeRecords([3, 2, 1]) }),
      () => ({
        stdout: cstatRecords([
          [3, 'have'],
          [2, 'need'],
          [1, 'partial'],
        ] as const),
      }),
    )
    client.setSyncScope([`${ROOT_FWD}/a`, `${ROOT_FWD}/b`])

    await client.listBehindChangelists()

    expect(changesArgv()).toEqual([
      'changes',
      '-s',
      'submitted',
      '-l',
      '-m',
      '51',
      `${ROOT_FWD}/a/...`,
      `${ROOT_FWD}/b/...`,
    ])
    expect(cstatArgv()).toEqual(['cstat', `${ROOT_FWD}/a/...@1,#head`, `${ROOT_FWD}/b/...@1,#head`])
  })

  it('sets hasMore and truncates to 50 when 51 changelists are listed', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => 151 - i)
    const client = await makeClient(
      () => ({ stdout: changeRecords(ids) }),
      () => ({ stdout: cstatRecords(ids.slice(0, 50).map((id) => [id, 'need'] as const)) }),
    )

    const res = await client.listBehindChangelists()

    expect(res.hasMore).toBe(true)
    expect(res.classified).toBe(true)
    expect(res.changes).toHaveLength(50)
    expect(res.changes[0]!.id).toBe('151')
    expect(res.changes[49]!.id).toBe('102')
  })

  it('filters have and keeps need/partial when cstat answers', async () => {
    const client = await makeClient(
      () => ({ stdout: changeRecords([104, 103, 102, 101]) }),
      () => ({
        stdout: cstatRecords([
          [104, 'have'],
          [103, 'need'],
          [102, 'partial'],
          [101, 'have'],
        ] as const),
      }),
    )

    const res = await client.listBehindChangelists()

    expect(res.classified).toBe(true)
    expect(res.ok).toBe(true)
    expect(res.changes.map((c) => c.id)).toEqual(['103', '102'])
    expect(res.changes.map((c) => c.status)).toEqual(['need', 'partial'])
  })

  it('degrades to the unclassified list when cstat fails', async () => {
    const log = vi.fn<(msg: string) => void>()
    const client = await makeClient(
      () => ({ stdout: changeRecords([102, 101]) }),
      () => ({ stderr: 'Unknown command. Try p4 help.', exit: 1 }),
      log,
    )

    const res = await client.listBehindChangelists()

    expect(res.ok).toBe(true)
    expect(res.classified).toBe(false)
    expect(res.hasMore).toBe(false)
    expect(res.changes.map((c) => c.id)).toEqual(['102', '101'])
    expect(res.changes.every((c) => c.status === 'unknown')).toBe(true)
    expect(log.mock.calls.flat().join('\n')).toContain('cstat failed')
  })

  it('degrades to the unclassified list when cstat returns no usable records', async () => {
    const log = vi.fn<(msg: string) => void>()
    const client = await makeClient(
      () => ({ stdout: changeRecords([102, 101]) }),
      () => ({ stdout: '... change 999\n... status something-else\n\n' }),
      log,
    )

    const res = await client.listBehindChangelists()

    expect(res.ok).toBe(true)
    expect(res.classified).toBe(false)
    expect(res.changes.map((c) => c.id)).toEqual(['102', '101'])
    expect(res.changes.every((c) => c.status === 'unknown')).toBe(true)
    expect(log.mock.calls.flat().join('\n')).toContain('no usable records')
  })

  it('reports ok:false and skips cstat when the changes listing fails', async () => {
    const client = await makeClient(
      () => ({ stderr: `//depot/branch_x/... - must refer to client 'testclient'.`, exit: 1 }),
      () => ({ stdout: '' }),
    )

    const res = await client.listBehindChangelists()

    expect(res.ok).toBe(false)
    expect(res.classified).toBe(false)
    expect(res.changes).toEqual([])
    expect(res.hasMore).toBe(false)
    expect(spawned.filter((a) => subcommand(a) === 'changes')).toHaveLength(1)
    expect(spawned.filter((a) => subcommand(a) === 'cstat')).toHaveLength(0)
  })

  it('skips cstat when no changelists were listed', async () => {
    const client = await makeClient(
      () => ({ stdout: '' }),
      () => ({ stdout: '' }),
    )

    const res = await client.listBehindChangelists()

    expect(res.ok).toBe(true)
    expect(res.classified).toBe(true)
    expect(res.changes).toEqual([])
    expect(res.hasMore).toBe(false)
    expect(spawned.filter((a) => subcommand(a) === 'cstat')).toHaveLength(0)
  })
})
