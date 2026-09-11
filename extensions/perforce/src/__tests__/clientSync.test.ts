/**
 * `PerforceClient.sync` / `previewSync` semantics: the summary a get reports back,
 * the argv it builds (scope, revision spec, `-f`), and the failure classification
 * a caller turns into guidance. Sync deliberately does NOT go through `_mutate`
 * (that returns a bare boolean), so the skeleton it replicates — cancellable,
 * refresh either way, cache cleared on success — is pinned here.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileSystemWatcher } from '@universe-editor/extension-api'
import type { PerforceClientOptions, P4CacheOptions } from '../client.js'
type PerforceClientInstance = import('../client.js').PerforceClient

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = { end: vi.fn() }
  pid: number | undefined = 4242
  kill(): boolean {
    return true
  }
}

const spawnMock = vi.fn<(...args: unknown[]) => FakeChildProcess>()
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

/** The sync I/O sampler, faked: the real one spawns a platform process (WMI
 *  poller / `/proc` reader), which a unit test has no business doing. The fake
 *  hands the test the callbacks so samples, failures and disposal are driven
 *  deterministically — the wiring under test is the client's, not the sampler's. */
interface FakeIoProbe {
  readonly pid: number
  readonly dispose: ReturnType<typeof vi.fn>
  readonly sample: (read: number, write: number) => void
  readonly fail: (reason: string, kind: 'missing' | 'transient') => void
}
const ioMock = vi.hoisted(() => ({ probes: [] as unknown[], available: true }))

vi.mock('../processIo.js', () => ({
  createP4IoProbe: (pid: number, options: Record<string, unknown>) => {
    if (!ioMock.available) return undefined
    const probe: FakeIoProbe = {
      pid,
      dispose: vi.fn(),
      sample: (read, write) => (options.onSample as (s: unknown) => void)({ read, write }),
      fail: (reason, kind) =>
        (options.onUnavailable as (r: string, k: string) => void)(reason, kind),
    }
    ioMock.probes.push(probe)
    return probe
  },
}))

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
const { P4Service } = await import('../p4Service.js')

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const ROOT_FWD = process.platform === 'win32' ? 'C:/ws' : '/ws'
const LOCAL = `${ROOT_FWD}/a.cpp`

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

/** Spawns whose close is held back for the test to settle (see `finishHeld`). */
const heldChildren: FakeChildProcess[] = []

function respond(
  handler: (argv: string[]) => Reply,
  hold: (argv: string[]) => boolean = () => false,
): void {
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[1] as string[]) ?? []
    spawned.push(argv)
    const child = new FakeChildProcess()
    if (hold(argv)) {
      heldChildren.push(child)
      return child
    }
    queueMicrotask(() => {
      const reply = handler(argv)
      if (reply.stdout) child.stdout.emit('data', Buffer.from(reply.stdout))
      if (reply.stderr) child.stderr.emit('data', Buffer.from(reply.stderr))
      child.emit('close', reply.exit ?? 0)
    })
    return child
  })
}

/** Emit output on the oldest held spawn and close it, settling its caller. */
function finishHeld(reply: Reply = { stdout: '', exit: 0 }): void {
  const child = heldChildren.shift()
  expect(child).toBeDefined()
  if (reply.stdout) child!.stdout.emit('data', Buffer.from(reply.stdout))
  if (reply.stderr) child!.stderr.emit('data', Buffer.from(reply.stderr))
  child!.emit('close', reply.exit ?? 0)
}

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1000
  return { now: () => t, advance: (ms) => (t += ms) }
}

/** `sync` reaches `spawn` through the concurrency gate, so the child (and with it
 *  the sampler) exists a few microtasks later; two macrotask ticks settle it. */
const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

/** A controllable `FileSystemWatcher` fake: its three events can be fired by the
 *  test with a filesystem path, mirroring git's `repositoryWatcher.test.ts`. */
interface FakeWatcherController {
  readonly watcher: FileSystemWatcher
  readonly dispose: ReturnType<typeof vi.fn>
  fire(kind: 'create' | 'change' | 'delete', path: string): void
}

function makeFakeWatcher(): FakeWatcherController {
  const listeners = {
    create: new Set<(uri: { fsPath: string }) => void>(),
    change: new Set<(uri: { fsPath: string }) => void>(),
    delete: new Set<(uri: { fsPath: string }) => void>(),
  }
  const dispose = vi.fn()
  const watcher = {
    ignoreCreateEvents: false,
    ignoreChangeEvents: false,
    ignoreDeleteEvents: false,
    onDidCreate: (fn: (uri: { fsPath: string }) => void) => {
      listeners.create.add(fn)
      return { dispose: () => listeners.create.delete(fn) }
    },
    onDidChange: (fn: (uri: { fsPath: string }) => void) => {
      listeners.change.add(fn)
      return { dispose: () => listeners.change.delete(fn) }
    },
    onDidDelete: (fn: (uri: { fsPath: string }) => void) => {
      listeners.delete.add(fn)
      return { dispose: () => listeners.delete.delete(fn) }
    },
    dispose,
  }
  return {
    watcher: watcher as unknown as FileSystemWatcher,
    dispose,
    fire(kind, path) {
      for (const fn of [...listeners[kind]]) fn({ fsPath: path })
    },
  }
}

const DISCOVERY = `... clientName testclient\n... clientRoot ${ROOT}\n... userName testuser\n\n`

/** Discovery + empty refresh reads; sync/`sync -n` come from the per-test handler. */
function makeHandler(syncReply: (argv: string[]) => Reply): (argv: string[]) => Reply {
  return (argv) => {
    const cmd = subcommand(argv)
    if (cmd === 'info') return { stdout: DISCOVERY }
    if (cmd === 'sync') return syncReply(argv)
    return { stdout: '' }
  }
}

