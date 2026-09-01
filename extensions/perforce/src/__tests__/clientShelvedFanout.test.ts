/**
 * Two refresh-time fan-out guards that outlived the "changes to reconcile"
 * group they used to be tested alongside:
 *  1. `describe -S -s` runs only for pending changelists that report a shelf.
 *  2. `reconcileInto('default')` never passes the literal 'default' to p4.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expandP4Argv } from './expandP4Argv.js'

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

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const LOCAL = process.platform === 'win32' ? 'C:/ws' : '/ws'
const CLIENT = 'testclient'

const calls: string[][] = []

interface RespondOptions {
  /** Pending changelists reported by `p4 changes -s pending`. `shelved: true`
   *  emits the bare `shelved` key real p4 uses to flag a changelist with a shelf. */
  changes?: () => { id: string; desc?: string; shelved?: boolean }[]
}

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

function handle(argv: string[], opts: RespondOptions): { stdout: string } {
  const cmd = subcommand(argv)
  if (cmd === 'info') {
    return { stdout: `... clientName ${CLIENT}\n... clientRoot ${ROOT}\n... userName bob\n\n` }
  }
  if (cmd === 'changes') {
    const rows = opts.changes?.() ?? []
    return {
      stdout: rows
        .map((r) =>
          JSON.stringify({
            change: r.id,
            desc: r.desc ?? '',
            status: 'pending',
            client: CLIENT,
            // A bare `shelved` key (empty value) is p4's flag for "has a shelf";
            // the key is absent entirely otherwise.
            ...(r.shelved ? { shelved: '' } : {}),
          }),
        )
        .join('\n'),
    }
  }
  return { stdout: '' }
}

async function makeClient(opts: RespondOptions = {}): Promise<PerforceClientInstance> {
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = expandP4Argv((args[1] as string[]) ?? [])
    calls.push(argv)
    const child = new FakeChildProcess()
    queueMicrotask(() => {
      const { stdout } = handle(argv, opts)
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      child.emit('close', 0)
    })
    return child
  })
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

describe('PerforceClient refresh fan-out', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
    calls.length = 0
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  // Regression: `describe -S -s` used to run once per *pending* changelist, even
  // though only changelists holding a shelf have anything to report. `describe`
  // lists every file in a changelist, so on a client with many pending changelists
  // — one of them a giant branch CL — this serialized GB-scale, minutes-long
  // commands behind the status-bar spinner after every mutation. `p4 changes`
  // reports a bare `shelved` key for the changelists that have a shelf; the
  // refresh must filter on it.
  it('describes only the pending changelists that report a shelf', async () => {
    const client = await makeClient({
      changes: () => [
        { id: '100', desc: 'no shelf' },
        { id: '101', desc: 'has a shelf', shelved: true },
        { id: '102', desc: 'also no shelf' },
      ],
    })
    calls.length = 0

    await client.refresh()

    const describes = calls.filter((a) => subcommand(a) === 'describe')
    expect(describes).toHaveLength(1)
    expect(describes[0]).toContain('101')

    client.dispose()
  })

  it('makes zero describe calls when no pending changelist has a shelf', async () => {
    const client = await makeClient({
      changes: () => [{ id: '100' }, { id: '101' }, { id: '102' }],
    })
    calls.length = 0

    await client.refresh()

    expect(calls.filter((a) => subcommand(a) === 'describe')).toHaveLength(0)

    client.dispose()
  })

  it('reconcileInto collects a not-yet-opened file straight into a numbered changelist', async () => {
    const client = await makeClient()
    calls.length = 0

    await client.reconcileInto('1000', [`${LOCAL}/a.txt`])

    const real = calls.find(
      (a) => subcommand(a) === 'reconcile' && !a.includes('-n') && a.includes(`${LOCAL}/a.txt`),
    )
    expect(real).toBeDefined()
    // `-c 1000` (the changelist), distinct from any global `-c <client>` option.
    expect(real![real!.indexOf('1000') - 1]).toBe('-c')

    client.dispose()
  })

  it('reconcileInto default omits the changelist flag', async () => {
    const client = await makeClient()
    calls.length = 0

    await client.reconcileInto('default', [`${LOCAL}/a.txt`])

    const real = calls.find(
      (a) => subcommand(a) === 'reconcile' && !a.includes('-n') && a.includes(`${LOCAL}/a.txt`),
    )
    expect(real).toBeDefined()
    // No changelist targeting — the literal 'default' is never passed to reconcile.
    expect(real).not.toContain('default')

    client.dispose()
  })
})
