/**
 * Regression: reopening a *submitted* changelist in the Perforce Graph must not
 * re-hit the server. The describe half was cached immutably, but the depot→local
 * `where` resolution ran on every open and, once its short TTL lapsed (~20-30s),
 * re-spawned `p4 where` — so reopening a change after a pause round-tripped again.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A controllable fake child process (mirrors p4Service.test.ts).
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

// Minimal host bridge so scm.createSourceControl works off the extension host.
const BRIDGE_KEY = '__universeExtensionHostBridge__'
function installScmBridge(): void {
  const group = () => ({
    id: '',
    label: '',
    hideWhenEmpty: undefined,
    resourceStates: [],
    dispose() {},
  })
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
      createResourceGroup: group,
      dispose() {},
    }),
  }
}

const { PerforceClient } = await import('../client.js')
const { ConcurrencyGate } = await import('../concurrency.js')

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'

/** Feed a command's stdout/exit through the next spawned fake child. `argv` is the
 *  full p4 argv (globals + subcommand); we route by matching the subcommand. */
function respond(handler: (argv: string[]) => { stdout: string; exit?: number }): void {
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[1] as string[]) ?? []
    const child = new FakeChildProcess()
    queueMicrotask(() => {
      const { stdout, exit } = handler(argv)
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      child.emit('close', exit ?? 0)
    })
    return child
  })
}

/** Which p4 subcommand an argv is (skips `-Mj`/`-ztag`/global option pairs). */
function subcommand(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-Mj' || a === '-ztag') continue
    if (a === '-p' || a === '-u' || a === '-c') {
      i++ // skip its value
      continue
    }
    return a
  }
  return undefined
}

describe('PerforceClient graph change-detail caching', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  it('reopening a submitted change re-hits neither describe nor where after the where TTL lapses', async () => {
    let clock = 1000
    const now = () => clock

    let describeCalls = 0
    let whereCalls = 0
    respond((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'info') {
        // -ztag info drives discovery; the ambient client owns ROOT.
        return { stdout: `... clientName testclient\n... clientRoot ${ROOT}\n... userName bob\n\n` }
      }
      if (cmd === 'describe') {
        describeCalls++
        return {
          stdout: JSON.stringify({
            change: '12345',
            user: 'bob',
            client: 'testclient',
            time: '1700000000',
            desc: 'a submitted change',
            depotFile0: '//depot/a.txt',
            action0: 'edit',
            rev0: '3',
          }),
        }
      }
      if (cmd === 'where') {
        whereCalls++
        return {
          stdout: JSON.stringify({
            depotFile: '//depot/a.txt',
            clientFile: '//testclient/a.txt',
            path: `${ROOT}/a.txt`,
          }),
        }
      }
      return { stdout: '' }
    })

    const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
      enabled: true,
      workspaceTtlMs: 4000,
      now,
    })
    expect(client).toBeDefined()

    // First open: one describe + one where.
    const first = await client!.getGraphChangeDetails('12345')
    expect(first?.localPaths.get('//depot/a.txt')).toBe(`${ROOT}/a.txt`)
    expect(describeCalls).toBe(1)
    expect(whereCalls).toBe(1)

    // Reopen immediately (well inside any TTL): pure cache hit.
    await client!.getGraphChangeDetails('12345')
    expect(describeCalls).toBe(1)
    expect(whereCalls).toBe(1)

    // Advance past the `where` TTL (Math.max(workspaceTtl, 30_000)) — before the
    // fix this re-spawned `p4 where`.
    clock += 60_000
    const third = await client!.getGraphChangeDetails('12345')
    expect(third?.localPaths.get('//depot/a.txt')).toBe(`${ROOT}/a.txt`)
    expect(describeCalls).toBe(1)
    expect(whereCalls).toBe(1)

    client!.dispose()
  })
})
