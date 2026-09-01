/**
 * Unit tests for the unified Revert precheck: `openedStateAmong` (file
 * selection) and `openedInTree` (Explorer directory). Both are cache-first +
 * live `p4 opened`, and both fail open so a query error cannot be confirmed as
 * uncollected-only.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { norm } from '../pathUtil.js'

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
type PerforceClientInstance = import('../client.js').PerforceClient

const ROOT = process.platform === 'win32' ? 'X:\\p4ws\\main' : '/p4ws/main'
const LOCAL = process.platform === 'win32' ? 'X:/p4ws/main' : '/p4ws/main'
const CLIENT = 'testclient'

interface RespondOptions {
  opened?: () => { rel: string; action?: string; change?: string }[]
  /** Live `p4 opened` with a filespec (precheck), distinct from refresh. */
  openedLive?: 'fail' | (() => { rel: string; action?: string; change?: string }[])
}

const calls: string[][] = []

function openedSpecs(argv: string[]): string[] {
  const i = argv.indexOf('opened')
  if (i < 0) return []
  return argv.slice(i + 1)
}

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

function emitOpened(rows: { rel: string; action?: string; change?: string }[]): string {
  return rows
    .map((r) =>
      JSON.stringify({
        depotFile: `//depot/branch_x/${r.rel}`,
        clientFile: `//${CLIENT}/${r.rel}`,
        action: r.action ?? 'edit',
        rev: '1',
        change: r.change ?? 'default',
      }),
    )
    .join('\n')
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
    const specs = openedSpecs(argv)
    if (specs.length > 0) {
      if (opts.openedLive === 'fail') {
        return { stdout: '', stderr: 'opened failed', exit: 1 }
      }
      return { stdout: emitOpened(opts.openedLive?.() ?? []) }
    }
    return { stdout: emitOpened(opts.opened?.() ?? []) }
  }
  return { stdout: '' }
}

function openedCalls(): string[][] {
  return calls.filter((a) => subcommand(a) === 'opened')
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

describe('PerforceClient.openedStateAmong / openedInTree', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
    calls.length = 0
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  it('cache hit: no live opened spawn', async () => {
    const client = await makeClient({ opened: () => [{ rel: 'a.txt', change: 'default' }] })
    await client.refresh()
    calls.length = 0
    const state = await client.openedStateAmong([`${LOCAL}/a.txt`])
    expect(state.get(norm(`${LOCAL}/a.txt`))).toBe('default')
    expect(openedCalls()).toHaveLength(0)
    client.dispose()
  })

  it('cache miss: live opened preserves changelist', async () => {
    const client = await makeClient({
      openedLive: () => [{ rel: 'b.txt', change: '123' }],
    })
    calls.length = 0
    const state = await client.openedStateAmong([`${LOCAL}/b.txt`])
    expect(state.get(norm(`${LOCAL}/b.txt`))).toBe('123')
    expect(openedCalls().length).toBeGreaterThan(0)
    client.dispose()
  })

  it('live success with empty records stays unopened (not fail-open)', async () => {
    const client = await makeClient()
    calls.length = 0
    const state = await client.openedStateAmong([`${LOCAL}/ghost.txt`])
    expect(state.has(norm(`${LOCAL}/ghost.txt`))).toBe(false)
    client.dispose()
  })

  it('live failure fail-opens the miss as opened with unknown CL', async () => {
    const client = await makeClient({ openedLive: 'fail' })
    calls.length = 0
    const state = await client.openedStateAmong([`${LOCAL}/ghost.txt`])
    expect(state.has(norm(`${LOCAL}/ghost.txt`))).toBe(true)
    expect(state.get(norm(`${LOCAL}/ghost.txt`))).toBeUndefined()
    client.dispose()
  })

  it('openedInTree unions cache with live and always live-queries', async () => {
    const client = await makeClient({
      opened: () => [{ rel: 'src/a.txt', change: 'default' }],
      openedLive: () => [{ rel: 'src/b.txt', change: '123' }],
    })
    await client.refresh()
    calls.length = 0
    const tree = await client.openedInTree(`${LOCAL}/src`)
    expect(tree.unknown).toBe(false)
    const byRel = new Map(tree.files.map((f) => [norm(f.path), f.changelist]))
    expect(byRel.get(norm(`${LOCAL}/src/a.txt`))).toBe('default')
    expect(byRel.get(norm(`${LOCAL}/src/b.txt`))).toBe('123')
    expect(openedCalls().some((a) => openedSpecs(a).some((s) => s.endsWith('/...')))).toBe(true)
    client.dispose()
  })

  it('openedInTree live failure uses cache when present', async () => {
    const client = await makeClient({
      opened: () => [{ rel: 'src/a.txt', change: '8' }],
      openedLive: 'fail',
    })
    await client.refresh()
    const tree = await client.openedInTree(`${LOCAL}/src`)
    expect(tree.unknown).toBe(false)
    expect(tree.files).toEqual([{ path: norm(`${LOCAL}/src/a.txt`), changelist: '8' }])
    client.dispose()
  })

  it('openedInTree live failure with empty cache is unknown', async () => {
    const client = await makeClient({ openedLive: 'fail' })
    const tree = await client.openedInTree(`${LOCAL}/src`)
    expect(tree).toEqual({ files: [], unknown: true })
    client.dispose()
  })
})
