/**
 * `checkIgnore` (host capability `perforce.checkIgnore`): the batch read that
 * dims Explorer rows / editor tabs whose paths the client's ignore rules
 * exclude. Pinned here: the `p4 ignores -i` argv carrying every path; the tight
 * 20s ceiling with background (never interactive) priority; chunking by
 * command-line length; the connection guard (an offline client answers "nothing
 * ignored" with zero spawns); per-batch failure isolation; the fstat depot
 * filter (an in-depot non-delete head is dropped, a delete head is kept, a
 * partial fstat still filters with the records it did get, and a connection loss
 * mid-filter reports nothing); and the reverse-lookup guarantee that results
 * are byte-equal to the input strings even when p4 echoes a differently-cased /
 * backslashed path.
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
      setSupplementaryDecorations: () => {},
      dispose() {},
    }),
    executeCommand: () => Promise.resolve(undefined),
  }
}

const { PerforceClient } = await import('../client.js')
const { ConcurrencyGate } = await import('../concurrency.js')
const { P4Service } = await import('../p4Service.js')
import type { PerforceClient as PerforceClientType } from '../client.js'
import type { P4ExecOptions } from '../p4Service.js'

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const ROOT_FWD = process.platform === 'win32' ? 'C:/ws' : '/ws'

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

const spawned: string[][] = []

function respond(handler: (argv: string[]) => Reply): void {
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = expandP4Argv((args[1] as string[]) ?? [])
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

function isIgnores(argv: string[]): boolean {
  return subcommand(argv) === 'ignores'
}

/** Path args after `-i` in an `ignores` argv. */
function ignoresPathArgs(argv: string[]): string[] {
  const tail = argv.slice(argv.indexOf('ignores') + 1)
  const i = tail.indexOf('-i')
  return i >= 0 ? tail.slice(i + 1) : []
}

async function makeClient(extra?: (argv: string[]) => Reply): Promise<PerforceClientType> {
  respond((argv) => {
    const cmd = subcommand(argv)
    if (cmd === 'info') return { stdout: DISCOVERY }
    return extra?.(argv) ?? { stdout: '' }
  })
  const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
    enabled: true,
    workspaceTtlMs: 4000,
  })
  expect(client).toBeDefined()
  return client!
}

beforeEach(() => {
  installBridge()
  spawnMock.mockReset()
  spawned.length = 0
})
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  spawnMock.mockReset()
})