async function makeClient(
  syncReply: (argv: string[]) => Reply = () => ({ stdout: '' }),
  options: PerforceClientOptions = {},
  cacheOptions: Partial<P4CacheOptions> = {},
  holdSync = false,
): Promise<PerforceClientInstance> {
  respond(
    makeHandler(syncReply),
    holdSync ? (argv) => subcommand(argv) === 'sync' && !argv.includes('-n') : undefined,
  )
  const client = await PerforceClient.create(
    ROOT,
    {},
    new ConcurrencyGate(4),
    { enabled: true, workspaceTtlMs: 4000, ...cacheOptions },
    options,
  )
  expect(client).toBeDefined()
  return client!
}

/** The argv of the last real `p4 sync` (not the `-n` dry run), with the global
 *  connection options (`-u`/`-c`/…) stripped so assertions read as the command. */
function lastSyncArgv(): string[] | undefined {
  const argv = spawned.filter((a) => subcommand(a) === 'sync' && !a.includes('-n')).at(-1)
  if (!argv) return undefined
  return argv.slice(argv.indexOf('sync'))
}

/** Whether a refresh ran after the real `p4 sync` — the observable difference
 *  between the up-to-date early return (nothing landed, so nothing to refresh)
 *  and a run that changed something. */
function refreshedAfterSync(): boolean {
  const at = spawned.findIndex((a) => subcommand(a) === 'sync' && !a.includes('-n'))
  if (at < 0) return false
  return spawned.slice(at + 1).some((a) => subcommand(a) === 'opened')
}

beforeEach(() => {
  installBridge()
  spawnMock.mockReset()
  spawned.length = 0
  heldChildren.length = 0
  ioMock.probes.length = 0
  ioMock.available = true
  vi.clearAllMocks()
  mocks.executeCommand.mockResolvedValue(undefined)
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
})

