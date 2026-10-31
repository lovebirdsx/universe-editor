import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KillableProcess, ProcessKiller } from '../killProcessTree.js'
import type { P4deltaLogSink, P4deltaRunEnd, P4deltaRunStart } from '../p4delta/p4deltaService.js'

// `resolveP4deltaCommand` only ever asks the filesystem whether a candidate
// exists, so the "installed" set is all the fs it needs.
const { fsState } = vi.hoisted(() => ({
  fsState: { existing: new Set<string>() },
}))

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
  P4deltaLogTail,
  createP4deltaLineReader,
  formatP4deltaSummaryFooter,
  p4deltaSpawnCommand,
  resolveP4deltaCommand,
} = await import('../p4delta/p4deltaService.js')
const { isSafeRunId } = await import('../p4delta/p4deltaRunLog.js')
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

// 测试里默认注入「直接 proc.kill()」的 killer：保留既有的 `child.killed` 断言，
// 又不让服务测试依赖 killProcessTree 在 mock 环境下的回退路径（那条路径另有单测）。
function killDirectly(proc: KillableProcess): void {
  proc.kill()
}

function makeService(
  connection?: Connection,
  log?: (msg: string) => void,
  sink?: P4deltaLogSink,
  killProcess: ProcessKiller = killDirectly,
): InstanceType<typeof P4deltaService> {
  return new P4deltaService(
    '/ws/main',
    new ConcurrencyGate(4),
    connection,
    '/opt/p4delta',
    '/ws/main',
    log,
    undefined,
    {},
    sink,
    killProcess,
  )
}

/** 一个把行收进数组的 sink，供流式 / runId / 终态相关的用例使用。 */
function collectingSink(): {
  sink: P4deltaLogSink
  lines: string[]
  starts: P4deltaRunStart[]
  ends: P4deltaRunEnd[]
} {
  const lines: string[] = []
  const starts: P4deltaRunStart[] = []
  const ends: P4deltaRunEnd[] = []
  return {
    lines,
    starts,
    ends,
    sink: {
      open: (info) => {
        starts.push(info)
        return { line: (text) => lines.push(text) }
      },
      close: (info) => {
        ends.push(info)
      },
    },
  }
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
    expect(resolveP4deltaCommand('/configured/p4delta')).toEqual({
      exe: '/opt/e2e/p4delta',
      source: 'env',
    })
  })

  it('honors a configured path verbatim, even when it does not exist yet', () => {
    // A dangling configured path must surface as a refusal at the gate, not
    // silently select some other p4delta from PATH.
    process.env.PATH = ['/usr/bin'].join(delimiter)
    fsState.existing.add(join('/usr/bin', EXE_NAME))
    expect(resolveP4deltaCommand('/configured/p4delta')).toEqual({
      exe: '/configured/p4delta',
      source: 'configured',
    })
  })

  it('falls through an empty setting to PATH', () => {
    process.env.PATH = ['/empty', '/usr/bin'].join(delimiter)
    fsState.existing.add(join('/usr/bin', EXE_NAME))
    const expected = { exe: join('/usr/bin', EXE_NAME), source: 'path' }
    expect(resolveP4deltaCommand('')).toEqual(expected)
    expect(resolveP4deltaCommand(undefined)).toEqual(expected)
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
    // Both sides through `join`: the lookup builds its candidate with the host
    // separator (mocking `process.platform` does not reach `node:path`), so a
    // hardcoded forward-slash key would never match on Windows.
    const installed = join('/tools', 'p4delta.exe')
    fsState.existing.add(installed)
    expect(resolveP4deltaCommand('')).toEqual({ exe: installed, source: 'path' })
  })

  it('finds the default Windows install location when PATH has nothing', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    process.env.PATH = '/empty'
    process.env.LOCALAPPDATA = '/Users/testuser/AppData/Local'
    const installed = join('/Users/testuser/AppData/Local', 'Programs', 'p4delta', 'p4delta.exe')
    fsState.existing.add(installed)
    expect(resolveP4deltaCommand('')).toEqual({ exe: installed, source: 'localAppData' })
  })
})

