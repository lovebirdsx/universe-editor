/**
 * refresh() coalescing: a concurrent call used to return immediately after
 * flagging `_queued`, so the caller's promise didn't mean "my refresh was
 * actually served". The SCM title Refresh button awaits exactly this promise
 * for its disabled/spinner state — a concurrent refresh must now wait for the
 * in-flight pass (which observes the queued flag and runs another round).
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

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const CLIENT = 'testclient'

/** Spawned children not yet closed, in spawn order. */
const pending: { child: FakeChildProcess; argv: string[] }[] = []
const calls: string[][] = []

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

function finish(child: FakeChildProcess, argv: string[]): void {
  const stdout =
    subcommand(argv) === 'info'
      ? `... clientName ${CLIENT}\n... clientRoot ${ROOT}\n... userName bob\n\n`
      : ''
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout))
    child.emit('close', 0)
  })
}

/** Auto mode closes every child immediately; manual mode parks it in `pending`
 *  so the test can hold a refresh mid-flight. */
let auto = true

/** Close every parked child (each emits on a microtask). */
function flush(): void {
  for (const p of pending.splice(0)) finish(p.child, p.argv)
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

/** Alternately close parked children and yield, until `pred` holds. */
async function drainUntil(pred: () => boolean, maxRounds = 50): Promise<void> {
  for (let i = 0; i < maxRounds && !pred(); i++) {
    flush()
    await tick()
  }
  expect(pred()).toBe(true)
}

describe('PerforceClient refresh coalescing', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
    spawnMock.mockImplementation((...args: unknown[]) => {
      const argv = (args[1] as string[]) ?? []
      calls.push(argv)
      const child = new FakeChildProcess()
      if (auto) finish(child, argv)
      else pending.push({ child, argv })
      return child
    })
    pending.length = 0
    calls.length = 0
    auto = true
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  it('a concurrent refresh waits for the in-flight pass and gets its own round', async () => {
    const client = await PerforceClient.create(
      ROOT,
      {},
      new ConcurrencyGate(4),
      { enabled: true, workspaceTtlMs: 4000 },
      undefined,
    )
    expect(client).toBeDefined()
    auto = false
    calls.length = 0

    const first = client!.refresh()
    // Let the first pass reach its `opened` call, then park there.
    await drainUntil(() => subcommandOfLast('opened') || pending.length > 0)
    expect(pending.length).toBeGreaterThan(0)

    let secondResolved = false
    const second = client!.refresh().then(() => {
      secondResolved = true
    })
    await tick()
    await tick()
    // Old behaviour returned immediately; the caller must now wait in flight.
    expect(secondResolved).toBe(false)

    await drainUntil(() => secondResolved)
    await Promise.all([first, second])

    // The queued flag ran another full round (opened again after the first pass).
    const openedCalls = calls.filter((a) => subcommand(a) === 'opened').length
    expect(openedCalls).toBeGreaterThanOrEqual(2)

    client!.dispose()
  })

  function subcommandOfLast(cmd: string): boolean {
    const last = calls[calls.length - 1]
    return last !== undefined && subcommand(last) === cmd
  }
})