describe('PerforceClient.sync', () => {
  it('reports the per-outcome counts from a mixed run', async () => {
    const client = await makeClient(() => ({
      stdout: [
        `//depot/branch_x/a.cpp#3 - updated as ${ROOT_FWD}/a.cpp`,
        `//depot/branch_x/b.h#7 - added as ${ROOT_FWD}/b.h`,
        "//depot/branch_x/e.ini - is opened and can't be replaced.",
        '//depot/branch_x/f.cpp - must resolve #4 before submitting',
      ].join('\n'),
    }))

    const res = await client.sync('#head')

    expect(res.ok).toBe(true)
    expect(res.cancelled).toBe(false)
    expect(res.summary).toMatchObject({
      applied: 2,
      keptOpen: 1,
      mustResolve: 1,
      unrecognized: false,
    })
  })

  it('appends the revision spec to the configured scope', async () => {
    const client = await makeClient(() => ({ stdout: '' }))
    client.setSyncScope([`${ROOT_FWD}/Content`])

    await client.sync('@12345')

    expect(lastSyncArgv()).toEqual(['sync', `${ROOT_FWD}/Content/...@12345`])
  })

  it('defaults to the whole client when no scope is set', async () => {
    const client = await makeClient(() => ({ stdout: '' }))

    await client.sync('#head')

    expect(lastSyncArgv()).toEqual(['sync', '//...#head'])
  })

  it('exposes the scope a scope-less get targets, so a clobber refusal can collect it', async () => {
    // The clobber guidance button must collect the range the refused get covered.
    // A scope-less get (the status-bar entry — the most common one) has no scope
    // argument to fall back on, so it reads this instead of degrading to a
    // discovery-only refresh that collects nothing.
    const client = await makeClient(() => ({ stdout: '' }))
    expect(client.syncScopes).toEqual(['//...'])

    client.setSyncScope([`${ROOT_FWD}/Content`])
    expect(client.syncScopes).toEqual([`${ROOT_FWD}/Content/...`])
  })

  it('passes -f only when forcing, before the filespecs', async () => {
    const client = await makeClient(() => ({ stdout: '' }))

    await client.syncFiles([LOCAL], '#head', { force: true })

    expect(lastSyncArgv()).toEqual(['sync', '-f', `${LOCAL}#head`])
  })

  it('serial sync (the default) carries no --parallel flag', async () => {
    const client = await makeClient(() => ({ stdout: '' }))

    await client.sync('#head')

    expect(lastSyncArgv()).toEqual(['sync', '//...#head'])
  })

  it('threads > 0 prepends --parallel=threads=N', async () => {
    const client = await makeClient(() => ({ stdout: '' }))
    client.setSyncParallelThreads(4)

    await client.sync('#head', { onProgress: () => {} })

    expect(lastSyncArgv()).toEqual(['sync', '--parallel=threads=4', '//...#head'])
  })

  it('a 0 thread count syncs serially even after being set', async () => {
    const client = await makeClient(() => ({ stdout: '' }))
    client.setSyncParallelThreads(4)
    client.setSyncParallelThreads(0)

    await client.sync('#head')

    expect(lastSyncArgv()).toEqual(['sync', '//...#head'])
  })

  it('classifies a clobber refusal so the caller can offer to collect first', async () => {
    const client = await makeClient(() => ({
      stderr: `${LOCAL} - can't clobber writable file ${LOCAL}`,
      exit: 1,
    }))

    const res = await client.sync('#head')

    expect(res.ok).toBe(false)
    expect(res.error?.kind).toBe('clobber')
    // The guidance must state the cost — a user coming from P4V fears exactly this.
    expect(res.error?.suggestion).toBeTruthy()
  })

  it('treats an up-to-date report as success with nothing to do', async () => {
    // Measured on P4D 2024.2: exit **0**, notice on stderr, empty stdout.
    const client = await makeClient(() => ({
      stderr: `${ROOT_FWD}/... - file(s) up-to-date.`,
      exit: 0,
    }))

    const res = await client.sync('#head')

    expect(res.ok).toBe(true)
    expect(res.error).toBeUndefined()
    expect(res.summary?.upToDate).toBe(true)
    expect(res.summary?.applied).toBe(0)
    // Nothing landed, so nothing about the caches or the view can be stale —
    // "already current" must not read as a mixed run either.
    expect(res.summary?.unrecognized).toBe(false)
  })

  it('still reads a non-zero up-to-date variant as success', async () => {
    // Older servers reported this with a non-zero exit; the outcome must not
    // depend on which variant a given server picks.
    const client = await makeClient(() => ({
      stderr: `${ROOT_FWD}/... - file(s) up-to-date.`,
      exit: 1,
    }))

    const res = await client.sync('#head')

    expect(res.ok).toBe(true)
    expect(res.error).toBeUndefined()
    expect(res.summary?.upToDate).toBe(true)
  })

  it('reports a partial run even when p4 also says some paths are up to date', async () => {
    // A scoped sync commonly mixes both: some files landed, others were already
    // current. The up-to-date notice must not short-circuit the applied count.
    const client = await makeClient(() => ({
      stdout: `//depot/branch_x/a.cpp#3 - updated as ${ROOT_FWD}/a.cpp`,
      stderr: `${ROOT_FWD}/other/... - file(s) up-to-date.`,
    }))

    const res = await client.sync('#head')

    expect(res.ok).toBe(true)
    expect(res.summary?.applied).toBe(1)
  })

  it('never goes silent when exit 0 carries output it could not account for', async () => {
    const log = vi.fn<(msg: string) => void>()
    respond(makeHandler(() => ({ stdout: 'something entirely unexpected\n' })))
    const client = await PerforceClient.create(
      ROOT,
      {},
      new ConcurrencyGate(4),
      { enabled: true, workspaceTtlMs: 4000 },
      { log },
    )
    expect(client).toBeDefined()

    const res = await client!.sync('#head')

    expect(res.ok).toBe(true)
    expect(res.summary?.unrecognized).toBe(true)
    // Reporting "0 updated" for output we didn't understand would read as
    // "nothing happened" — the log is what makes that diagnosable.
    expect(log.mock.calls.flat().join('\n')).toContain('not parseable')
  })

  // An `allwrite noclobber` client (measured on P4D 2024.2) refuses each
  // locally-modified file on **stdout with exit 0** and walks on. Unparsed, the
  // run reported all-zero counts and the caller told the user the file was
  // already at the latest revision while it sat several revisions behind.
  it('counts a locally-modified refusal instead of reporting nothing to do', async () => {
    const log = vi.fn<(msg: string) => void>()
    respond(
      makeHandler(() => ({
        stdout: `//depot/branch_x/a.json#69 - can't update modified file ${LOCAL}\n`,
        exit: 0,
      })),
    )
    const client = await PerforceClient.create(
      ROOT,
      {},
      new ConcurrencyGate(4),
      { enabled: true, workspaceTtlMs: 4000 },
      { log },
    )
    expect(client).toBeDefined()

    const res = await client!.sync('#head')

    expect(res.ok).toBe(true)
    expect(res.error).toBeUndefined()
    expect(res.summary?.refusedModified).toBe(1)
    expect(res.summary?.applied).toBe(0)
    // Recognized now, so it must not be filed under "we don't know what happened".
    expect(res.summary?.unrecognized).toBe(false)
    expect(res.summary?.upToDate).toBe(false)
    expect(log.mock.calls.flat().join('\n')).not.toContain('not parseable')
  })

  // Measured on P4D 2024.2 under `--parallel` on an `allwrite noclobber` client:
  // the same stdout/exit-0 refusal channel carries a DIFFERENT wording when the
  // file in the way is untracked (no have-table record). Counted into its own
  // bucket so the caller offers a force get, never "Collect Changes" (there is
  // no local modification to collect or diff — the orphan just sits at the path).
  it('counts an untracked-orphan refusal separately, not as nothing to do', async () => {
    const log = vi.fn<(msg: string) => void>()
    respond(
      makeHandler(() => ({
        stdout: `//depot/branch_x/b.uasset#1 - can't overwrite existing file ${ROOT_FWD}/b.uasset\n`,
        exit: 0,
      })),
    )
    const client = await PerforceClient.create(
      ROOT,
      {},
      new ConcurrencyGate(4),
      { enabled: true, workspaceTtlMs: 4000 },
      { log },
    )
    expect(client).toBeDefined()

    const res = await client!.sync('#head')

    expect(res.ok).toBe(true)
    expect(res.summary?.refusedOverwrite).toBe(1)
    expect(res.summary?.refusedModified).toBe(0)
    expect(res.summary?.applied).toBe(0)
    // Recognized now, so it must not fall into "we don't know what happened".
    expect(res.summary?.unrecognized).toBe(false)
    expect(res.summary?.upToDate).toBe(false)
    // An orphan-in-the-way must NOT be offered as a diff-able refusal — there is
    // no local modification, so it stays out of refusedFiles.
    expect(res.refusedFiles).toEqual([])
    // ...and lands in its own bucket instead, depot path + revision + local path
    // all carried out for the force-get picker.
    expect(res.refusedOverwriteFiles).toHaveLength(1)
    expect(res.refusedOverwriteFiles[0]).toMatchObject({
      depotFile: '//depot/branch_x/b.uasset',
      rev: '1',
      action: 'not updated',
    })
    expect(log.mock.calls.flat().join('\n')).not.toContain('not parseable')
  })

  it('carries the refused paths out so the caller can offer to diff them', async () => {
    const client = await makeClient(() => ({
      stdout: `//depot/branch_x/a.json#69 - can't update modified file ${LOCAL}\n`,
    }))

    const res = await client.sync('#head')

    expect(res.refusedFiles).toHaveLength(1)
    expect(res.refusedFiles[0]).toMatchObject({
      depotFile: '//depot/branch_x/a.json',
      rev: '69',
      action: 'not updated',
    })
    expect(res.refusedFiles[0]!.clientFile?.replace(/\\/g, '/')).toBe(LOCAL)
    // A locally-modified refusal is NOT an orphan — the buckets stay separate.
    expect(res.refusedOverwriteFiles).toEqual([])
  })

  it('does not let an up-to-date notice bury a refusal in the same run', async () => {
    // A multi-filespec get can report one scope current while refusing files in
    // another. Answering "already at the latest revision" there would hide the
    // files the user actually has to act on.
    const client = await makeClient(() => ({
      stdout: `//depot/branch_x/a.json#69 - can't update modified file ${LOCAL}\n`,
      stderr: `${ROOT_FWD}/other/... - file(s) up-to-date.`,
    }))

    const res = await client.sync('#head')

    expect(res.ok).toBe(true)
    expect(res.summary?.refusedModified).toBe(1)
    expect(res.refusedFiles).toHaveLength(1)
    // THE guard on the early return itself: taking it would skip the refresh.
    // Without this, dropping `refusedModified === 0` from the early-return
    // condition still passes every assertion above.
    expect(refreshedAfterSync()).toBe(true)
  })

  it('reports cancellation without an error and still refreshes', async () => {
    const client = await makeClient((argv) => {
      // Abort while the sync is in flight; the service resolves a failure result
      // whose stderr says it was cancelled.
      if (!argv.includes('-n')) client.cancelBusy()
      return { stdout: '', stderr: 'was cancelled', exit: 1 }
    })

    const res = await client.sync('#head')

    expect(res.cancelled).toBe(true)
    expect(res.ok).toBe(false)
    expect(res.error).toBeUndefined()
  })

  it('is a no-op for an empty file list', async () => {
    const client = await makeClient()

    const res = await client.syncFiles([])

    expect(res.ok).toBe(false)
    expect(lastSyncArgv()).toBeUndefined()
  })
})

