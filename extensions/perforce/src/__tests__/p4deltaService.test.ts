import { EventEmitter } from 'node:events'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `resolveP4deltaCommand` only ever asks the filesystem whether a candidate
// exists, so the "installed" set is all the fs it needs.
const { fsState } = vi.hoisted(() => ({ fsState: { existing: new Set<string>() } }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: unknown) => fsState.existing.has(String(path)),
  }
})

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = { end: vi.fn() }
  pid: number | undefined = 4242
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

const spawnMock = vi.fn<(...args: unknown[]) => FakeChildProcess>()
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

const {
  P4deltaService,
  P4DELTA_PROBE_TIMEOUT_MS,
  clearP4deltaProbeCache,
  p4deltaSpawnCommand,
  probeP4delta,
  resolveP4deltaCommand,
} = await import('../p4deltaService.js')
const { ConcurrencyGate } = await import('../concurrency.js')

/** The executable name the resolver looks for on THIS platform. */
const EXE_NAME = process.platform === 'win32' ? 'p4delta.exe' : 'p4delta'

// `run` awaits the concurrency gate before spawning, so the child is created a
// microtask later; flush pending microtasks before emitting on it.
const flush = () => new Promise((r) => setTimeout(r, 0))

interface Connection {
  readonly port?: string
  readonly user?: string
  readonly client?: string
}

function makeService(
  connection?: Connection,
  log?: (msg: string) => void,
): InstanceType<typeof P4deltaService> {
  return new P4deltaService(
    '/ws/main',
    new ConcurrencyGate(4),
    connection,
    '/opt/p4delta',
    '/ws/main',
    log,
  )
}

function spawnedEnv(): NodeJS.ProcessEnv {
  const options = spawnMock.mock.calls.at(-1)?.[2] as { env: NodeJS.ProcessEnv }
  return options.env
}

const FILE_LINE =
  '{"kind":"file","mode":"open","class":"edit","action":"edit",' +
  '"depotFile":"//depot/main/a.ts","clientFile":"//main/a.ts","rev":"3","applied":false}\n'
const SUMMARY_LINE =
  '{"kind":"summary","mode":"open","ok":true,"applied":false,"total":1,"counts":{"edit":1},' +
  '"scopeMatched":1,"unmatched":0,"elapsedMs":9,"reason":null}\n'

describe('resolveP4deltaCommand', () => {
  const saved = {
    override: process.env.UNIVERSE_P4DELTA_PATH,
    path: process.env.PATH,
    localAppData: process.env.LOCALAPPDATA,
  }
  const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    delete process.env.UNIVERSE_P4DELTA_PATH
    fsState.existing.clear()
  })

  afterEach(() => {
    if (saved.override === undefined) delete process.env.UNIVERSE_P4DELTA_PATH
    else process.env.UNIVERSE_P4DELTA_PATH = saved.override
    if (saved.path === undefined) delete process.env.PATH
    else process.env.PATH = saved.path
    if (saved.localAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = saved.localAppData
    if (savedPlatform) Object.defineProperty(process, 'platform', savedPlatform)
    fsState.existing.clear()
  })

  it('prefers UNIVERSE_P4DELTA_PATH over the setting and PATH', () => {
    process.env.UNIVERSE_P4DELTA_PATH = '/opt/e2e/p4delta'
    process.env.PATH = ['/usr/bin'].join(delimiter)
    fsState.existing.add(join('/usr/bin', EXE_NAME))
    expect(resolveP4deltaCommand('/configured/p4delta')).toBe('/opt/e2e/p4delta')
  })

  it('honors a configured path verbatim, even when it does not exist yet', () => {
    // A dangling configured path must surface as a failed probe, not silently
    // select some other p4delta from PATH.
    process.env.PATH = ['/usr/bin'].join(delimiter)
    fsState.existing.add(join('/usr/bin', EXE_NAME))
    expect(resolveP4deltaCommand('/configured/p4delta')).toBe('/configured/p4delta')
  })

  it('falls through an empty setting to PATH', () => {
    process.env.PATH = ['/empty', '/usr/bin'].join(delimiter)
    fsState.existing.add(join('/usr/bin', EXE_NAME))
    expect(resolveP4deltaCommand('')).toBe(join('/usr/bin', EXE_NAME))
    expect(resolveP4deltaCommand(undefined)).toBe(join('/usr/bin', EXE_NAME))
  })

  it('returns undefined when nothing is installed', () => {
    process.env.PATH = ['/empty'].join(delimiter)
    // Keep the Windows default-install branch out of this machine's real state.
    process.env.LOCALAPPDATA = '/nonexistent'
    expect(resolveP4deltaCommand('')).toBeUndefined()
  })

  it('looks for p4delta.exe on PATH on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    process.env.PATH = '/tools'
    fsState.existing.add('/tools/p4delta.exe')
    expect(resolveP4deltaCommand('')).toBe('/tools/p4delta.exe')
  })

  it('finds the default Windows install location when PATH has nothing', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    process.env.PATH = '/empty'
    process.env.LOCALAPPDATA = '/Users/testuser/AppData/Local'
    const installed = join('/Users/testuser/AppData/Local', 'Programs', 'p4delta', 'p4delta.exe')
    fsState.existing.add(installed)
    expect(resolveP4deltaCommand('')).toBe(installed)
  })
})

