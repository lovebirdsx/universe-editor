/**
 * The pending-changelist query must pass `-l`. Without it p4 caps every
 * changelist description at 31 characters, so both the SCM group label and its
 * hover tooltip showed a stump of the real text — while every other description
 * read (graph, blame) already asked for the full one.
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

interface FakeGroup {
  id: string
  label: string
  tooltip?: string
  hideWhenEmpty: boolean | undefined
  resourceStates: unknown[]
  dispose(): void
}

const groups = new Map<string, FakeGroup>()

const BRIDGE_KEY = '__universeExtensionHostBridge__'
function installScmBridge(): void {
  groups.clear()
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
      createResourceGroup: (id: string, label: string) => {
        const group: FakeGroup = {
          id,
          label,
          hideWhenEmpty: undefined,
          resourceStates: [],
          dispose() {
            groups.delete(id)
          },
        }
        groups.set(id, group)
        return group
      },
      dispose() {},
    }),
  }
}

const { PerforceClient } = await import('../client.js')
const { ConcurrencyGate } = await import('../concurrency.js')
type PerforceClientInstance = import('../client.js').PerforceClient

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const CLIENT = 'testclient'

/** p4's own cap on a description reported without `-l`. */
const DESCRIPTION_CAP = 31

const calls: string[][] = []

interface RespondOptions {
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
    // Faithful to the real server: the description is capped unless `-l` asks
    // for the whole thing.
    const full = argv.includes('-l')
    return {
      stdout: (opts.changes?.() ?? [])
        .map((r) =>
          JSON.stringify({
            change: r.id,
            desc: full ? (r.desc ?? '') : (r.desc ?? '').slice(0, DESCRIPTION_CAP),
            status: 'pending',
            client: CLIENT,
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

describe('PerforceClient pending changelist descriptions', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
    calls.length = 0
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  it('requests the full description and hands it to the group as the hover tooltip', async () => {
    const desc = 'a first line far longer than thirty-one characters\n\nsecond line detail'
    const client = await makeClient({ changes: () => [{ id: '1000', desc }] })
    calls.length = 0

    await client.refresh()

    expect(calls.find((a) => subcommand(a) === 'changes')).toContain('-l')
    expect(groups.get('cl:1000')?.label).toBe(
      '#1000: a first line far longer than thirty-one characters',
    )
    expect(groups.get('cl:1000')?.tooltip).toBe(`#1000: ${desc}`)

    client.dispose()
  })

  it('leaves the default group and a description-less changelist without a tooltip', async () => {
    const client = await makeClient({ changes: () => [{ id: '1000' }] })
    calls.length = 0

    await client.refresh()

    expect(groups.get('default')?.tooltip).toBeUndefined()
    expect(groups.get('cl:1000')).toMatchObject({ label: '#1000', tooltip: undefined })

    client.dispose()
  })
})