describe('PerforceClient.previewSync', () => {
  it('parses the tagged records a real server reports', async () => {
    // Verbatim shape from P4D 2024.2 (`e2e/fixtures/PROBE-FINDINGS.md`): sync's
    // `clientFile` is already a local path, unlike `opened` / `reconcile -n`.
    const client = await makeClient((argv) => {
      if (!argv.includes('-n')) return { stdout: '' }
      return {
        stdout: [
          '... depotFile //depot/branch_x/a.cpp',
          `... clientFile ${LOCAL.replace(/\//g, '\\')}`,
          '... rev 3',
          '... action updated',
          '... totalFileSize 852354218',
          '... totalFileCount 147',
          '... change 8605891',
          '',
        ].join('\n'),
      }
    })

    const res = await client.previewSync()

    expect(res.ok).toBe(true)
    expect(res.upToDate).toBe(false)
    expect(res.files).toHaveLength(1)
    expect(res.files[0]).toMatchObject({
      depotFile: '//depot/branch_x/a.cpp',
      action: 'updated',
      rev: '3',
    })
    // A local path must survive untouched — no `//` prefix invented, no
    // clientRoot re-rooting applied on top of an already-local value.
    expect(res.files[0]!.clientFile).not.toMatch(/^\/\//)
    expect(res.files[0]!.clientFile?.replace(/\\/g, '/')).toBe(LOCAL)
  })

  it('still translates client syntax if a server ever reports it', async () => {
    const client = await makeClient((argv) => {
      if (!argv.includes('-n')) return { stdout: '' }
      return {
        stdout: [
          '... depotFile //depot/branch_x/a.cpp',
          '... clientFile //testclient/a.cpp',
          '... rev 3',
          '... action updated',
          '',
        ].join('\n'),
      }
    })

    const res = await client.previewSync()

    expect(res.files[0]!.clientFile).not.toMatch(/^\/\//)
    expect(res.files[0]!.clientFile?.replace(/\\/g, '/')).toBe(LOCAL)
  })

  it('goes straight to -ztag instead of paying for a doomed -Mj probe', async () => {
    // Measured: `-Mj sync -n` collapses to `{"data":...}` blobs on this server
    // family in *both* outcomes, so an execRecords-style `-Mj`-first attempt is
    // a guaranteed-wasted spawn on every preview.
    const client = await makeClient(() => ({ stdout: '' }))

    await client.previewSync()

    const preview = spawned.filter((a) => subcommand(a) === 'sync')
    expect(preview.length).toBe(1)
    expect(preview[0]).toContain('-ztag')
    expect(preview[0]).not.toContain('-Mj')
  })

  it('runs as a dry run and never mutates', async () => {
    const client = await makeClient(() => ({ stdout: '' }))

    await client.previewSync()

    const preview = spawned.filter((a) => subcommand(a) === 'sync')
    expect(preview.length).toBeGreaterThan(0)
    for (const argv of preview) expect(argv).toContain('-n')
  })

  it('pushes the cap down to the server as -m instead of truncating locally', async () => {
    const client = await makeClient(() => ({ stdout: '' }))

    await client.previewSync(undefined, '#head', 500)

    const argv = spawned.filter((a) => subcommand(a) === 'sync').at(-1)!
    const at = argv.indexOf('-m')
    expect(at).toBeGreaterThan(-1)
    expect(argv[at + 1]).toBe('500')
  })

  it('reads an up-to-date report on stderr with exit 0 as nothing to do', async () => {
    // The measured shape: exit 0, empty stdout, the notice on stderr. Read as a
    // failure this would have surfaced an error toast on a healthy workspace.
    const client = await makeClient(() => ({
      stderr: `${ROOT_FWD}/... - file(s) up-to-date.`,
      exit: 0,
    }))

    const res = await client.previewSync()

    expect(res.ok).toBe(true)
    expect(res.upToDate).toBe(true)
    expect(res.files).toEqual([])
  })

  // A refused-modified file yields a plain line that `-ztag` drops entirely, so
  // a single-file preview came back with zero records and reported "up to date"
  // — the same false answer as the real get.
  it('folds a refused-modified line into the files instead of reporting up to date', async () => {
    const client = await makeClient((argv) => {
      if (!argv.includes('-n')) return { stdout: '' }
      return { stdout: `//depot/branch_x/a.json#69 - can't update modified file ${LOCAL}\n` }
    })

    const res = await client.previewSync([LOCAL])

    expect(res.ok).toBe(true)
    expect(res.upToDate).toBe(false)
    expect(res.files).toHaveLength(1)
    expect(res.files[0]).toMatchObject({
      depotFile: '//depot/branch_x/a.json',
      rev: '69',
      action: 'not updated',
    })
    expect(res.files[0]!.clientFile?.replace(/\\/g, '/')).toBe(LOCAL)
  })

  it('reports refusals even when another filespec is up to date', async () => {
    const client = await makeClient((argv) => {
      if (!argv.includes('-n')) return { stdout: '' }
      return {
        stdout: `//depot/branch_x/a.json#69 - can't update modified file ${LOCAL}\n`,
        stderr: `${ROOT_FWD}/other/... - file(s) up-to-date.`,
        exit: 0,
      }
    })

    const res = await client.previewSync()

    expect(res.upToDate).toBe(false)
    expect(res.files).toHaveLength(1)
  })

  it('keeps totalFileCount authoritative rather than adding refusals on top', async () => {
    // Measured: totalFileCount already counts the plain refusal lines, so the
    // grand total must not be inflated by folding them in a second time.
    const client = await makeClient((argv) => {
      if (!argv.includes('-n')) return { stdout: '' }
      return {
        stdout: [
          '... depotFile //depot/branch_x/a.cpp',
          `... clientFile ${LOCAL}`,
          '... rev 3',
          '... action updated',
          '... totalFileCount 2',
          '',
          `//depot/branch_x/b.json#69 - can't update modified file ${ROOT_FWD}/b.json`,
        ].join('\n'),
      }
    })

    const res = await client.previewSync()

    expect(res.total).toBe(2)
    expect(res.files).toHaveLength(2)
  })
})

describe('PerforceClient.sync onProgress', () => {
  it('fires once per recognized line with done and the depot file segment', async () => {
    const client = await makeClient(() => ({
      stdout: [
        `//depot/branch_x/a.cpp#3 - updated as ${ROOT_FWD}/a.cpp`,
        '//depot/branch_x/b.h#7 - is opened and not being changed',
        '//depot/branch_x/c.cpp#5 - must resolve #4 before submitting',
        `//depot/branch_x/d.json#69 - can't update modified file ${ROOT_FWD}/d.json`,
      ].join('\n'),
    }))

    const calls: { done: number; file: string | undefined }[] = []
    await client.sync('#head', { onProgress: (p) => calls.push(p) })

    expect(calls).toEqual([
      { done: 1, file: 'a.cpp' },
      { done: 2, file: 'b.h' },
      { done: 3, file: 'c.cpp' },
      { done: 4, file: 'd.json' },
    ])
  })

  it('does not count a line classifySyncLine cannot recognize', async () => {
    const client = await makeClient(() => ({
      stdout: [
        `//depot/branch_x/a.cpp#3 - updated as ${ROOT_FWD}/a.cpp`,
        'something entirely unexpected',
        '//depot/branch_x/b.h#7 - is opened and not being changed',
      ].join('\n'),
    }))

    const calls: { done: number; file: string | undefined }[] = []
    await client.sync('#head', { onProgress: (p) => calls.push(p) })

    expect(calls).toEqual([
      { done: 1, file: 'a.cpp' },
      { done: 2, file: 'b.h' },
    ])
  })

  it('passes onStdoutLine to the exec when onProgress is given', async () => {
    const client = await makeClient(() => ({ stdout: '' }))
    const spy = vi.spyOn(P4Service.prototype, 'exec')
    try {
      await client.sync('#head', { onProgress: () => {} })

      const call = spy.mock.calls.find(([args]) => Array.isArray(args) && args[0] === 'sync')
      expect(call).toBeDefined()
      const opts = call![1]
      expect(opts).toHaveProperty('onStdoutLine')
      expect(typeof opts?.onStdoutLine).toBe('function')
    } finally {
      spy.mockRestore()
    }
  })

  it('omits onStdoutLine from the exec when onProgress is not given', async () => {
    const client = await makeClient(() => ({ stdout: '' }))
    const spy = vi.spyOn(P4Service.prototype, 'exec')
    try {
      await client.sync('#head')

      const call = spy.mock.calls.find(([args]) => Array.isArray(args) && args[0] === 'sync')
      expect(call).toBeDefined()
      expect(call![1]).not.toHaveProperty('onStdoutLine')
      // The sampler rides the same path: a non-streaming sync publishes no
      // progress, so there is nothing for a sample to update.
      expect(call![1]).not.toHaveProperty('onSpawn')
      expect(ioMock.probes).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('PerforceClient sync I/O sampler', () => {
  const probes = (): {
    pid: number
    dispose: ReturnType<typeof vi.fn>
    sample: (r: number, w: number) => void
    fail: (reason: string, kind: 'missing' | 'transient') => void
  }[] => ioMock.probes as never

  it('samples the spawned p4 and accumulates its deltas on syncProgress', async () => {
    const client = await makeClient(() => ({ stdout: '' }), {}, {}, true)
    const run = client.sync('#head', { onProgress: () => {} })
    await flush()

    // Attached to the child that was actually spawned, before any output.
    expect(probes()).toHaveLength(1)
    expect(probes()[0]!.pid).toBe(4242)
    // Present from the first frame — with zero — so the bar switches to the rate
    // form during the silent server walk, not at the first transferred byte.
    expect(client.status.syncProgress?.ioReadBytes).toBe(0)

    probes()[0]!.sample(4096, 12)
    expect(client.status.syncProgress?.ioReadBytes).toBe(4096)
    expect(client.status.syncProgress?.ioWriteBytes).toBe(12)
    probes()[0]!.sample(1024, 0)
    expect(client.status.syncProgress?.ioReadBytes).toBe(5120)

    finishHeld()
    await run
  })

  it('keeps the DTO free of ioReadBytes when the platform has no sampler', async () => {
    ioMock.available = false
    const client = await makeClient(() => ({ stdout: '' }), {}, {}, true)
    const run = client.sync('#head', { onProgress: () => {} })
    await flush()

    expect(probes()).toHaveLength(0)
    // `undefined` (not 0) is what tells the bar to fall back to the watcher
    // count instead of freezing at a rate it can no longer update.
    expect(client.status.syncProgress).toBeDefined()
    expect(client.status.syncProgress?.ioReadBytes).toBeUndefined()
    expect(client.status.syncProgress?.ioWriteBytes).toBeUndefined()

    finishHeld()
    await run
  })

  it('releases the sampler when the sync ends', async () => {
    const client = await makeClient(() => ({ stdout: '' }), {}, {}, true)
    const run = client.sync('#head', { onProgress: () => {} })
    await flush()
    expect(probes()[0]!.dispose).not.toHaveBeenCalled()

    finishHeld()
    await run

    expect(probes()[0]!.dispose).toHaveBeenCalled()
    expect(client.status.syncProgress).toBeUndefined()
  })

  it('releases the sampler when the client is disposed mid-sync', async () => {
    const client = await makeClient(() => ({ stdout: '' }), {}, {}, true)
    const run = client.sync('#head', { onProgress: () => {} })
    await flush()

    client.dispose()
    expect(probes()[0]!.dispose).toHaveBeenCalled()
    finishHeld()
    await run
  })

  it('drops back to the watcher count for the run when a sampler stalls', async () => {
    const client = await makeClient(() => ({ stdout: '' }), {}, {}, true)
    const run = client.sync('#head', { onProgress: () => {} })
    await flush()
    probes()[0]!.sample(4096, 12)
    expect(client.status.syncProgress?.ioReadBytes).toBe(4096)

    // A frozen readout decays to a permanent 000KB/s — the false "stalled"
    // signal the rate exists to remove — so the field goes away instead.
    probes()[0]!.fail('no output for 15000ms', 'transient')
    expect(probes()[0]!.dispose).toHaveBeenCalled()
    expect(client.status.syncProgress?.ioReadBytes).toBeUndefined()

    finishHeld()
    await run

    // Transient means *this run*, not this machine: a stalled sampler (a busy
    // WMI provider, a transfer that went quiet) must not cost every later sync
    // in the session its rate readout.
    const second = client.sync('#head', { onProgress: () => {} })
    await flush()
    expect(probes()).toHaveLength(2)
    expect(client.status.syncProgress?.ioReadBytes).toBe(0)
    finishHeld()
    await second
  })

  it('latches the session off, and stops sampling, once the source is missing', async () => {
    const client = await makeClient(() => ({ stdout: '' }), {}, {}, true)
    const run = client.sync('#head', { onProgress: () => {} })
    await flush()
    probes()[0]!.sample(4096, 12)

    // Spawn failure / a sampler that never executed a line: nothing on this
    // machine can be sampled, so retrying would only pay for a doomed process.
    probes()[0]!.fail('EPERM', 'missing')
    expect(client.status.syncProgress?.ioReadBytes).toBeUndefined()

    finishHeld()
    await run

    const second = client.sync('#head', { onProgress: () => {} })
    await flush()
    expect(probes()).toHaveLength(1)
    expect(client.status.syncProgress?.ioReadBytes).toBeUndefined()
    finishHeld()
    await second
  })
})

describe('PerforceClient lastSyncSpec', () => {
  it('names the target from the first frame and keeps naming it after the run', async () => {
    const client = await makeClient(() => ({ stdout: '' }), {}, {}, true)
    expect(client.status.lastSyncSpec).toBeUndefined()
    expect(Object.hasOwn(client.status, 'lastSyncSpec')).toBe(false)

    const run = client.sync('@4521', { onProgress: () => {} })
    await flush()
    // Published before p4 has printed anything, so the bar can name the target
    // while the run is still in its silent server-side walk.
    expect(client.status.lastSyncSpec).toBe('@4521')

    finishHeld()
    await run

    // The run-scoped DTO is gone; the target is not — that is the whole point of
    // this field being client-level rather than a SyncProgress member.
    expect(client.status.syncProgress).toBeUndefined()
    expect(client.status.lastSyncSpec).toBe('@4521')
  })

  it('carries the empty spec of a per-file get instead of dropping it', async () => {
    // `''` means "each filespec has its own #rev" (the force get), so it is a
    // real target that happens to be falsy — a truthiness test anywhere on this
    // path would silently hide the most common get of all.
    const client = await makeClient(() => ({ stdout: '' }))
    await client.sync('', { scope: [`${ROOT_FWD}/a.cpp#3`] })

    expect(client.status.lastSyncSpec).toBe('')
    expect(Object.hasOwn(client.status, 'lastSyncSpec')).toBe(true)
  })

  it('lets the last started run win, and does not resurrect an older one', async () => {
    const client = await makeClient(() => ({ stdout: '' }), {}, {}, true)
    const first = client.sync('@1', { onProgress: () => {} })
    await flush()
    const second = client.sync('@2', { onProgress: () => {} })
    await flush()

    // Overlapping syncs share the run counters, so there is no single "the" run;
    // the label follows what the user asked for last.
    expect(client.status.lastSyncSpec).toBe('@2')

    // Settling the older run first must not put its spec back on the bar.
    finishHeld()
    await first
    expect(client.status.lastSyncSpec).toBe('@2')
    finishHeld()
    await second
    expect(client.status.lastSyncSpec).toBe('@2')
  })
})

describe('PerforceClient.sync live progress', () => {
  it('runs no `sync -n` dry run — the download starts immediately', async () => {
    // A pre-flight count walks the same server comparison as the sync itself;
    // on a wide scope that's close to a minute spent "counting" before the
    // first byte moves, so the sync goes straight to the transfer.
    const client = await makeClient(() => ({ stdout: '' }))

    await client.sync('#head', { onProgress: () => {} })

    expect(spawned.filter((a) => subcommand(a) === 'sync' && a.includes('-n'))).toHaveLength(0)
  })

  it('exposes the running count on status.syncProgress and clears it when done', async () => {
    const client = await makeClient(() => ({
      stdout: [
        `//depot/branch_x/a.cpp#3 - updated as ${ROOT_FWD}/a.cpp`,
        `//depot/branch_x/b.h#7 - added as ${ROOT_FWD}/b.h`,
      ].join('\n'),
    }))
    const seen: number[] = []
    const sub = client.onDidChange(() => {
      const p = client.status.syncProgress
      if (p) seen.push(p.done)
    })
    try {
      await client.sync('#head', { onProgress: () => {} })
    } finally {
      sub.dispose()
    }

    // Intermediate frames may be coalesced by the throttle — the invariant is
    // the final count and the cleared state afterwards.
    expect(seen.at(-1)).toBe(2)
    // Cleared on every exit so the bar never shows a stale count.
    expect(client.status.syncProgress).toBeUndefined()
  })

  it('clears the progress even when the run is cancelled', async () => {
    const client = await makeClient(() => {
      client.cancelBusy()
      return { stdout: '', stderr: 'was cancelled', exit: 1 }
    })

    const res = await client.sync('#head', { onProgress: () => {} })

    expect(res.cancelled).toBe(true)
    expect(client.status.syncProgress).toBeUndefined()
  })
})

describe('PerforceClient.sync watcher activity & suspension', () => {
  const WATCH_OPTS: PerforceClientOptions = { watchRoot: ROOT, externalChangeDebounceMs: 0 }
  const track = async (p: Promise<PerforceClientInstance>): Promise<PerforceClientInstance> => {
    const c = await p
    made.push(c)
    return c
  }
  // Settle-time refreshes fire a reconcile scan that outlives the test; dispose
  // every client so a previous test's scan can't spawn into this one's `spawned`.
  const made: PerforceClientInstance[] = []
  afterEach(async () => {
    for (const c of made.splice(0)) c.dispose()
    await new Promise((r) => setTimeout(r, 0))
  })
  const pending = (client: PerforceClientInstance): Set<string> =>
    (client as unknown as { _externalChangePending: Set<string> })._externalChangePending
  const suspendCount = (client: PerforceClientInstance): number =>
    (client as unknown as { _externalSuspendCount: number })._externalSuspendCount
  const droppedEvents = (client: PerforceClientInstance): number =>
    (client as unknown as { _syncDroppedEvents: number })._syncDroppedEvents
  /** Narrow `reconcile -n <files>` spawns — excludes the scan's recursive
   *  `<dir>/...` batches, which settle-time refreshes also fire. */
  const narrowQueries = (): string[][] =>
    spawned
      .filter((a) => subcommand(a) === 'reconcile')
      .filter((a) => !a.some((arg) => /[/\\](\.\.\.|\*)$/.test(arg)))

  it('counts watcher events as disk writes while the sync runs', async () => {
    const wt = makeFakeWatcher()
    const client = await track(
      makeClient(
        () => ({ stdout: '' }),
        { createFileSystemWatcher: () => wt.watcher, ...WATCH_OPTS },
        {},
        true,
      ),
    )
    const run = client.sync('#head', { onProgress: () => {} })
    await vi.waitFor(() => expect(heldChildren.length).toBe(1))

    // Seed frame: armed with nothing written yet, the field is omitted — the
    // honest zero, not a falsy placeholder the bar would still print.
    expect(client.status.syncProgress?.done).toBe(0)
    expect(client.status.syncProgress?.diskWrites).toBeUndefined()

    wt.fire('change', `${ROOT_FWD}/a.cpp`)
    wt.fire('create', `${ROOT_FWD}/Content/b.bin`)
    wt.fire('delete', `${ROOT_FWD}/c.ini`)

    expect(client.status.syncProgress?.diskWrites).toBe(3)
    expect(client.status.syncProgress?.done).toBe(0)
    expect(droppedEvents(client)).toBe(3)

    finishHeld({ stdout: `//depot/branch_x/a.cpp#3 - updated as ${ROOT_FWD}/a.cpp` })
    const res = await run
    expect(res.ok).toBe(true)
    expect(client.status.syncProgress).toBeUndefined()
  })

  it('drops watcher events from the drift pipeline while suspended', async () => {
    const clock = fakeClock()
    const wt = makeFakeWatcher()
    const client = await track(
      makeClient(
        () => ({ stdout: '' }),
        { createFileSystemWatcher: () => wt.watcher, ...WATCH_OPTS },
        { now: clock.now },
        true,
      ),
    )
    const run = client.sync('#head', { onProgress: () => {} })
    await vi.waitFor(() => expect(heldChildren.length).toBe(1))

    // Past the 5s self-mutation window armed at spawn, so the suspension —
    // not the window — is the only thing keeping this event out.
    clock.advance(5001)
    wt.fire('change', `${ROOT_FWD}/a.cpp`)

    expect(pending(client).size).toBe(0)
    expect(
      (client as unknown as { _externalChangeTimer: ReturnType<typeof setTimeout> | undefined })
        ._externalChangeTimer,
    ).toBeUndefined()

    finishHeld()
    await run
  })

  it('defers a pre-sync external change to after the sync', async () => {
    const clock = fakeClock()
    const wt = makeFakeWatcher()
    const client = await track(
      makeClient(
        () => ({ stdout: '' }),
        { createFileSystemWatcher: () => wt.watcher, ...WATCH_OPTS },
        { now: clock.now },
        true,
      ),
    )
    wt.fire('change', `${ROOT_FWD}/a.cpp`)
    expect(pending(client).size).toBe(1)

    const run = client.sync('#head', { onProgress: () => {} })
    await vi.waitFor(() => expect(heldChildren.length).toBe(1))
    // Past the spawn-time 5s window, the debounce flush fires during the
    // suspension: the suspension alone — not the window's deferral branch —
    // must be what keeps the queue from being queried.
    clock.advance(5001)
    await new Promise((r) => setTimeout(r, 0))
    expect(narrowQueries().length).toBe(0)

    finishHeld()
    await run
    // Release re-arms the tail window and re-schedules the batch; past the
    // window it goes out exactly once.
    clock.advance(5001)
    await vi.waitFor(() => expect(narrowQueries().length).toBe(1))
    expect(narrowQueries()).toHaveLength(1)
  })

  it('releases on settle: late events resume the normal pipeline', async () => {
    const clock = fakeClock()
    const wt = makeFakeWatcher()
    const client = await track(
      makeClient(
        () => ({ stdout: '' }),
        { createFileSystemWatcher: () => wt.watcher, ...WATCH_OPTS },
        { now: clock.now },
        true,
      ),
    )
    const run = client.sync('#head', { onProgress: () => {} })
    await vi.waitFor(() => expect(heldChildren.length).toBe(1))
    finishHeld()
    await run
    expect(suspendCount(client)).toBe(0)

    // Past the tail window the sync armed on release, events flow again.
    clock.advance(5001)
    wt.fire('change', `${ROOT_FWD}/a.cpp`)
    expect(pending(client).size).toBe(1)
    await vi.waitFor(() => expect(narrowQueries().length).toBe(1))
  })

  it('keeps the release-time tail window over a sync that outlives the spawn window', async () => {
    const clock = fakeClock()
    const wt = makeFakeWatcher()
    const client = await track(
      makeClient(
        () => ({ stdout: '' }),
        { createFileSystemWatcher: () => wt.watcher, ...WATCH_OPTS },
        { now: clock.now },
        true,
      ),
    )
    const run = client.sync('#head', { onProgress: () => {} })
    await vi.waitFor(() => expect(heldChildren.length).toBe(1))

    // A wide sync far outlives the 5s self-mutation window armed at spawn —
    // the suspension, not that window, suppresses writes through the run.
    clock.advance(60_000)
    wt.fire('change', `${ROOT_FWD}/during.cpp`)
    expect(pending(client).size).toBe(0)

    finishHeld()
    await run
    expect(suspendCount(client)).toBe(0)

    // The tail window armed at release covers the watcher's RPC lag: events
    // right after the settle are still suppressed…
    wt.fire('change', `${ROOT_FWD}/late.cpp`)
    expect(pending(client).size).toBe(0)

    // …and past it the pipeline resumes.
    clock.advance(5001)
    wt.fire('change', `${ROOT_FWD}/after.cpp`)
    expect(pending(client).size).toBe(1)
    await vi.waitFor(() => expect(narrowQueries().length).toBe(1))
  })

  it('releases on cancel', async () => {
    const wt = makeFakeWatcher()
    const client = await track(
      makeClient(
        () => ({ stdout: '' }),
        { createFileSystemWatcher: () => wt.watcher, ...WATCH_OPTS },
        {},
        true,
      ),
    )
    const run = client.sync('#head', { onProgress: () => {} })
    await vi.waitFor(() => expect(heldChildren.length).toBe(1))
    client.cancelBusy()
    finishHeld({ exit: 1 })

    const res = await run
    expect(res.cancelled).toBe(true)
    expect(suspendCount(client)).toBe(0)
    expect(client.status.syncProgress).toBeUndefined()
  })

  it('is inert for a non-streaming sync', async () => {
    const clock = fakeClock()
    const wt = makeFakeWatcher()
    const client = await track(
      makeClient(
        () => ({ stdout: '' }),
        { createFileSystemWatcher: () => wt.watcher, ...WATCH_OPTS },
        { now: clock.now },
        true,
      ),
    )
    const run = client.sync('#head')
    await vi.waitFor(() => expect(heldChildren.length).toBe(1))

    clock.advance(5001)
    wt.fire('change', `${ROOT_FWD}/a.cpp`)

    // No streaming progress to attribute the count to: nothing to read, no throw.
    expect(client.status.syncProgress).toBeUndefined()
    expect(pending(client).size).toBe(0)

    finishHeld()
    await run
    expect(suspendCount(client)).toBe(0)
  })

  it('keeps the suspension armed until the LAST overlapping sync settles', async () => {
    const clock = fakeClock()
    const wt = makeFakeWatcher()
    const client = await track(
      makeClient(
        () => ({ stdout: '' }),
        { createFileSystemWatcher: () => wt.watcher, ...WATCH_OPTS },
        { now: clock.now },
        true,
      ),
    )
    const first = client.sync('#head', { onProgress: () => {} })
    await vi.waitFor(() => expect(heldChildren.length).toBe(1))
    const second = client.sync('#head', { onProgress: () => {} })
    await vi.waitFor(() => expect(heldChildren.length).toBe(2))
    expect(suspendCount(client)).toBe(2)

    clock.advance(5001)
    finishHeld()
    await first
    expect(suspendCount(client)).toBe(1)
    // Still held by the second sync — past the first's spawn-time window, only
    // the depth-1 suspension keeps this out.
    wt.fire('change', `${ROOT_FWD}/a.cpp`)
    expect(pending(client).size).toBe(0)

    finishHeld()
    await second
    expect(suspendCount(client)).toBe(0)
  })

  it('releases on failure (non-zero exit)', async () => {
    const clock = fakeClock()
    const wt = makeFakeWatcher()
    const client = await track(
      makeClient(
        () => ({ stdout: '' }),
        { createFileSystemWatcher: () => wt.watcher, ...WATCH_OPTS },
        { now: clock.now },
        true,
      ),
    )
    const run = client.sync('#head', { onProgress: () => {} })
    await vi.waitFor(() => expect(heldChildren.length).toBe(1))
    finishHeld({ stderr: 'upgrade your client', exit: 1 })

    const res = await run
    expect(res.ok).toBe(false)
    expect(suspendCount(client)).toBe(0)

    clock.advance(5001)
    wt.fire('change', `${ROOT_FWD}/a.cpp`)
    expect(pending(client).size).toBe(1)
  })
})
