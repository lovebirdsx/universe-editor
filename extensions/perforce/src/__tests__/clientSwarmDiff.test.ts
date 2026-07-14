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
      createResourceGroup: () => ({
        id: '',
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

function subcommand(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '-Mj' || arg === '-ztag') continue
    if (arg === '-p' || arg === '-u' || arg === '-c') {
      i++
      continue
    }
    return arg
  }
  return undefined
}

describe('PerforceClient Swarm diff files', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  it('resolves depot files through p4 where and preserves unmapped files as null', async () => {
    spawnMock.mockImplementation((...args: unknown[]) => {
      const argv = (args[1] as string[]) ?? []
      const child = new FakeChildProcess()
      queueMicrotask(() => {
        const cmd = subcommand(argv)
        if (cmd === 'info') {
          child.stdout.emit(
            'data',
            Buffer.from(`... clientName testclient\n... clientRoot ${ROOT}\n... userName bob\n\n`),
          )
        } else if (cmd === 'describe') {
          child.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                change: '900',
                depotFile0: '//depot/src/a.ts',
                action0: 'edit',
                rev0: '3',
                depotFile1: '//unmapped/b.ts',
                action1: 'add',
                rev1: '1',
              }),
            ),
          )
        } else if (cmd === 'where') {
          child.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                depotFile: '//depot/src/a.ts',
                clientFile: '//testclient/src/a.ts',
                path: `${ROOT}/src/a.ts`,
              }),
            ),
          )
        }
        child.emit('close', 0)
      })
      return child
    })

    const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
      enabled: true,
      workspaceTtlMs: 4000,
    })
    expect(client).toBeDefined()

    const files = await client!.describeChangeFiles('900')
    expect(files).toEqual([
      {
        status: 'M',
        path: 'depot/src/a.ts',
        depotFile: '//depot/src/a.ts',
        localPath: `${ROOT}/src/a.ts`,
        baseRevision: '3',
      },
      {
        status: 'A',
        path: 'unmapped/b.ts',
        depotFile: '//unmapped/b.ts',
        localPath: null,
        baseRevision: null,
      },
    ])
    await client!.describeChangeFiles('900')
    expect(
      spawnMock.mock.calls.filter((call) => subcommand((call[1] as string[]) ?? []) === 'describe'),
    ).toHaveLength(1)

    await client!.describeChangeFiles('900', true)
    expect(
      spawnMock.mock.calls.filter((call) => subcommand((call[1] as string[]) ?? []) === 'describe'),
    ).toHaveLength(2)

    client!.dispose()
  })

  it('caches an immutable archive shelf forever, ignoring force and short TTL', async () => {
    let clock = 0
    spawnMock.mockImplementation((...args: unknown[]) => {
      const argv = (args[1] as string[]) ?? []
      const child = new FakeChildProcess()
      queueMicrotask(() => {
        const cmd = subcommand(argv)
        if (cmd === 'info') {
          child.stdout.emit(
            'data',
            Buffer.from(`... clientName testclient\n... clientRoot ${ROOT}\n... userName bob\n\n`),
          )
        } else if (cmd === 'describe') {
          child.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                change: '2999',
                depotFile0: '//depot/src/a.ts',
                action0: 'edit',
                rev0: '3',
              }),
            ),
          )
        } else if (cmd === 'where') {
          child.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                depotFile: '//depot/src/a.ts',
                clientFile: '//testclient/src/a.ts',
                path: `${ROOT}/src/a.ts`,
              }),
            ),
          )
        }
        child.emit('close', 0)
      })
      return child
    })

    const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
      enabled: true,
      workspaceTtlMs: 4000,
      now: () => clock,
    })
    expect(client).toBeDefined()

    const describeCount = () =>
      spawnMock.mock.calls.filter((call) => subcommand((call[1] as string[]) ?? []) === 'describe')
        .length

    await client!.describeChangeFiles('2999', false, true)
    expect(describeCount()).toBe(1)

    // Well past the workspace TTL: an immutable snapshot must still be a cache hit.
    clock += 60_000
    await client!.describeChangeFiles('2999', false, true)
    expect(describeCount()).toBe(1)

    // force is ignored for an immutable change — no re-fetch.
    await client!.describeChangeFiles('2999', true, true)
    expect(describeCount()).toBe(1)

    client!.dispose()
  })
})
