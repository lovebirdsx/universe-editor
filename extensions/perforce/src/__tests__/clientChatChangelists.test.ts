/**
 * `pendingChangelistsUnder(dir)` — the `#` chat picker's pending-changelist
 * scope. Cache-only (built by `refresh` from `p4 opened`), directory-boundary
 * aware, and blind to the default changelist: a chat reference names a numbered
 * changelist or nothing.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clientSpecReply, isClientSpecProbe } from './discoveryProbe.js'

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
const DISCOVERY_SPEC = clientSpecReply(ROOT)
const LOCAL = process.platform === 'win32' ? 'X:/p4ws/main' : '/p4ws/main'
const CLIENT = 'testclient'

interface OpenedRow {
  rel: string
  change?: string
}

interface RespondOptions {
  opened?: () => OpenedRow[]
  changes?: () => { id: string; desc?: string }[]
}

const calls: string[][] = []

function respond(opts: RespondOptions = {}): void {
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[1] as string[]) ?? []
    calls.push(argv)
    const child = new FakeChildProcess()
    queueMicrotask(() => {
      const { stdout } = handle(argv, opts)
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      child.emit('close', 0)
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

/** `p4 opened` reports `clientFile` in CLIENT syntax (`//client/rel`). */
function emitOpened(rows: readonly OpenedRow[]): string {
  return rows
    .map((r) =>
      JSON.stringify({
        depotFile: `//depot/branch_x/${r.rel}`,
        clientFile: `//${CLIENT}/${r.rel}`,
        action: 'edit',
        rev: '1',
        change: r.change ?? 'default',
      }),
    )
    .join('\n')
}

function handle(argv: string[], opts: RespondOptions): { stdout: string } {
  const cmd = subcommand(argv)
  if (isClientSpecProbe(argv)) return { stdout: DISCOVERY_SPEC }
  if (cmd === 'info') {
    return { stdout: `... clientName ${CLIENT}\n... clientRoot ${ROOT}\n... userName testuser\n\n` }
  }
  if (cmd === 'opened') return { stdout: emitOpened(opts.opened?.() ?? []) }
  if (cmd === 'changes') {
    return {
      stdout: (opts.changes?.() ?? [])
        .map((r) =>
          JSON.stringify({
            change: r.id,
            desc: r.desc ?? '',
            status: 'pending',
            client: CLIENT,
          }),
        )
        .join('\n'),
    }
  }
  return { stdout: '' }
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

const CHANGELISTS: RespondOptions['changes'] = () => [
  { id: '1000', desc: 'renderer work' },
  { id: '1001', desc: 'tooling work' },
]

describe('PerforceClient.pendingChangelistsUnder', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
    calls.length = 0
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  it('keeps only the changelists with an opened file under the directory', async () => {
    const client = await makeClient({
      changes: CHANGELISTS,
      opened: () => [
        { rel: 'src/renderer/a.ts', change: '1000' },
        { rel: 'tools/b.ts', change: '1001' },
        { rel: 'top.ts', change: '1000' },
      ],
    })
    await client.refresh()

    expect(client.pendingChangelistsUnder(`${LOCAL}/src`).map((c) => c.id)).toEqual(['1000'])
    expect(client.pendingChangelistsUnder(LOCAL).map((c) => c.id)).toEqual(['1000', '1001'])
    client.dispose()
  })

  it('respects the directory boundary (src must not match src2)', async () => {
    const client = await makeClient({
      changes: CHANGELISTS,
      opened: () => [{ rel: 'src2/a.ts', change: '1000' }],
    })
    await client.refresh()

    expect(client.pendingChangelistsUnder(`${LOCAL}/src`)).toEqual([])
    client.dispose()
  })

  it('never returns the default changelist, even for a file right at the root', async () => {
    const client = await makeClient({
      changes: CHANGELISTS,
      opened: () => [{ rel: 'a.ts' }],
    })
    await client.refresh()

    expect(client.pendingChangelistsUnder(LOCAL)).toEqual([])
    client.dispose()
  })

  it('answers from the cache without spawning p4', async () => {
    const client = await makeClient({
      changes: CHANGELISTS,
      opened: () => [{ rel: 'src/a.ts', change: '1000' }],
    })
    await client.refresh()
    calls.length = 0

    expect(client.pendingChangelistsUnder(`${LOCAL}/src`).map((c) => c.id)).toEqual(['1000'])
    expect(calls).toEqual([])
    client.dispose()
  })

  it('is empty before the first refresh lands', async () => {
    const client = await makeClient({ changes: CHANGELISTS })
    expect(client.pendingChangelistsUnder(LOCAL)).toEqual([])
    client.dispose()
  })
})