describe('p4deltaSpawnCommand', () => {
  // The e2e fixture points the engine at a `.mjs` — the same escape hatch p4
  // itself has — so the script form has to reach the Node runtime rather than
  // being handed to the OS as an executable.
  it.each(['/opt/e2e/fake-p4delta.mjs', '/opt/e2e/fake-p4delta.js', '/opt/e2e/fake.cjs'])(
    'runs %s through this runtime',
    (script) => {
      expect(p4deltaSpawnCommand(script)).toEqual({
        command: process.execPath,
        prefixArgs: [script],
      })
    },
  )

  it('spawns a real executable verbatim', () => {
    expect(p4deltaSpawnCommand('C:/tools/p4delta.exe')).toEqual({
      command: 'C:/tools/p4delta.exe',
      prefixArgs: [],
    })
  })
})

describe('probeP4delta', () => {
  let child: FakeChildProcess
  beforeEach(() => {
    clearP4deltaProbeCache()
    child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
  })
  afterEach(() => {
    spawnMock.mockReset()
    vi.useRealTimers()
  })

  it('accepts a build advertising both --json and --client-root', async () => {
    const probe = probeP4delta('/opt/p4delta')
    child.stdout.emit(
      'data',
      Buffer.from(
        'Usage: p4delta [OPTIONS]\n  --json   machine-readable output\n  --client-root <PATH>\n',
      ),
    )
    child.emit('close', 0, null)
    await expect(probe).resolves.toBe(true)
    expect(spawnMock.mock.calls.at(-1)?.[1]).toEqual(['--help'])
  })

  it('accepts help text printed to stderr', async () => {
    const probe = probeP4delta('/opt/p4delta')
    child.stderr.emit('data', Buffer.from('--json\n--client-root <PATH>\n'))
    child.emit('close', 0, null)
    await expect(probe).resolves.toBe(true)
  })

  it('rejects a build without the --json contract', async () => {
    const probe = probeP4delta('/opt/p4delta')
    child.stdout.emit('data', Buffer.from('Usage: p4delta [OPTIONS]\n  --client-root <PATH>\n'))
    child.emit('close', 0, null)
    await expect(probe).resolves.toBe(false)
  })

  it('answers false when the executable cannot be spawned, and caches that verdict', async () => {
    const probe = probeP4delta('/opt/missing')
    child.emit('error', Object.assign(new Error('spawn /opt/missing ENOENT'), { code: 'ENOENT' }))
    await expect(probe).resolves.toBe(false)

    // Second ask: no second spawn — a broken binary is not re-spawned on every
    // refresh.
    spawnMock.mockClear()
    await expect(probeP4delta('/opt/missing')).resolves.toBe(false)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('probes each exe path once per session', async () => {
    const first = probeP4delta('/opt/p4delta')
    child.stdout.emit('data', Buffer.from('--json --client-root'))
    child.emit('close', 0, null)
    await expect(first).resolves.toBe(true)

    spawnMock.mockClear()
    await expect(probeP4delta('/opt/p4delta')).resolves.toBe(true)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('kills a hung --help and answers false instead of hanging', async () => {
    vi.useFakeTimers()
    const probe = probeP4delta('/opt/p4delta')
    vi.advanceTimersByTime(P4DELTA_PROBE_TIMEOUT_MS)
    await expect(probe).resolves.toBe(false)
    expect(child.killed).toBe(true)
  })

  it('probes a script override through this runtime too', async () => {
    const probe = probeP4delta('/opt/e2e/fake-p4delta.mjs')
    child.stdout.emit('data', Buffer.from('--json --client-root'))
    child.emit('close', 0, null)
    await expect(probe).resolves.toBe(true)
    const call = spawnMock.mock.calls.at(-1)
    expect(call?.[0]).toBe(process.execPath)
    expect(call?.[1]).toEqual(['/opt/e2e/fake-p4delta.mjs', '--help'])
    expect(spawnedEnv().ELECTRON_RUN_AS_NODE).toBe('1')
  })
})

describe('P4deltaService.run', () => {
  let child: FakeChildProcess
  beforeEach(() => {
    child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
  })
  afterEach(() => {
    spawnMock.mockReset()
  })

  it('spawns the engine with the argv as given and no shell', async () => {
    const svc = makeService()
    const args = [
      '--json',
      '--client-root',
      '/ws/main',
      '--no-scope-file',
      '--no-revert-groups',
      'open',
      '/ws/main/...',
    ]
    const p = svc.run(args)
    await flush()
    const call = spawnMock.mock.calls.at(-1)
    expect(call?.[0]).toBe('/opt/p4delta')
    expect(call?.[1]).toEqual(args)
    const options = call?.[2] as { cwd: string; shell: boolean; windowsHide: boolean }
    expect(options.cwd).toBe('/ws/main')
    expect(options.shell).toBe(false)
    expect(options.windowsHide).toBe(true)
    child.emit('close', 0, null)
    await p
  })

  it('runs a script override through this runtime, restoring ELECTRON_RUN_AS_NODE', async () => {
    const svc = new P4deltaService(
      '/ws/main',
      new ConcurrencyGate(4),
      undefined,
      '/opt/e2e/fake-p4delta.mjs',
      '/ws/main',
    )
    const p = svc.run(['--json', 'open'])
    await flush()
    const call = spawnMock.mock.calls.at(-1)
    expect(call?.[0]).toBe(process.execPath)
    expect(call?.[1]).toEqual(['/opt/e2e/fake-p4delta.mjs', '--json', 'open'])
    // sanitizeEnv strips it; without it the Electron binary would start a GUI app
    // instead of running the script (p4Service re-adds it for the same reason).
    expect(spawnedEnv().ELECTRON_RUN_AS_NODE).toBe('1')
    child.emit('close', 0, null)
    await p
  })

  it('carries the service-wide extraEnv on every run, with the per-run value winning', async () => {
    const svc = new P4deltaService(
      '/ws/main',
      new ConcurrencyGate(4),
      undefined,
      '/opt/p4delta',
      '/ws/main',
      undefined,
      undefined,
      { P4_EXE: '/opt/e2e/fake-p4.mjs', P4CLIENT: 'from-service' },
    )
    const p = svc.run(['--json', 'open'], { extraEnv: { P4_EXE: 'from-run' } })
    await flush()
    const env = spawnedEnv()
    expect(env.P4_EXE).toBe('from-run')
    expect(env.P4CLIENT).toBe('from-service')
    child.emit('close', 0, null)
    await p
  })

  it('parses the record stream and reports the summary', async () => {
    const svc = makeService()
    const p = svc.run(['--json', 'open'])
    await flush()
    child.stdout.emit('data', Buffer.from(FILE_LINE + SUMMARY_LINE))
    child.emit('close', 0, null)
    const result = await p
    expect(result.code).toBe(0)
    expect(result.records).toHaveLength(2)
    expect(result.sawSummary).toBe(true)
    expect(result.sawNonJsonStdout).toBe(false)
  })

  it('reassembles a record split across chunks', async () => {
    const svc = makeService()
    const p = svc.run(['--json', 'open'])
    await flush()
    child.stdout.emit('data', Buffer.from('{"kind":"summ'))
    child.stdout.emit('data', Buffer.from('ary","ok":true,"mode":"open"}\n'))
    child.emit('close', 0, null)
    const result = await p
    expect(result.records).toEqual([{ kind: 'summary', ok: true, mode: 'open' }])
    expect(result.sawSummary).toBe(true)
  })

  it('flags a non-JSON stdout line, drops it, and keeps the rest of the stream', async () => {
    const logs: string[] = []
    const svc = makeService(undefined, (m) => logs.push(m))
    const p = svc.run(['--json', 'open'])
    await flush()
    child.stdout.emit(
      'data',
      Buffer.from('Warning: this is not a record\n' + FILE_LINE + SUMMARY_LINE),
    )
    child.emit('close', 0, null)
    const result = await p
    // The engine is not the one we expect — the caller must not trust the run…
    expect(result.sawNonJsonStdout).toBe(true)
    // …but the stream is still parsed (no throw, nothing lost).
    expect(result.records).toHaveLength(2)
    expect(result.sawSummary).toBe(true)
    expect(logs.join('\n')).toMatch(/non-JSON stdout line/)
  })

  it('separates stderr progress records from the human log', async () => {
    const svc = makeService()
    const p = svc.run(['--json', 'open'])
    await flush()
    child.stderr.emit(
      'data',
      Buffer.from(
        '{"kind":"progress","phase":"digest","step":3,"total":5,"message":"Checking digests."}\n' +
          'Checking digests for 340 files.\n' +
          '{"kind":"error","clientFile":"//main/a.ts","message":"boom"}\n',
      ),
    )
    child.emit('close', 0, null)
    const result = await p
    expect(result.progress).toEqual([
      { kind: 'progress', phase: 'digest', step: 3, total: 5, message: 'Checking digests.' },
    ])
    // A stderr line that is not a progress record stays a log line, verbatim.
    expect(result.log).toEqual([
      'Checking digests for 340 files.',
      '{"kind":"error","clientFile":"//main/a.ts","message":"boom"}',
    ])
  })

  it('resolves a spawn failure as a failure result instead of rejecting', async () => {
    const svc = makeService()
    const p = svc.run(['--json', 'open'])
    await flush()
    child.emit('error', Object.assign(new Error('spawn /opt/p4delta ENOENT'), { code: 'ENOENT' }))
    const result = await p
    expect(result.code).toBe(1)
    expect(result.records).toEqual([])
    expect(result.sawSummary).toBe(false)
    expect(result.log.join('\n')).toMatch(/ENOENT/)
  })

  it('kills a hung engine on its watchdog and resolves without a conclusion', async () => {
    const svc = makeService()
    const p = svc.run(['--json', 'open'], { timeoutMs: 50 })
    await flush()
    await new Promise((r) => setTimeout(r, 80))
    expect(child.killed).toBe(true)
    child.emit('close', null, 'SIGTERM')
    const result = await p
    expect(result.code).toBe(1)
    expect(result.signal).toBe('SIGTERM')
    expect(result.sawSummary).toBe(false)
    expect(result.log.join('\n')).toMatch(/timed out after 50ms/)
  })

  it('kills the engine when the caller cancels, keeping the records it already sent', async () => {
    const svc = makeService()
    const controller = new AbortController()
    const p = svc.run(['--json', 'open'], { signal: controller.signal })
    await flush()
    child.stdout.emit('data', Buffer.from(FILE_LINE))
    controller.abort()
    expect(child.killed).toBe(true)
    child.emit('close', null, 'SIGTERM')
    const result = await p
    expect(result.log.join('\n')).toMatch(/was cancelled/)
    expect(result.records).toHaveLength(1)
    // Partial records without a summary are not a conclusion.
    expect(result.sawSummary).toBe(false)
  })

  it('aborts an oversized stdout instead of growing it toward the string cap', async () => {
    const svc = makeService()
    const p = svc.run(['--json', 'open'], { maxOutputBytes: 64 })
    await flush()
    child.stdout.emit('data', Buffer.from('x'.repeat(100) + '\n'))
    expect(child.killed).toBe(true)
    child.emit('close', null, 'SIGTERM')
    const result = await p
    expect(result.code).toBe(1)
    expect(result.sawSummary).toBe(false)
    expect(result.log.join('\n')).toMatch(/exceeded .*MB and was aborted/)
  })

  // Red line 3: a burst of background scans must not queue the user's click
  // behind them.
  it('spawns an interactive run into the gate’s reserved slot', async () => {
    const gate = new ConcurrencyGate(4, 1) // backgroundCap = 3
    const svc = new P4deltaService('/ws/main', gate, undefined, '/opt/p4delta', '/ws/main')
    const holders: FakeChildProcess[] = []
    for (let i = 0; i < 3; i++) {
      const holder = new FakeChildProcess()
      holders.push(holder)
      spawnMock.mockReturnValueOnce(holder)
      void svc.run(['--json', 'open', `batch${i}`])
    }
    await flush()
    expect(spawnMock).toHaveBeenCalledTimes(3)

    const interactive = new FakeChildProcess()
    spawnMock.mockReturnValueOnce(interactive)
    void svc.run(['--json', 'open', 'click'], { priority: 'interactive' })
    await flush()
    expect(spawnMock).toHaveBeenCalledTimes(4)
    expect(spawnMock.mock.calls[3]?.[1]).toEqual(['--json', 'open', 'click'])

    holders.forEach((c) => c.emit('close', 0, null))
    interactive.emit('close', 0, null)
    await flush()
  })
})

describe('P4deltaService child env', () => {
  let child: FakeChildProcess
  beforeEach(() => {
    child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
  })
  afterEach(() => {
    spawnMock.mockReset()
  })

  async function envOf(connection?: Connection, extraEnv?: Record<string, string>) {
    const svc = makeService(connection)
    const p = svc.run(['--json', 'open'], extraEnv ? { extraEnv } : undefined)
    await flush()
    const env = spawnedEnv()
    child.emit('close', 0, null)
    await p
    return env
  }

  it('injects the connection as P4CLIENT / P4USER, sanitizing the parent env', async () => {
    const prev = { PWD: process.env.PWD, NODE_OPTIONS: process.env.NODE_OPTIONS }
    process.env.PWD = '/some/other/place'
    process.env.NODE_OPTIONS = '--inspect'
    try {
      const env = await envOf({ client: 'main', user: 'testuser' })
      expect(env.P4CLIENT).toBe('main')
      expect(env.P4USER).toBe('testuser')
      expect(env.PWD).toBeUndefined()
      expect(env.NODE_OPTIONS).toBeUndefined()
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    } finally {
      if (prev.PWD === undefined) delete process.env.PWD
      else process.env.PWD = prev.PWD
      if (prev.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = prev.NODE_OPTIONS
    }
  })

  // Red line 2: the port is only ever the explicitly configured one — never
  // derived from what the server reports.
  it('sets P4PORT only when the connection carries an explicit port', async () => {
    expect((await envOf({ client: 'main' })).P4PORT).toBeUndefined()
    expect((await envOf({ client: 'main', port: 'p4.example.com:1666' })).P4PORT).toBe(
      'p4.example.com:1666',
    )
    expect((await envOf()).P4PORT).toBeUndefined()
  })

  it('merges extraEnv last, so the caller can add P4_EXE and override anything', async () => {
    const env = await envOf(
      { client: 'main' },
      { P4_EXE: '/opt/perforce/p4', P4CLIENT: 'override' },
    )
    expect(env.P4_EXE).toBe('/opt/perforce/p4')
    expect(env.P4CLIENT).toBe('override')
  })
})
