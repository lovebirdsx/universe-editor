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

const writeFileMock = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined)
const chmodMock = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined)
const mkdirMock = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined)
const unlinkMock = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined)
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
  chmod: (...args: unknown[]) => chmodMock(...args),
  mkdir: (...args: unknown[]) => mkdirMock(...args),
  unlink: (...args: unknown[]) => unlinkMock(...args),
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
const DISCOVERY_SPEC = clientSpecReply(ROOT)

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
    mkdirMock.mockClear()
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  it('reports every file applied when the batch unshelve succeeds, then refreshes', async () => {
    spawnMock.mockImplementation((...args: unknown[]) => {
      const argv = (args[1] as string[]) ?? []
      const child = new FakeChildProcess()
      queueMicrotask(() => {
        if (isClientSpecProbe(argv)) {
          child.stdout.emit('data', Buffer.from(DISCOVERY_SPEC))
        } else if (subcommand(argv) === 'info') {
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
        if (isClientSpecProbe(argv)) {
          child.stdout.emit('data', Buffer.from(DISCOVERY_SPEC))
        } else if (cmd === 'info') {
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
        if (isClientSpecProbe(argv)) {
          child.stdout.emit('data', Buffer.from(DISCOVERY_SPEC))
        } else if (subcommand(argv) === 'info') {
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
        if (isClientSpecProbe(argv)) {
          child.stdout.emit('data', Buffer.from(DISCOVERY_SPEC))
        } else if (cmd === 'info') {
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
        if (isClientSpecProbe(argv)) {
          child.stdout.emit('data', Buffer.from(DISCOVERY_SPEC))
        } else if (subcommand(argv) === 'info') {
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
        if (isClientSpecProbe(argv)) {
          child.stdout.emit('data', Buffer.from(DISCOVERY_SPEC))
        } else if (cmd === 'info') {
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
        if (isClientSpecProbe(argv)) {
          child.stdout.emit('data', Buffer.from(DISCOVERY_SPEC))
        } else if (cmd === 'info') {
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
        if (isClientSpecProbe(argv)) {
          child.stdout.emit('data', Buffer.from(DISCOVERY_SPEC))
        } else if (cmd === 'info') {
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

const REVIEW_STREAM = '//depot/streams/review'
const CLIENT_STREAM = '//depot/streams/dev'
const CROSS_SOURCE = '//depot/streams/review/src/a.ts'
const CROSS_TARGET = '//depot/streams/dev/src/a.ts'

interface CrossStreamP4Options {
  /** `null` renders a classic client (no Stream field). */
  clientStream?: string | null
  /** Locals for `p4 where`; absent entries are reported as unmapped. */
  localByDepot?: Record<string, string>
  /** Failure stderr for the whole `-S` batch (committed / unsupported / ...). */
  streamFailure?: string
  /** Failure stderr for a multi-file `-S` batch classified as `other`. */
  batchFailure?: string
  /** Failure stderr for a single-file `-S` retry. */
  perFileFailure?: (file: string) => string | undefined
  printFailure?: (spec: string) => string | undefined
  editFailure?: string
  addFailure?: boolean
  printContent?: string
}

/** Fake p4 for the cross-stream pipeline: `client -o` exposes a stream, `where`
 *  answers from `localByDepot`, and the `-S` unshelve / print / edit / add
 *  outcomes are configurable per test. */
function mockCrossStreamP4(opts: CrossStreamP4Options = {}): void {
  const {
    clientStream = CLIENT_STREAM,
    localByDepot = {},
    streamFailure,
    batchFailure,
    perFileFailure,
    printFailure,
    editFailure,
    addFailure,
    printContent = 'review content\n',
  } = opts
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[1] as string[]) ?? []
    const child = new FakeChildProcess()
    queueMicrotask(() => {
      const cmd = subcommand(argv)
      if (cmd === 'client') {
        // Discovery's Root probe and _resolveClientStream ask the same command —
        // one spec must answer both.
        const lines = [
          `... Root ${ROOT}`,
          '... Options noallwrite noclobber nocompress unlocked nomodtime rmdir',
        ]
        if (clientStream !== null) lines.push(`... Stream ${clientStream}`)
        child.stdout.emit('data', Buffer.from(`${lines.join('\n')}\n\n`))
        child.emit('close', 0)
        return
      }
      if (cmd === 'info') {
        child.stdout.emit(
          'data',
          Buffer.from(`... clientName testclient\n... clientRoot ${ROOT}\n... userName bob\n\n`),
        )
        child.emit('close', 0)
        return
      }
      if (cmd === 'where') {
        const files = argv.slice(argv.indexOf('where') + 1).filter((a) => !a.startsWith('-'))
        let out = ''
        for (const file of files) {
          const local = localByDepot[file]
          if (local !== undefined) {
            out += `${JSON.stringify({ depotFile: file, path: local })}\n`
          }
        }
        child.stdout.emit('data', Buffer.from(out))
        child.emit('close', 0)
        return
      }
      if (cmd === 'unshelve') {
        const files = unshelveFileArgs(argv)
        if (argv.includes('-S')) {
          if (streamFailure !== undefined) {
            child.stderr.emit('data', Buffer.from(streamFailure))
            child.emit('close', 1)
            return
          }
          if (files.length > 1 && batchFailure !== undefined) {
            child.stderr.emit('data', Buffer.from(batchFailure))
            child.emit('close', 1)
            return
          }
          const perFile = files.length === 1 ? perFileFailure?.(files[0]!) : undefined
          if (perFile !== undefined) {
            child.stderr.emit('data', Buffer.from(perFile))
            child.emit('close', 1)
            return
          }
        }
        child.emit('close', 0)
        return
      }
      if (cmd === 'print') {
        const spec = argv[argv.length - 1] ?? ''
        const failure = printFailure?.(spec)
        if (failure !== undefined) {
          child.stderr.emit('data', Buffer.from(failure))
          child.emit('close', 1)
          return
        }
        child.stdout.emit('data', Buffer.from(printContent))
        child.emit('close', 0)
        return
      }
      if (cmd === 'edit') {
        if (editFailure !== undefined) {
          child.stderr.emit('data', Buffer.from(editFailure))
          child.emit('close', 1)
          return
        }
        child.emit('close', 0)
        return
      }
      if (cmd === 'add') {
        if (addFailure) {
          child.stderr.emit('data', Buffer.from('add refused\n'))
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
}

function unshelveFileArgs(argv: string[]): string[] {
  const out: string[] = []
  for (let i = argv.indexOf('unshelve') + 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '-s' || arg === '-S' || arg === '-P' || arg === '-c') {
      i++
      continue
    }
    if (arg.startsWith('-')) continue
    out.push(arg)
  }
  return out
}

function crossUnshelveCalls(): string[][] {
  return unshelveCalls().filter((argv) => argv.includes('-S'))
}

function printCalls(): string[][] {
  return spawnMock.mock.calls
    .map((call) => (call[1] as string[]) ?? [])
    .filter((argv) => subcommand(argv) === 'print')
}

describe('PerforceClient force cross-stream apply', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
    writeFileMock.mockReset().mockResolvedValue(undefined)
    chmodMock.mockReset().mockResolvedValue(undefined)
    mkdirMock.mockReset().mockResolvedValue(undefined)
    unlinkMock.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  it('maps an unmapped review file with native unshelve -S -P', async () => {
    mockCrossStreamP4({ localByDepot: { [CROSS_TARGET]: `${ROOT}/src/a.ts` } })

    const client = await createClient()
    const result = await client.unshelveFiles('900', [{ depotFile: CROSS_SOURCE, status: 'M' }], {
      force: true,
      stream: REVIEW_STREAM,
      intoChangelist: true,
    })

    expect(result).toEqual({ applied: [CROSS_SOURCE], skipped: [], keptOpen: [] })
    const calls = crossUnshelveCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.slice(calls[0]!.indexOf('unshelve'))).toEqual([
      'unshelve',
      '-s',
      '900',
      '-f',
      '-S',
      REVIEW_STREAM,
      '-P',
      CLIENT_STREAM,
      CROSS_SOURCE,
    ])
    expect(printCalls()).toHaveLength(0)
    expect(writeFileMock).not.toHaveBeenCalled()
    client.dispose()
  })

  it('falls back to print + edit + write when -S is unsupported', async () => {
    mockCrossStreamP4({
      localByDepot: { [CROSS_TARGET]: `${ROOT}/src/a.ts` },
      streamFailure: 'Unknown option: -S.\n',
    })

    const client = await createClient()
    const result = await client.unshelveFiles('900', [{ depotFile: CROSS_SOURCE, status: 'M' }], {
      force: true,
      stream: REVIEW_STREAM,
      intoChangelist: true,
    })

    expect(result).toEqual({ applied: [CROSS_SOURCE], skipped: [], keptOpen: [] })
    // Unsupported -S fails for every file: one batch attempt, no per-file retry.
    expect(crossUnshelveCalls()).toHaveLength(1)
    expect(printCalls()).toHaveLength(1)
    expect(editCalls()).toHaveLength(1)
    expect(editCalls()[0]![editCalls()[0]!.length - 1]).toBe(CROSS_TARGET)
    expect(writeFileMock).toHaveBeenCalledWith(`${ROOT}/src/a.ts`, Buffer.from('review content\n'))
    client.dispose()
  })

  it('print fallback with intoChangelist false never opens the target', async () => {
    mockCrossStreamP4({
      localByDepot: { [CROSS_TARGET]: `${ROOT}/src/a.ts` },
      streamFailure: 'Unknown option: -S.\n',
    })

    const client = await createClient()
    const result = await client.unshelveFiles('900', [{ depotFile: CROSS_SOURCE, status: 'M' }], {
      force: true,
      stream: REVIEW_STREAM,
      intoChangelist: false,
    })

    expect(result).toEqual({ applied: [CROSS_SOURCE], skipped: [], keptOpen: [] })
    expect(editCalls()).toHaveLength(0)
    expect(revertCalls()).toHaveLength(0)
    expect(writeFileMock).toHaveBeenCalledWith(`${ROOT}/src/a.ts`, Buffer.from('review content\n'))
    client.dispose()
  })

  it('treats an already committed change as a print fallback', async () => {
    mockCrossStreamP4({
      localByDepot: { [CROSS_TARGET]: `${ROOT}/src/a.ts` },
      streamFailure: 'Change 900 is already committed.\n',
    })

    const client = await createClient()
    const result = await client.unshelveFiles('900', [{ depotFile: CROSS_SOURCE, status: 'M' }], {
      force: true,
      stream: REVIEW_STREAM,
      intoChangelist: true,
    })

    expect(result.applied).toEqual([CROSS_SOURCE])
    expect(printCalls()).toHaveLength(1)
    expect(writeFileMock).toHaveBeenCalledTimes(1)
    client.dispose()
  })

  it('skips everything when the current client is not a stream client', async () => {
    mockCrossStreamP4({ clientStream: null })

    const client = await createClient()
    const result = await client.unshelveFiles('900', [{ depotFile: CROSS_SOURCE, status: 'M' }], {
      force: true,
      stream: REVIEW_STREAM,
      intoChangelist: true,
    })

    expect(result).toEqual({
      applied: [],
      skipped: [
        {
          depotFile: CROSS_SOURCE,
          reason: 'the current client is not a stream client; cross-stream apply is unavailable',
        },
      ],
      keptOpen: [],
    })
    expect(crossUnshelveCalls()).toHaveLength(0)
    client.dispose()
  })

  it('skips a path that is not under the review stream', async () => {
    mockCrossStreamP4({
      localByDepot: { '//depot/streams/dev/src/a.ts': `${ROOT}/src/a.ts` },
    })

    const client = await createClient()
    const result = await client.unshelveFiles(
      '900',
      [{ depotFile: '//depot/other/src/a.ts', status: 'M' }],
      { force: true, stream: REVIEW_STREAM, intoChangelist: true },
    )

    expect(result.applied).toEqual([])
    expect(result.skipped).toEqual([
      {
        depotFile: '//depot/other/src/a.ts',
        reason: `cannot map this path from ${REVIEW_STREAM} to ${CLIENT_STREAM}`,
      },
    ])
    client.dispose()
  })

  it('skips a mapped target that p4 where does not map', async () => {
    mockCrossStreamP4({ localByDepot: {} })

    const client = await createClient()
    const result = await client.unshelveFiles('900', [{ depotFile: CROSS_SOURCE, status: 'M' }], {
      force: true,
      stream: REVIEW_STREAM,
      intoChangelist: true,
    })

    expect(result.skipped).toEqual([
      {
        depotFile: CROSS_SOURCE,
        reason: `${CROSS_TARGET} is not mapped in the client view`,
      },
    ])
    expect(crossUnshelveCalls()).toHaveLength(0)
    client.dispose()
  })

  it('honours the workspaceRoot containment check and includeOutside', async () => {
    mockCrossStreamP4({
      localByDepot: { [CROSS_TARGET]: `${ROOT}/elsewhere/a.ts` },
      streamFailure: 'Unknown option: -S.\n',
    })

    const client = await createClient()
    const skipped = await client.unshelveFiles('900', [{ depotFile: CROSS_SOURCE, status: 'M' }], {
      force: true,
      stream: REVIEW_STREAM,
      intoChangelist: true,
      workspaceRoot: `${ROOT}/src`,
    })
    expect(skipped.applied).toEqual([])
    expect(skipped.skipped[0]?.reason).toContain('outside the workspace')

    const included = await client.unshelveFiles('901', [{ depotFile: CROSS_SOURCE, status: 'M' }], {
      force: true,
      stream: REVIEW_STREAM,
      intoChangelist: true,
      workspaceRoot: `${ROOT}/src`,
      includeOutside: true,
    })
    expect(included.applied).toEqual([CROSS_SOURCE])
    client.dispose()
  })

  it('applies a deleted file through native -S -P', async () => {
    mockCrossStreamP4({ localByDepot: { [CROSS_TARGET]: `${ROOT}/src/a.ts` } })

    const client = await createClient()
    const result = await client.unshelveFiles('900', [{ depotFile: CROSS_SOURCE, status: 'D' }], {
      force: true,
      stream: REVIEW_STREAM,
      intoChangelist: true,
    })

    expect(result).toEqual({ applied: [CROSS_SOURCE], skipped: [], keptOpen: [] })
    expect(crossUnshelveCalls()).toHaveLength(1)
    expect(printCalls()).toHaveLength(0)
    client.dispose()
  })

  it('skips a deleted file only when the print fallback has to run', async () => {
    mockCrossStreamP4({
      localByDepot: { [CROSS_TARGET]: `${ROOT}/src/a.ts` },
      streamFailure: 'Unknown option: -S.\n',
    })

    const client = await createClient()
    const result = await client.unshelveFiles('900', [{ depotFile: CROSS_SOURCE, status: 'D' }], {
      force: true,
      stream: REVIEW_STREAM,
      intoChangelist: true,
    })

    expect(result.applied).toEqual([])
    expect(result.skipped).toEqual([
      {
        depotFile: CROSS_SOURCE,
        reason: 'the cross-stream path fallback cannot apply deleted files',
      },
    ])
    expect(printCalls()).toHaveLength(0)
    client.dispose()
  })

  it('writes the content before p4 add when the fallback target rejects edit for an added file', async () => {
    mockCrossStreamP4({
      localByDepot: { [CROSS_TARGET]: `${ROOT}/src/new.ts` },
      streamFailure: 'Unknown option: -S.\n',
      editFailure: 'no such file\n',
    })

    const client = await createClient()
    const result = await client.unshelveFiles('900', [{ depotFile: CROSS_SOURCE, status: 'A' }], {
      force: true,
      stream: REVIEW_STREAM,
      intoChangelist: true,
    })

    expect(result.applied).toEqual([CROSS_SOURCE])
    expect(writeFileMock).toHaveBeenCalledTimes(1)
    // The new file can live in a directory this workspace never synced.
    expect(mkdirMock).toHaveBeenCalledWith(`${ROOT}/src`, { recursive: true })
    const adds = spawnMock.mock.calls
      .map((call) => (call[1] as string[]) ?? [])
      .filter((argv) => subcommand(argv) === 'add')
    expect(adds).toHaveLength(1)
    expect(adds[0]![adds[0]!.length - 1]).toBe(`${ROOT}/src/new.ts`)
    client.dispose()
  })

  it('treats a move/add as an added target in the fallback', async () => {
    mockCrossStreamP4({
      localByDepot: { [CROSS_TARGET]: `${ROOT}/src/moved.ts` },
      streamFailure: 'Unknown option: -S.\n',
      editFailure: 'no such file\n',
    })

    const client = await createClient()
    const result = await client.unshelveFiles('900', [{ depotFile: CROSS_SOURCE, status: 'R' }], {
      force: true,
      stream: REVIEW_STREAM,
      intoChangelist: true,
    })

    expect(result.applied).toEqual([CROSS_SOURCE])
    expect(writeFileMock).toHaveBeenCalledWith(
      `${ROOT}/src/moved.ts`,
      Buffer.from('review content\n'),
    )
    const adds = spawnMock.mock.calls
      .map((call) => (call[1] as string[]) ?? [])
      .filter((argv) => subcommand(argv) === 'add')
    expect(adds).toHaveLength(1)
    client.dispose()
  })

  it('reverts the freshly added target and skips when p4 add fails', async () => {
    mockCrossStreamP4({
      localByDepot: { [CROSS_TARGET]: `${ROOT}/src/new.ts` },
      streamFailure: 'Unknown option: -S.\n',
      editFailure: 'no such file\n',
      addFailure: true,
    })

    const client = await createClient()
    const result = await client.unshelveFiles('900', [{ depotFile: CROSS_SOURCE, status: 'A' }], {
      force: true,
      stream: REVIEW_STREAM,
      intoChangelist: true,
    })

    expect(result.applied).toEqual([])
    expect(result.skipped).toEqual([{ depotFile: CROSS_SOURCE, reason: 'add refused' }])
    expect(unlinkMock).toHaveBeenCalledWith(`${ROOT}/src/new.ts`)
    // _openCrossStreamTarget cleans up itself; _applyPrintFallback only
    // reverts -k after a write failure, which this path never reaches.
    expect(revertCalls()).toHaveLength(0)
    client.dispose()
  })

  it('applies mapped and cross-stream files in one call', async () => {
    const mapped = '//depot/streams/dev/src/m.ts'
    mockCrossStreamP4({
      localByDepot: {
        [mapped]: `${ROOT}/src/m.ts`,
        [CROSS_TARGET]: `${ROOT}/src/a.ts`,
      },
    })

    const client = await createClient()
    const result = await client.unshelveFiles(
      '900',
      [
        { depotFile: mapped, status: 'M' },
        { depotFile: CROSS_SOURCE, status: 'M' },
      ],
      { force: true, stream: REVIEW_STREAM, intoChangelist: true },
    )

    expect(result.applied).toEqual([mapped, CROSS_SOURCE])
    expect(unshelveCalls()).toHaveLength(2)
    // The mapped file stays on the classic batch (no -S/-P).
    const classic = unshelveCalls().filter((argv) => !argv.includes('-S'))
    expect(unshelveFileArgs(classic[0]!)).toEqual([mapped])
    client.dispose()
  })

  it('retries per file after an unclassified batch failure, then falls back', async () => {
    const otherSource = '//depot/streams/review/src/b.ts'
    mockCrossStreamP4({
      localByDepot: {
        [CROSS_TARGET]: `${ROOT}/src/a.ts`,
        '//depot/streams/dev/src/b.ts': `${ROOT}/src/b.ts`,
      },
      batchFailure: 'Some transient failure\n',
      perFileFailure: (file) => (file === otherSource ? 'still failing\n' : undefined),
    })

    const client = await createClient()
    const result = await client.unshelveFiles(
      '900',
      [
        { depotFile: CROSS_SOURCE, status: 'M' },
        { depotFile: otherSource, status: 'M' },
      ],
      { force: true, stream: REVIEW_STREAM, intoChangelist: true },
    )

    expect(result.applied).toEqual([CROSS_SOURCE, otherSource])
    // 1 batch + 2 per-file retries.
    expect(crossUnshelveCalls()).toHaveLength(3)
    expect(printCalls()).toHaveLength(1)
    expect(editCalls()).toHaveLength(1)
    expect(writeFileMock).toHaveBeenCalledTimes(1)
    client.dispose()
  })

  it('retries per file when the stream relationship is refused, then falls back per file', async () => {
    const otherSource = '//depot/streams/review/src/b.ts'
    mockCrossStreamP4({
      localByDepot: {
        [CROSS_TARGET]: `${ROOT}/src/a.ts`,
        '//depot/streams/dev/src/b.ts': `${ROOT}/src/b.ts`,
      },
      // A partial batch can report an unmapped file while the other file was
      // restored; retrying individually keeps the successful half native.
      batchFailure: 'src/b.ts - file(s) not in client view.\n',
      perFileFailure: (file) => (file === otherSource ? 'still not in client view\n' : undefined),
    })

    const client = await createClient()
    const result = await client.unshelveFiles(
      '900',
      [
        { depotFile: CROSS_SOURCE, status: 'M' },
        { depotFile: otherSource, status: 'M' },
      ],
      { force: true, stream: REVIEW_STREAM, intoChangelist: true },
    )

    expect(result.applied).toEqual([CROSS_SOURCE, otherSource])
    expect(crossUnshelveCalls()).toHaveLength(3)
    expect(printCalls()).toHaveLength(1)
    client.dispose()
  })

  it('does not revert a target that was already open when the overwrite fails', async () => {
    mockCrossStreamP4({
      localByDepot: { [CROSS_TARGET]: `${ROOT}/src/a.ts` },
      streamFailure: 'Unknown option: -S.\n',
      editFailure: 'already opened\n',
    })
    writeFileMock.mockRejectedValue(new Error('disk full'))
    chmodMock.mockRejectedValue(new Error('disk full'))

    const client = await createClient()
    const result = await client.unshelveFiles('900', [{ depotFile: CROSS_SOURCE, status: 'M' }], {
      force: true,
      stream: REVIEW_STREAM,
      intoChangelist: true,
    })

    expect(result.applied).toEqual([])
    expect(result.skipped).toEqual([{ depotFile: CROSS_SOURCE, reason: 'disk full' }])
    // The user's own changelist entry must survive our failed overwrite.
    expect(revertCalls()).toHaveLength(0)
    client.dispose()
  })

  it('reverts the target it opened when the overwrite fails', async () => {
    mockCrossStreamP4({
      localByDepot: { [CROSS_TARGET]: `${ROOT}/src/a.ts` },
      streamFailure: 'Unknown option: -S.\n',
    })
    writeFileMock.mockRejectedValue(new Error('disk full'))
    chmodMock.mockRejectedValue(new Error('disk full'))

    const client = await createClient()
    const result = await client.unshelveFiles('900', [{ depotFile: CROSS_SOURCE, status: 'M' }], {
      force: true,
      stream: REVIEW_STREAM,
      intoChangelist: true,
    })

    expect(result.applied).toEqual([])
    expect(result.skipped).toEqual([{ depotFile: CROSS_SOURCE, reason: 'disk full' }])
    expect(revertCalls()).toHaveLength(1)
    expect(revertCalls()[0]![revertCalls()[0]!.length - 1]).toBe(CROSS_TARGET)
    client.dispose()
  })
})
