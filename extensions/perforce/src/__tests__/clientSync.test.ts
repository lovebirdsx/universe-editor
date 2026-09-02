/**
 * `PerforceClient.sync` / `previewSync` semantics: the summary a get reports back,
 * the argv it builds (scope, revision spec, `-f`), and the failure classification
 * a caller turns into guidance. Sync deliberately does NOT go through `_mutate`
 * (that returns a bare boolean), so the skeleton it replicates — cancellable,
 * refresh either way, cache cleared on success — is pinned here.
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

function respond(handler: (argv: string[]) => Reply): void {
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[1] as string[]) ?? []
    spawned.push(argv)
    const child = new FakeChildProcess()
    queueMicrotask(() => {
      const reply = handler(argv)
      if (reply.stdout) child.stdout.emit('data', Buffer.from(reply.stdout))
      if (reply.stderr) child.stderr.emit('data', Buffer.from(reply.stderr))
      child.emit('close', reply.exit ?? 0)
    })
    return child
  })
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

async function makeClient(syncReply: (argv: string[]) => Reply = () => ({ stdout: '' })) {
  respond(makeHandler(syncReply))
  const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
    enabled: true,
    workspaceTtlMs: 4000,
  })
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
      log,
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
      log,
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
    } finally {
      spy.mockRestore()
    }
  })
})
