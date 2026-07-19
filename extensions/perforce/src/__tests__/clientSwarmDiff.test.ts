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

  it('prints an out-of-view shelved file by dropping the client (-c) global', async () => {
    // Model real p4's client-view filter: `p4 print //depot/…@=<change>` bound to
    // a client (`-c`) prints empty for a depot path not mapped in that client's
    // view (the out-of-workspace Swarm diff case). Without `-c` the depot spec has
    // no view to filter against and prints. This is the whole bug: the diff was
    // blank because printRevision spawned with `-c` and the shelf print failed.
    const printArgvs: string[][] = []
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
          child.emit('close', 0)
          return
        }
        if (cmd === 'print') {
          printArgvs.push(argv)
          const spec = argv[argv.indexOf('print') + 2] ?? ''
          const outOfView = spec.startsWith('//unmapped/')
          const boundToClient = argv.includes('-c')
          if (outOfView && boundToClient) {
            child.stderr.emit('data', Buffer.from(`${spec} - no such file(s).\n`))
            child.emit('close', 1)
          } else {
            child.stdout.emit('data', Buffer.from('SHELVED CONTENT\n'))
            child.emit('close', 0)
          }
          return
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

    const content = await client!.printRevision('//unmapped/b.ts@=900')
    expect(content).toBe('SHELVED CONTENT\n')

    const printArgv = printArgvs.at(-1)!
    expect(printArgv).not.toContain('-c')
    expect(printArgv).toContain('-u')

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

  // `describe -S` reports a file's `rev` with a state-dependent meaning: for a
  // SUBMITTED change it's the revision that contains the edit (base = rev-1); for
  // a PENDING shelf it's already the pre-edit base (base = rev). Getting this
  // wrong made both diff sides identical (blank diff) for committed reviews.
  function describeReturning(fields: Record<string, string>) {
    return (...args: unknown[]) => {
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
          child.stdout.emit('data', Buffer.from(JSON.stringify(fields)))
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
    }
  }

  it('bases a submitted change on rev-1 (the pre-edit revision)', async () => {
    spawnMock.mockImplementation(
      describeReturning({
        change: '8143439',
        status: 'submitted',
        depotFile0: '//depot/src/a.ts',
        action0: 'edit',
        rev0: '18',
      }),
    )
    const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
      enabled: true,
      workspaceTtlMs: 4000,
    })
    const files = await client!.describeChangeFiles('8143439')
    expect(files[0]?.baseRevision).toBe('17')
    client!.dispose()
  })

  it('bases a pending shelf on its reported rev (already the pre-edit base)', async () => {
    spawnMock.mockImplementation(
      describeReturning({
        change: '8144405',
        status: 'pending',
        depotFile0: '//depot/src/a.ts',
        action0: 'edit',
        rev0: '3',
      }),
    )
    const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
      enabled: true,
      workspaceTtlMs: 4000,
    })
    const files = await client!.describeChangeFiles('8144405')
    expect(files[0]?.baseRevision).toBe('3')
    client!.dispose()
  })

  it('has no base for a submitted change whose file is at rev 1', async () => {
    spawnMock.mockImplementation(
      describeReturning({
        change: '500',
        status: 'submitted',
        depotFile0: '//depot/src/a.ts',
        action0: 'edit',
        rev0: '1',
      }),
    )
    const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
      enabled: true,
      workspaceTtlMs: 4000,
    })
    const files = await client!.describeChangeFiles('500')
    expect(files[0]?.baseRevision).toBeNull()
    client!.dispose()
  })

  // printRevisionBytes backs the spreadsheet webview diff: it must return the
  // exact bytes p4 printed (base64 round-trips them to the Excel extension), so a
  // binary xlsx isn't corrupted the way a utf8 string `print` would corrupt it.
  it('returns exact raw bytes for a binary revision (no utf8 corruption)', async () => {
    // A minimal zip header + bytes that are not valid UTF-8 (0xff 0xfe 0x00).
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x01])
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
        } else if (cmd === 'print') {
          child.stdout.emit('data', bytes)
        }
        child.emit('close', 0)
      })
      return child
    })

    const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
      enabled: true,
      workspaceTtlMs: 4000,
    })
    const out = await client!.printRevisionBytes('//depot/x.xlsx@=900')
    expect(Buffer.isBuffer(out)).toBe(true)
    expect(out).toEqual(bytes)
    client!.dispose()
  })

  it('returns an empty buffer for a null spec (added/deleted side)', async () => {
    spawnMock.mockImplementation((...args: unknown[]) => {
      const argv = (args[1] as string[]) ?? []
      const child = new FakeChildProcess()
      queueMicrotask(() => {
        if (subcommand(argv) === 'info') {
          child.stdout.emit(
            'data',
            Buffer.from(`... clientName testclient\n... clientRoot ${ROOT}\n... userName bob\n\n`),
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
    const out = await client!.printRevisionBytes(null)
    expect(out).toEqual(Buffer.alloc(0))
    // A null spec must not spawn a print at all.
    expect(
      spawnMock.mock.calls.filter((call) => subcommand((call[1] as string[]) ?? []) === 'print'),
    ).toHaveLength(0)
    client!.dispose()
  })
})
