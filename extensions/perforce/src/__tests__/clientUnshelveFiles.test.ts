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

const writeFileMock = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined)
const chmodMock = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined)
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
  chmod: (...args: unknown[]) => chmodMock(...args),
}))

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

function unshelveCalls(): string[][] {
  return spawnMock.mock.calls
    .map((call) => (call[1] as string[]) ?? [])
    .filter((argv) => subcommand(argv) === 'unshelve')
}

function revertCalls(): string[][] {
  return spawnMock.mock.calls
    .map((call) => (call[1] as string[]) ?? [])
    .filter((argv) => subcommand(argv) === 'revert')
}

function editCalls(): string[][] {
  return spawnMock.mock.calls
    .map((call) => (call[1] as string[]) ?? [])
    .filter((argv) => subcommand(argv) === 'edit')
}

async function createClient() {
  const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
    enabled: true,
    workspaceTtlMs: 4000,
  })
  expect(client).toBeDefined()
  return client!
}

describe('PerforceClient unshelveFiles', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
    writeFileMock.mockClear()
    chmodMock.mockClear()
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  it('reports every file applied when the batch unshelve succeeds, then refreshes', async () => {
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
        // unshelve/opened/changes all exit 0 with empty output.
        child.emit('close', 0)
      })
      return child
    })

    const client = await createClient()
    const files = ['//depot/src/a.ts', '//depot/src/b.ts']
    const result = await client.unshelveFiles('900', files)

    expect(result).toEqual({ applied: files, skipped: [], keptOpen: [] })
    const calls = unshelveCalls()
    expect(calls).toHaveLength(1)
    // argv carries the connection globals first; the command tail is the unshelve spec.
    expect(calls[0]!.slice(-(files.length + 4))).toEqual(['unshelve', '-s', '900', '-f', ...files])
    // Default behavior keeps files open — no revert is spawned.
    expect(revertCalls()).toHaveLength(0)
    // Applied > 0 → a refresh runs (opened query) afterwards.
    expect(
      spawnMock.mock.calls.some((call) => subcommand((call[1] as string[]) ?? []) === 'opened'),
    ).toBe(true)
    client.dispose()
  })

  it('falls back to per-file unshelve when the batch fails, splitting applied/skipped', async () => {
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
        if (cmd === 'unshelve') {
          const fileArgs = argv.slice(argv.indexOf('-f') + 1)
          if (fileArgs.length > 1) {
            // Batch attempt: one file is already open for edit → p4 refuses all.
            child.stderr.emit(
              'data',
              Buffer.from('//depot/src/b.ts - must not unshelve into an open file\n'),
            )
            child.emit('close', 1)
            return
          }
          if (fileArgs[0] === '//depot/src/b.ts') {
            child.stderr.emit(
              'data',
              Buffer.from('\n//depot/src/b.ts - must not unshelve into an open file\n'),
            )
            child.emit('close', 1)
            return
          }
          child.emit('close', 0)
          return
        }
        child.emit('close', 0)
      })
      return child
    })

    const client = await createClient()
    const result = await client.unshelveFiles('900', [
      '//depot/src/a.ts',
      '//depot/src/b.ts',
      '//depot/src/c.ts',
    ])

    expect(result.applied).toEqual(['//depot/src/a.ts', '//depot/src/c.ts'])
    expect(result.skipped).toEqual([
      {
        depotFile: '//depot/src/b.ts',
        reason: '//depot/src/b.ts - must not unshelve into an open file',
      },
    ])
    // 1 batch + 3 per-file retries.
    expect(unshelveCalls()).toHaveLength(4)
    client.dispose()
  })

  it('spawns nothing for an empty file list or the default changelist', async () => {
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

    const client = await createClient()
    expect(await client.unshelveFiles('900', [])).toEqual({
      applied: [],
      skipped: [],
      keptOpen: [],
    })
    expect(await client.unshelveFiles('default', ['//depot/src/a.ts'])).toEqual({
      applied: [],
      skipped: [],
      keptOpen: [],
    })
    expect(unshelveCalls()).toHaveLength(0)
    client.dispose()
  })

  it('does not refresh when nothing applied', async () => {
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
        if (cmd === 'unshelve') {
          child.stderr.emit('data', Buffer.from('//depot/src/a.ts - must not unshelve\n'))
          child.emit('close', 1)
          return
        }
        child.emit('close', 0)
      })
      return child
    })

    const client = await createClient()
    const result = await client.unshelveFiles('900', ['//depot/src/a.ts'])
    expect(result.applied).toEqual([])
    expect(result.skipped).toHaveLength(1)
    // No refresh: the only spawned commands are info (discovery) + unshelve.
    expect(
      spawnMock.mock.calls.filter((call) => subcommand((call[1] as string[]) ?? []) === 'opened'),
    ).toHaveLength(0)
    client.dispose()
  })

  it('revert -k un-opens applied files when intoChangelist is false', async () => {
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

    const client = await createClient()
    const files = ['//depot/src/a.ts', '//depot/src/b.ts']
    const result = await client.unshelveFiles('900', files, { intoChangelist: false })

    expect(result).toEqual({ applied: files, skipped: [], keptOpen: [] })
    const reverts = revertCalls()
    expect(reverts).toHaveLength(1)
    expect(reverts[0]!.slice(-(files.length + 2))).toEqual(['revert', '-k', ...files])
    // Refresh still runs so the opened set is rebuilt without these files.
    expect(
      spawnMock.mock.calls.some((call) => subcommand((call[1] as string[]) ?? []) === 'opened'),
    ).toBe(true)
    client.dispose()
  })

  it('reports keptOpen for files whose revert -k fails after per-file retries', async () => {
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
        if (cmd === 'revert') {
          const fileArgs = argv.slice(argv.indexOf('-k') + 1)
          if (fileArgs.length > 1) {
            // Batch revert refused → per-file retries.
            child.emit('close', 1)
            return
          }
          if (fileArgs[0] === '//depot/src/b.ts') {
            child.stderr.emit('data', Buffer.from('\n//depot/src/b.ts - file(s) not opened\n'))
            child.emit('close', 1)
            return
          }
          child.emit('close', 0)
          return
        }
        child.emit('close', 0)
      })
      return child
    })

    const client = await createClient()
    const result = await client.unshelveFiles('900', ['//depot/src/a.ts', '//depot/src/b.ts'], {
      intoChangelist: false,
    })

    expect(result.applied).toEqual(['//depot/src/a.ts', '//depot/src/b.ts'])
    expect(result.keptOpen).toEqual([
      { depotFile: '//depot/src/b.ts', reason: '//depot/src/b.ts - file(s) not opened' },
    ])
    // 1 batch revert + 2 per-file retries.
    expect(revertCalls()).toHaveLength(3)
    client.dispose()
  })

  /** Spawn mock for the committed-change path: unshelve refuses with
   *  "already committed", where maps every depot file under ROOT, print emits
   *  `printContent`, everything else (edit/opened/changes) exits 0. */
  function mockCommittedP4(printContent: string): void {
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
        if (cmd === 'unshelve') {
          child.stderr.emit('data', Buffer.from('Change 900 is already committed.\n'))
          child.emit('close', 1)
          return
        }
        if (cmd === 'where') {
          const files = argv.slice(argv.indexOf('where') + 1).filter((a) => !a.startsWith('-'))
          const lines =
            files
              .map((f) =>
                JSON.stringify({ depotFile: f, path: `${ROOT}/${f.slice('//depot/'.length)}` }),
              )
              .join('\n') + '\n'
          child.stdout.emit('data', Buffer.from(lines))
          child.emit('close', 0)
          return
        }
        if (cmd === 'print') {
          child.stdout.emit('data', Buffer.from(printContent))
          child.emit('close', 0)
          return
        }
        child.emit('close', 0)
      })
      return child
    })
  }

  it('force-applies a committed change via print (edit + write) when unshelve is refused', async () => {
    mockCommittedP4('committed content\n')

    const client = await createClient()
    const files = ['//depot/src/a.ts', '//depot/src/b.ts']
    const result = await client.unshelveFiles('900', files)

    expect(result).toEqual({ applied: files, skipped: [], keptOpen: [] })
    // Opened for edit in the default changelist, then content written from
    // `p4 print <depot>@=<change>`; no revert -k on this path.
    expect(editCalls()).toHaveLength(1)
    expect(editCalls()[0]!.slice(-files.length)).toEqual(files)
    expect(revertCalls()).toHaveLength(0)
    expect(writeFileMock).toHaveBeenCalledTimes(2)
    expect(writeFileMock).toHaveBeenCalledWith(
      `${ROOT}/src/a.ts`,
      Buffer.from('committed content\n'),
    )
    expect(writeFileMock).toHaveBeenCalledWith(
      `${ROOT}/src/b.ts`,
      Buffer.from('committed content\n'),
    )
    expect(chmodMock).not.toHaveBeenCalled()
    expect(
      spawnMock.mock.calls.some((call) => subcommand((call[1] as string[]) ?? []) === 'opened'),
    ).toBe(true)
    client.dispose()
  })

  it('print fallback with intoChangelist false writes files without opening them', async () => {
    mockCommittedP4('committed content\n')

    const client = await createClient()
    const files = ['//depot/src/a.ts']
    const result = await client.unshelveFiles('900', files, { intoChangelist: false })

    expect(result).toEqual({ applied: files, skipped: [], keptOpen: [] })
    expect(editCalls()).toHaveLength(0)
    expect(writeFileMock).toHaveBeenCalledWith(
      `${ROOT}/src/a.ts`,
      Buffer.from('committed content\n'),
    )
    client.dispose()
  })

  it('reports skipped for files whose committed print fails', async () => {
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
        if (cmd === 'unshelve') {
          child.stderr.emit('data', Buffer.from('Change 900 is already committed.\n'))
          child.emit('close', 1)
          return
        }
        if (cmd === 'where') {
          child.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({ depotFile: '//depot/src/a.ts', path: `${ROOT}/src/a.ts` }) + '\n',
            ),
          )
          child.emit('close', 0)
          return
        }
        if (cmd === 'print') {
          child.stderr.emit('data', Buffer.from('//depot/src/a.ts@=900 - no such file(s).\n'))
          child.emit('close', 1)
          return
        }
        child.emit('close', 0)
      })
      return child
    })

    const client = await createClient()
    const result = await client.unshelveFiles('900', ['//depot/src/a.ts'])

    expect(result.applied).toEqual([])
    expect(result.skipped).toEqual([
      { depotFile: '//depot/src/a.ts', reason: '//depot/src/a.ts@=900 - no such file(s).' },
    ])
    expect(writeFileMock).not.toHaveBeenCalled()
    client.dispose()
  })
})