// 托管副本压在机器自带的两级之上（编辑器唯一能持续升级的那份，不能被更旧的自装副本遮蔽）；机器只有自带副本时仍用它。These read a real `.active` file (only `existsSync`
// is faked in this suite), so they get a real directory.
describe('resolveP4deltaCommand: the managed tier', () => {
  let root: string
  const savedPath = process.env.PATH
  const savedLocalAppData = process.env.LOCALAPPDATA
  const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    root = mkTempDir('ue-p4delta-cmd-')
    fsState.existing.clear()
    delete process.env.UNIVERSE_P4DELTA_PATH
    process.env.PATH = ['/empty'].join(delimiter)
    process.env.LOCALAPPDATA = '/nonexistent'
  })

  afterEach(() => {
    removeDirWithRetry(root)
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = savedLocalAppData
    if (savedPlatform) Object.defineProperty(process, 'platform', savedPlatform)
    fsState.existing.clear()
  })

  const activate = (version: string): string => {
    writeFileSync(join(root, '.active'), version)
    const exe = join(root, version, 'p4delta.exe')
    fsState.existing.add(exe)
    return exe
  }

  it('answers after every self-installed tier came up empty', () => {
    const managed = activate('0.1.10')
    expect(resolveP4deltaCommand('', root)).toEqual({ exe: managed, source: 'managed' })
  })

  it('wins over a copy the machine already has on PATH', () => {
    process.env.PATH = ['/usr/bin'].join(delimiter)
    const onPath = join('/usr/bin', EXE_NAME)
    fsState.existing.add(onPath)
    const managed = activate('0.1.12')
    expect(resolveP4deltaCommand('', root)).toEqual({ exe: managed, source: 'managed' })
  })

  it('wins over the Windows default install location', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    process.env.LOCALAPPDATA = '/Users/testuser/AppData/Local'
    const installed = join('/Users/testuser/AppData/Local', 'Programs', 'p4delta', 'p4delta.exe')
    fsState.existing.add(installed)
    const managed = activate('0.1.12')
    expect(resolveP4deltaCommand('', root)).toEqual({ exe: managed, source: 'managed' })
  })

  it('yields to the environment override', () => {
    process.env.UNIVERSE_P4DELTA_PATH = '/opt/e2e/p4delta'
    activate('0.1.12')
    expect(resolveP4deltaCommand('', root)).toEqual({ exe: '/opt/e2e/p4delta', source: 'env' })
  })

  it('yields to a configured path', () => {
    activate('0.1.10')
    expect(resolveP4deltaCommand('/configured/p4delta', root)).toEqual({
      exe: '/configured/p4delta',
      source: 'configured',
    })
  })

  it('is skipped entirely without a root', () => {
    activate('0.1.10')
    expect(resolveP4deltaCommand('', undefined)).toBeUndefined()
    expect(resolveP4deltaCommand('', '')).toBeUndefined()
  })

  // 指针背后没有副本 = 「没有托管副本」，绝不抛异常，查找与没有该级一样。
  it('falls through to a copy the machine has when the pointer names no copy', () => {
    process.env.PATH = ['/usr/bin'].join(delimiter)
    const onPath = join('/usr/bin', EXE_NAME)
    fsState.existing.add(onPath)
    writeFileSync(join(root, '.active'), '0.1.10')
    expect(resolveP4deltaCommand('', root)).toEqual({ exe: onPath, source: 'path' })
  })

  it('reports nothing when neither the managed copy nor the machine has one', () => {
    writeFileSync(join(root, '.active'), '0.1.10')
    expect(resolveP4deltaCommand('', root)).toBeUndefined()
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

  // The streaming seam a get's progress bar rides on: every stdout record, in
  // arrival order, without buffering the run.
  it('hands each stdout record to onRecord as it arrives', async () => {
    const svc = makeService()
    const seen: unknown[] = []
    const p = svc.run(['--json', '--sync', '-a'], { onRecord: (record) => seen.push(record) })
    await flush()
    expect(seen).toEqual([])
    child.stdout.emit('data', Buffer.from(FILE_LINE))
    expect(seen).toEqual([JSON.parse(FILE_LINE)])
    child.stdout.emit('data', Buffer.from(SUMMARY_LINE))
    child.emit('close', 0, null)
    await p
    expect(seen).toHaveLength(2)
    // stderr records (progress) are not part of the stream the caller reads.
    child.stderr.emit('data', Buffer.from('{"kind":"progress","phase":"apply"}\n'))
    expect(seen).toHaveLength(2)
  })

  // Red line 4 through the one callback that runs per file: a consumer that
  // throws must not take the host down, and must not stop the run either.
  it('swallows a throwing onRecord and keeps parsing', async () => {
    const svc = makeService()
    const p = svc.run(['--json', '--sync', '-a'], {
      onRecord: () => {
        throw new Error('consumer exploded')
      },
    })
    await flush()
    child.stdout.emit('data', Buffer.from(FILE_LINE + SUMMARY_LINE))
    child.emit('close', 0, null)
    const result = await p
    expect(result.records).toHaveLength(2)
    expect(result.sawSummary).toBe(true)
  })

  it('reports the pid to onSpawn, and tolerates a sampler that throws', async () => {
    const svc = makeService()
    const pids: number[] = []
    const p = svc.run(['--json', '--sync', '-a'], {
      onSpawn: (pid) => {
        pids.push(pid)
        throw new Error('sampler exploded')
      },
    })
    await flush()
    expect(pids).toEqual([4242])
    child.emit('close', 0, null)
    await expect(p).resolves.toMatchObject({ code: 0 })
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

  // The live half of the same stream: a get's stage readout needs each record as
  // its line lands (a phase known only at the end names a stage already over),
  // while the collected array stays for the replays that read the ladder whole.
  it('hands each progress record to onProgress as it arrives, keeping the replay', async () => {
    const svc = makeService()
    const seen: unknown[] = []
    const p = svc.run(['--json', '--sync', '--force', '-a'], {
      onProgress: (record) => seen.push(record),
    })
    await flush()
    expect(seen).toEqual([])
    child.stderr.emit(
      'data',
      Buffer.from('{"kind":"progress","phase":"scan","step":2,"total":7}\n'),
    )
    expect(seen).toEqual([{ kind: 'progress', phase: 'scan', step: 2, total: 7 }])
    child.stderr.emit(
      'data',
      Buffer.from('{"kind":"progress","phase":"apply","step":6,"total":7}\n'),
    )
    child.emit('close', 0, null)
    const result = await p
    expect(seen).toHaveLength(2)
    expect(result.progress).toEqual(seen)
  })

  // Red line 4 through the newest callback: the status bar's own handler runs on
  // every progress line, so a throw in it must not stop the run or the parse.
  it('swallows a throwing onProgress and keeps parsing', async () => {
    const svc = makeService()
    const p = svc.run(['--json', '--sync', '-a'], {
      onProgress: () => {
        throw new Error('consumer exploded')
      },
    })
    await flush()
    child.stderr.emit(
      'data',
      Buffer.from('{"kind":"progress","phase":"scan","step":2,"total":6}\n'),
    )
    child.stdout.emit('data', Buffer.from(FILE_LINE + SUMMARY_LINE))
    child.emit('close', 0, null)
    const result = await p
    expect(result.progress).toHaveLength(1)
    expect(result.records).toHaveLength(2)
    expect(result.sawSummary).toBe(true)
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

  it('delegates the cancel kill to the injected process killer', async () => {
    const killed: KillableProcess[] = []
    const killProcess = vi.fn((proc: KillableProcess) => {
      killed.push(proc)
    })
    const svc = makeService(undefined, undefined, undefined, killProcess)
    const controller = new AbortController()
    const p = svc.run(['--json', 'open'], { signal: controller.signal })
    await flush()
    controller.abort()
    expect(killed).toEqual([child])
    // 树杀完全交给注入的 killer；服务层不再自己补一刀 proc.kill()。
    expect(child.killed).toBe(false)
    child.emit('close', null, 'SIGTERM')
    const result = await p
    expect(result.log.join('\n')).toMatch(/was cancelled/)
  })

  it('delegates the watchdog kill to the injected process killer', async () => {
    const killed: KillableProcess[] = []
    const killProcess = vi.fn((proc: KillableProcess) => {
      killed.push(proc)
    })
    const svc = makeService(undefined, undefined, undefined, killProcess)
    const p = svc.run(['--json', 'open'], { timeoutMs: 50 })
    await flush()
    await new Promise((r) => setTimeout(r, 80))
    expect(killed).toEqual([child])
    expect(child.killed).toBe(false)
    child.emit('close', null, 'SIGTERM')
    const result = await p
    expect(result.log.join('\n')).toMatch(/timed out after 50ms/)
  })

  it('delegates the stdout byte-cap kill to the injected process killer', async () => {
    const killed: KillableProcess[] = []
    const killProcess = vi.fn((proc: KillableProcess) => {
      killed.push(proc)
    })
    const svc = makeService(undefined, undefined, undefined, killProcess)
    const p = svc.run(['--json', 'open'], { maxOutputBytes: 64 })
    await flush()
    child.stdout.emit('data', Buffer.from('x'.repeat(100) + '\n'))
    expect(killed).toEqual([child])
    expect(child.killed).toBe(false)
    child.emit('close', null, 'SIGTERM')
    const result = await p
    expect(result.log.join('\n')).toMatch(/exceeded .*MB and was aborted/)
  })

  it('delegates the non-retained line-cap kill to the injected process killer', async () => {
    const killed: KillableProcess[] = []
    const killProcess = vi.fn((proc: KillableProcess) => {
      killed.push(proc)
    })
    const svc = makeService(undefined, undefined, undefined, killProcess)
    const p = svc.run(['--json', 'open'], { maxOutputBytes: 64, retainFileRecords: false })
    await flush()
    child.stdout.emit('data', Buffer.from('x'.repeat(100) + '\n' + SUMMARY_LINE))
    expect(killed).toEqual([child])
    expect(child.killed).toBe(false)
    child.emit('close', null, 'SIGTERM')
    const result = await p
    expect(result.log.join('\n')).toMatch(/exceeded .*MB and was aborted/)
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

  // 宽范围 get：file 记录只流过 onRecord，不囤、不计入上限；其余记录照旧受上限约束。
  it('streams file records past the byte cap when they are not retained', async () => {
    const svc = makeService()
    const seen: unknown[] = []
    const p = svc.run(['--json', 'open'], {
      maxOutputBytes: FILE_LINE.length * 2,
      retainFileRecords: false,
      onRecord: (record) => seen.push(record['kind']),
    })
    await flush()
    child.stdout.emit('data', Buffer.from(FILE_LINE.repeat(50)))
    child.stdout.emit('data', Buffer.from(SUMMARY_LINE))
    expect(child.killed).toBe(false)
    child.emit('close', 0, null)
    const result = await p
    expect(seen.filter((kind) => kind === 'file')).toHaveLength(50)
    expect(result.records.map((r) => r['kind'])).toEqual(['summary'])
    expect(result.sawSummary).toBe(true)
  })

  it('still aborts when the retained records outgrow the cap', async () => {
    const svc = makeService()
    const p = svc.run(['--json', 'open'], { maxOutputBytes: 64, retainFileRecords: false })
    await flush()
    child.stdout.emit('data', Buffer.from('x'.repeat(100) + '\n' + SUMMARY_LINE))
    expect(child.killed).toBe(true)
    child.emit('close', null, 'SIGTERM')
    const result = await p
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

/**
 * 流式诊断出口：这次改动的核心 seam。每一条都在钉「日志是**编辑器收到时**记下来的、
 * 分块也读得对、丢东西有痕迹、结束只发生一次」。
 */
describe('P4deltaService.run: the streaming log outlet', () => {
  let child: FakeChildProcess
  beforeEach(() => {
    child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
  })
  afterEach(() => {
    spawnMock.mockReset()
  })

  it('reports a per-run id before the child settles, on every outcome', async () => {
    const collected = collectingSink()
    const svc = makeService(undefined, undefined, collected.sink)
    const p = svc.run(['--json', 'open'])
    await flush()
    // 起手就有 runId：取消 / 崩溃 / 无 summary 的运行也要能被引用到日志。
    expect(collected.starts).toHaveLength(1)
    const runId = collected.starts[0]?.runId ?? ''
    expect(isSafeRunId(runId)).toBe(true)
    child.emit('close', 1, null)
    const result = await p
    expect(result.runId).toBe(runId)
    expect(result.startedAt).toBeLessThanOrEqual(Date.now())
    expect(collected.ends).toHaveLength(1)
    expect(collected.ends[0]?.status).toBe('failed')
  })

  it('gives each run its own id', async () => {
    const collected = collectingSink()
    const svc = makeService(undefined, undefined, collected.sink)
    const first = svc.run(['--json', 'open'])
    await flush()
    child.emit('close', 0, null)
    await first
    const second = svc.run(['--json', 'open'])
    await flush()
    child.emit('close', 0, null)
    await second
    const ids = collected.starts.map((s) => s.runId)
    expect(new Set(ids).size).toBe(2)
  })

  it('stamps every diagnostic line with local time, relative elapsed and the run id', async () => {
    const collected = collectingSink()
    const svc = makeService(undefined, undefined, collected.sink)
    const p = svc.run(['--json', 'open'])
    await flush()
    child.stderr.emit('data', Buffer.from('Checking digests for 340 files.\n'))
    child.emit('close', 0, null)
    await p
    const runId = collected.starts[0]?.runId ?? ''
    const line = collected.lines[0] ?? ''
    // 本地 ISO（带偏移）+ 单调相对耗时 + runId，三段都在同一行上。
    expect(line).toMatch(
      new RegExp(
        `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}[+-]\\d{2}:\\d{2} \\+\\d+\\.\\d{3}s ${runId} `,
      ),
    )
    expect(line).toContain('Checking digests for 340 files.')
  })

  it('keeps per-file records and call-count events out of the log, but writes the summary', async () => {
    const collected = collectingSink()
    const svc = makeService(undefined, undefined, collected.sink)
    const p = svc.run(['--json', '--sync', '-a'])
    await flush()
    child.stdout.emit(
      'data',
      Buffer.from(
        FILE_LINE +
          '{"kind":"p4CommandCount","count":7,"command":"fstat"}\n' +
          SUMMARY_LINE +
          '{"kind":"error","clientFile":"//main/a.ts","message":"boom"}\n',
      ),
    )
    child.emit('close', 0, null)
    await p
    const body = collected.lines.join('\n')
    expect(body).toContain('"kind":"summary"')
    expect(body).toContain('"kind":"error"')
    expect(body).not.toContain('"kind":"file"')
    expect(body).not.toContain('p4CommandCount')
  })

  it('keeps structured progress records on the same outlet, verbatim', async () => {
    const collected = collectingSink()
    const svc = makeService(undefined, undefined, collected.sink)
    const p = svc.run(['--json', 'open'])
    await flush()
    child.stderr.emit(
      'data',
      Buffer.from('{"kind":"progress","phase":"digest","step":3,"total":5}\n'),
    )
    child.emit('close', 0, null)
    await p
    expect(collected.lines.join('\n')).toContain('"step":3')
  })

  // 分块解码：一个中文文件名被 chunk 边界劈成两半时，逐块 toString 会得到替换字符。
  it('reassembles a multi-byte line split across chunks', async () => {
    const collected = collectingSink()
    const svc = makeService(undefined, undefined, collected.sink)
    const p = svc.run(['--json', 'open'])
    await flush()
    const bytes = Buffer.from('已更新 中文/路径.ts\n', 'utf8')
    // 切在一个汉字的中间字节上，正是真实读取会切到的地方。
    child.stderr.emit('data', bytes.subarray(0, 5))
    child.stderr.emit('data', bytes.subarray(5))
    child.emit('close', 0, null)
    await p
    expect(collected.lines.join('\n')).toContain('已更新 中文/路径.ts')
    expect(collected.lines.join('\n')).not.toContain('�')
  })

  it('reads a record whose bytes are split across chunks', async () => {
    const collected = collectingSink()
    const svc = makeService(undefined, undefined, collected.sink)
    const p = svc.run(['--json', 'open'])
    await flush()
    const bytes = Buffer.from('{"kind":"summary","ok":true,"mode":"open","reason":"混乱"}\n')
    child.stdout.emit('data', bytes.subarray(0, 30))
    child.stdout.emit('data', bytes.subarray(30))
    child.emit('close', 0, null)
    const result = await p
    expect(result.records).toEqual([{ kind: 'summary', ok: true, mode: 'open', reason: '混乱' }])
    expect(result.sawSummary).toBe(true)
  })

  // 超长残行不再无限累积：报一次前缀，丢掉这行剩下的部分，然后继续读下一行。
  it('bounds an unterminated line and resumes at the next newline', async () => {
    const collected = collectingSink()
    const svc = makeService(undefined, undefined, collected.sink)
    const p = svc.run(['--json', 'open'])
    await flush()
    child.stderr.emit('data', Buffer.from('x'.repeat(70_000)))
    child.stderr.emit('data', Buffer.from('tail of that same line\nnext line\n'))
    child.emit('close', 0, null)
    const result = await p
    const body = collected.lines.join('\n')
    expect(body).toContain('exceeds 65536 chars')
    expect(body).toContain('next line')
    // 被丢掉的那段尾巴不会伪装成一条新日志行。
    expect(body).not.toContain('tail of that same line')
    expect(result.log).toContain('next line')
  })

  it('flushes an unterminated final line when the child dies', async () => {
    const collected = collectingSink()
    const svc = makeService(undefined, undefined, collected.sink)
    const p = svc.run(['--json', 'open'])
    await flush()
    child.stderr.emit('data', Buffer.from('report without a trailing newline'))
    child.emit('close', null, 'SIGTERM')
    const result = await p
    expect(result.log).toEqual(['report without a trailing newline'])
    expect(collected.lines.join('\n')).toContain('report without a trailing newline')
  })

  // error 与 close 都会结束一次运行；双重结束会把同一个 run 的日志收尾写两遍。
  it('settles exactly once when error is followed by close', async () => {
    const collected = collectingSink()
    const svc = makeService(undefined, undefined, collected.sink)
    const p = svc.run(['--json', 'open'])
    await flush()
    child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    child.emit('close', null, null)
    const result = await p
    expect(result.runId).toBe(collected.starts[0]?.runId)
    expect(collected.ends).toHaveLength(1)
    expect(collected.ends[0]?.status).toBe('spawn-failed')
  })

  it('reports cancel, timeout and overflow as their own terminal states', async () => {
    const cancelled = collectingSink()
    const svcA = makeService(undefined, undefined, cancelled.sink)
    const controller = new AbortController()
    const a = svcA.run(['--json', 'open'], { signal: controller.signal })
    await flush()
    controller.abort()
    child.emit('close', null, 'SIGTERM')
    await a
    expect(cancelled.ends[0]?.status).toBe('cancelled')

    const timed = collectingSink()
    const svcB = makeService(undefined, undefined, timed.sink)
    const b = svcB.run(['--json', 'open'], { timeoutMs: 20 })
    await new Promise((r) => setTimeout(r, 40))
    child.emit('close', null, 'SIGTERM')
    await b
    expect(timed.ends[0]?.status).toBe('timeout')

    const over = collectingSink()
    const svcC = makeService(undefined, undefined, over.sink)
    const c = svcC.run(['--json', 'open'], { maxOutputBytes: 32 })
    await flush()
    child.stdout.emit('data', Buffer.from('y'.repeat(100) + '\n'))
    child.emit('close', null, 'SIGTERM')
    await c
    expect(over.ends[0]?.status).toBe('overflow')
  })

  // exit 0 但没有 summary 不是结论——日志上说清楚，别让「一切正常」的推断成立。
  it('calls out an exit-0 run with no summary', async () => {
    const collected = collectingSink()
    const svc = makeService(undefined, undefined, collected.sink)
    const p = svc.run(['--json', 'open'])
    await flush()
    child.emit('close', 0, null)
    const result = await p
    expect(result.sawSummary).toBe(false)
    expect(collected.ends[0]?.status).toBe('no-summary')
    expect(collected.ends[0]?.note).toContain('no conclusion')
  })

  it('survives a sink that throws on every call', async () => {
    const svc = makeService(undefined, undefined, {
      open: () => {
        throw new Error('channel exploded')
      },
      close: () => {
        throw new Error('channel exploded')
      },
    })
    const p = svc.run(['--json', 'open'])
    await flush()
    child.stderr.emit('data', Buffer.from('hello\n'))
    child.emit('close', 0, null)
    await expect(p).resolves.toMatchObject({ code: 0 })
  })

  // 没有注入 sink 时（单测、或没有存储目录的调用方），详细诊断退回 Perforce 频道——
  // 「诊断丢了」不能是一种静默的失败模式。
  it('falls back to the Perforce log when no outlet is injected', async () => {
    const logs: string[] = []
    const svc = makeService(undefined, (m) => logs.push(m))
    const p = svc.run(['--json', 'open'])
    await flush()
    child.stderr.emit('data', Buffer.from('digest report\n'))
    child.emit('close', 0, null)
    await p
    expect(logs.join('\n')).toContain('digest report')
  })

  it('keeps the start and exit summary on the Perforce log, with the run id', async () => {
    const logs: string[] = []
    const collected = collectingSink()
    const svc = makeService(undefined, (m) => logs.push(m), collected.sink)
    const p = svc.run(['--json', '--sync', '-a'])
    await flush()
    child.stderr.emit('data', Buffer.from('a long human report\n'))
    child.emit('close', 0, null)
    await p
    const text = logs.join('\n')
    const runId = collected.starts[0]?.runId ?? ''
    expect(text).toContain(`[${runId}]`)
    expect(text).toMatch(/exit 0 \(/)
    // 详细报告只在 P4delta 频道里——Perforce 频道保留的是开始/结束摘要。
    expect(text).not.toContain('a long human report')
  })
})

/**
 * 行读取器的封顶：上限对「完整行」与「残行」必须同一把尺子，任何一条回调抛异常都不能
 * 从 data 处理器里逃出去（宿主崩溃红线 4）。
 */
describe('createP4deltaLineReader: bounded lines', () => {
  it('caps a complete overlong line, not only an unterminated one', () => {
    const lines: string[] = []
    const long: string[] = []
    const reader = createP4deltaLineReader(
      (line) => lines.push(line),
      (preview) => long.push(preview),
    )
    // 超长行与换行、下一行在同一个 chunk 里：旧实现只查 nl<0 的路径，会把 7 万字符整行原样
    // 交出去，既没封顶也没留痕。
    reader.push(Buffer.from(`${'x'.repeat(70_000)}\nnext line\n`))
    reader.flush()
    expect(long).toEqual(['x'.repeat(65_536)])
    expect(lines).toEqual(['next line'])
  })

  it('does not let a throwing onLongLine escape the reader', () => {
    const reader = createP4deltaLineReader(
      () => {},
      () => {
        throw new Error('consumer exploded')
      },
    )
    expect(() => reader.push(Buffer.from(`${'x'.repeat(70_000)}\n`))).not.toThrow()
    expect(() => reader.push(Buffer.from('y'.repeat(70_000)))).not.toThrow()
    expect(() => reader.flush()).not.toThrow()
  })
})

/** 内存里的 stderr 尾必须**有界**：一次宽 get 的报告有几千行，不能一直挂到 run 结束。 */
describe('P4deltaLogTail', () => {
  it('drops from the head past the line cap and the byte cap', () => {
    const byLines = new P4deltaLogTail(3, 1_000)
    for (const line of ['a', 'b', 'c', 'd']) byLines.push(line)
    expect(byLines.snapshot()).toEqual(['b', 'c', 'd'])

    const byBytes = new P4deltaLogTail(100, 5)
    byBytes.push('aaaa')
    byBytes.push('bbbb')
    expect(byBytes.snapshot()).toEqual(['bbbb'])
  })

  it('always keeps the newest line, even when it alone exceeds the byte cap', () => {
    // 单行已由 reader 封顶；这里再超也只是保留它，绝不把整条 tail 清空。
    const tail = new P4deltaLogTail(100, 2)
    tail.push('xx')
    tail.push('a line well beyond the tiny cap')
    expect(tail.snapshot()).toEqual(['a line well beyond the tiny cap'])
  })
})

describe('P4deltaLogTail in the service', () => {
  let child: FakeChildProcess
  beforeEach(() => {
    child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
  })
  afterEach(() => {
    spawnMock.mockReset()
  })

  it('bounds result.log while still streaming every line to the sink', async () => {
    const collected = collectingSink()
    const svc = makeService(undefined, undefined, collected.sink)
    const p = svc.run(['--json', 'open'])
    await flush()
    for (let i = 0; i < 500; i++) child.stderr.emit('data', Buffer.from(`line ${i}\n`))
    child.emit('close', 0, null)
    const result = await p
    expect(result.log.length).toBeLessThanOrEqual(200)
    expect(result.log.at(-1)).toBe('line 499')
    expect(result.log).not.toContain('line 0')
    // 逐行诊断一条不落——砍的只是内存里那份事后回读。
    expect(collected.lines.filter((l) => l.endsWith('line 0'))).toHaveLength(1)
    expect(collected.lines.filter((l) => l.endsWith('line 499'))).toHaveLength(1)
  })
})

/**
 * summary 的**有界摘要**：正文被截断后，终态页脚仍要答得出「这 N 次调用花在哪」。
 */
describe('formatP4deltaSummaryFooter', () => {
  it('picks only the bounded command-stat fields', () => {
    expect(
      formatP4deltaSummaryFooter({
        kind: 'summary',
        mode: 'sync',
        ok: true,
        applied: true,
        total: 12,
        counts: { update: 12 },
        elapsedMs: 1234,
        p4Calls: 37,
        p4CallsByCommand: { fstat: 30, sync: 7 },
        reason: null,
        scopeMatched: 12,
        unmatched: 0,
      }),
    ).toBe(
      '# summary: mode=sync ok=true applied=true total=12 elapsedMs=1234 p4Calls=37 ' +
        'p4CallsByCommand=fstat 30 · sync 7 counts=update 12',
    )
  })

  it('returns nothing when the record has no bounded field to report', () => {
    expect(formatP4deltaSummaryFooter({ kind: 'summary' })).toBeUndefined()
  })

  it('leaves a throwing-free, truncated string for an over-long record', () => {
    const footer = formatP4deltaSummaryFooter({
      kind: 'summary',
      mode: 'm'.repeat(20_000),
      p4Calls: 1,
    })
    expect(footer).toBeDefined()
    expect(footer!.length).toBe(8 * 1024 + 1) // cap + the '…' suffix
  })
})

describe('P4deltaService: the summary footer reaches close()', () => {
  let child: FakeChildProcess
  beforeEach(() => {
    child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
  })
  afterEach(() => {
    spawnMock.mockReset()
  })

  it('summarises the run’s command stats, not the raw record', async () => {
    const collected = collectingSink()
    const svc = makeService(undefined, undefined, collected.sink)
    const p = svc.run(['--json', '--sync', '-a'])
    await flush()
    child.stdout.emit(
      'data',
      Buffer.from(
        '{"kind":"summary","mode":"sync","ok":true,"applied":true,"total":12,' +
          '"counts":{"update":12},"elapsedMs":1234,"p4Calls":37,' +
          '"p4CallsByCommand":{"fstat":30,"sync":7},"reason":null}\n',
      ),
    )
    child.emit('close', 0, null)
    await p
    const summary = collected.ends[0]?.summary ?? ''
    expect(summary).toContain('mode=sync')
    expect(summary).toContain('p4Calls=37')
    expect(summary).toContain('p4CallsByCommand=fstat 30 · sync 7')
    expect(summary).toContain('counts=update 12')
    expect(summary).toContain('elapsedMs=1234')
  })

  it('carries no summary footer when the stream never concluded', async () => {
    const collected = collectingSink()
    const svc = makeService(undefined, undefined, collected.sink)
    const p = svc.run(['--json', 'open'])
    await flush()
    child.emit('close', 1, null)
    await p
    expect(collected.ends[0]?.summary).toBeUndefined()
  })
})