describe('PerforceClient.checkIgnore', () => {
  it('runs `p4 ignores -i` with every path', async () => {
    const paths = [`${ROOT_FWD}/a.txt`, `${ROOT_FWD}/b.txt`]
    const client = await makeClient()
    await client.checkIgnore(paths)
    const ignoresArgvs = spawned.filter(isIgnores)
    expect(ignoresArgvs).toHaveLength(1)
    expect(ignoresPathArgs(ignoresArgvs[0]!)).toEqual(paths)
    client.dispose()
  })

  it('passes a 20s timeout and never interactive priority', async () => {
    const execSpy = vi.spyOn(P4Service.prototype, 'exec')
    try {
      const paths = [`${ROOT_FWD}/a.txt`]
      const client = await makeClient()
      await client.checkIgnore(paths)
      const ignoresCalls = execSpy.mock.calls.filter(
        ([args]) => (args as string[])[0] === 'ignores',
      )
      expect(ignoresCalls).toHaveLength(1)
      const options = ignoresCalls[0]![1] as P4ExecOptions | undefined
      expect(options?.timeoutMs).toBe(20_000)
      expect(options?.priority).toBeUndefined()
      client.dispose()
    } finally {
      execSpy.mockRestore()
    }
  })

  it('chunks oversized path sets into multiple `ignores` batches', async () => {
    const paths = Array.from(
      { length: 100 },
      (_, i) => `${ROOT_FWD}/bulk/${'x'.repeat(180)}/f${i}.txt`,
    )
    const client = await makeClient((argv) => {
      if (subcommand(argv) === 'ignores') {
        return {
          stdout:
            ignoresPathArgs(argv)
              .map((p) => `${p} ignored`)
              .join('\n') + '\n',
        }
      }
      return { stdout: '' }
    })
    const out = await client.checkIgnore(paths)
    expect(out.sort()).toEqual([...paths].sort())
    const ignoresArgvs = spawned.filter(isIgnores)
    expect(ignoresArgvs.length).toBeGreaterThan(1)
    expect(ignoresArgvs.flatMap((a) => ignoresPathArgs(a)).sort()).toEqual([...paths].sort())
    client.dispose()
  })

  it('answers empty with zero spawns while disconnected', async () => {
    const client = await makeClient((argv) => {
      if (subcommand(argv) === 'opened') {
        return {
          stderr: 'Connect to server failed; TCP connect to 192.0.2.1:1666 failed.',
          exit: 1,
        }
      }
      return { stdout: '' }
    })
    await client.refresh()
    expect(client.status.connection).toBe('offline')
    spawned.length = 0
    expect(await client.checkIgnore([`${ROOT_FWD}/a.txt`])).toEqual([])
    expect(spawned.filter(isIgnores)).toHaveLength(0)
    client.dispose()
  })

  it('keeps the other batch when one `ignores` batch fails', async () => {
    const a = `${ROOT_FWD}/bulk/${'x'.repeat(5000)}a.txt`
    const b = `${ROOT_FWD}/bulk/${'x'.repeat(5000)}b.txt`
    let ignoresCalls = 0
    const client = await makeClient((argv) => {
      if (subcommand(argv) === 'ignores') {
        ignoresCalls++
        if (ignoresCalls === 1) return { stderr: 'some unrelated error', exit: 1 }
        return { stdout: `${b} ignored\n` }
      }
      return { stdout: '' }
    })
    expect(await client.checkIgnore([a, b])).toEqual([b])
    expect(ignoresCalls).toBe(2)
    client.dispose()
  })

  it('drops in-depot candidates via fstat, keeps a delete head', async () => {
    const a = `${ROOT_FWD}/a.txt`
    const b = `${ROOT_FWD}/b.txt`
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'ignores') return { stdout: `${a} ignored\n${b} ignored\n` }
      if (cmd === 'fstat') {
        return {
          stdout: `${JSON.stringify({ clientFile: a, headAction: 'edit' })}\n${JSON.stringify({ clientFile: b, headAction: 'delete' })}\n`,
        }
      }
      return { stdout: '' }
    })
    expect(await client.checkIgnore([a, b])).toEqual([b])
    client.dispose()
  })

  it('keeps all candidates when the fstat filter answers nothing', async () => {
    const a = `${ROOT_FWD}/a.txt`
    const b = `${ROOT_FWD}/b.txt`
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'ignores') return { stdout: `${a} ignored\n${b} ignored\n` }
      if (cmd === 'fstat') return { stderr: 'fstat failed', exit: 1 }
      return { stdout: '' }
    })
    expect(await client.checkIgnore([a, b])).toEqual([a, b])
    client.dispose()
  })

  // The regression that makes the depot filter real. On a live server this exit
  // code is the NORMAL case: the batch is mostly local-only files and `p4 fstat`
  // exits non-zero as soon as one argument matches nothing, while still printing
  // records for the files it knew. Early-returning on the exit code would leave
  // the in-depot file in the result and dim controlled content — and every other
  // test here would still pass, because they all feed fstat a clean batch.
  it('still drops in-depot candidates when fstat exits non-zero for the local-only ones', async () => {
    const controlled = `${ROOT_FWD}/generated.txt`
    const localOnly = `${ROOT_FWD}/build/output.log`
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'ignores') return { stdout: `${controlled} ignored\n${localOnly} ignored\n` }
      if (cmd === 'fstat') {
        return {
          stdout: `${JSON.stringify({ clientFile: controlled, headAction: 'edit' })}\n`,
          stderr: `${localOnly} - no such file(s).\n`,
          exit: 1,
        }
      }
      return { stdout: '' }
    })
    expect(await client.checkIgnore([controlled, localOnly])).toEqual([localOnly])
    client.dispose()
  })

  // Losing the connection between the two passes must not publish the unfiltered
  // candidate list: the host caches that verdict, so controlled files would stay
  // dimmed until the next invalidation.
  it('reports nothing and goes offline when the fstat filter loses the connection', async () => {
    const a = `${ROOT_FWD}/a.txt`
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'ignores') return { stdout: `${a} ignored\n` }
      if (cmd === 'fstat') {
        return {
          stderr: 'Connect to server failed; TCP connect to 192.0.2.1:1666 failed.',
          exit: 1,
        }
      }
      return { stdout: '' }
    })
    expect(await client.checkIgnore([a])).toEqual([])
    expect(client.status.connection).toBe('offline')
    client.dispose()
  })

  it('returns byte-equal input strings despite a differently-cased/backslashed echo', async () => {
    const input = process.platform === 'win32' ? 'C:/ws/builds/a.txt' : '/ws/builds/a.txt'
    const echo =
      process.platform === 'win32' ? 'c:\\ws\\builds\\a.txt ignored' : '/ws/builds/a.txt ignored'
    const client = await makeClient((argv) => {
      if (subcommand(argv) === 'ignores') return { stdout: `${echo}\n` }
      return { stdout: '' }
    })
    expect(await client.checkIgnore([input])).toEqual([input])
    client.dispose()
  })
})
