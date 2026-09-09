/**
 * Invariant: every content-transfer mutation dispatches with `timeoutMs: 0` so the
 * `commandTimeout` watchdog is disarmed (a whole-repo sync/submit legitimately runs
 * far past 600s and must not be killed mid-transfer), while every metadata/scan
 * mutation keeps its timeout (the watchdog exists precisely for those — a
 * seconds-long scan overrunning is contention, not bulk I/O).
 *
 * The recorder is a streaming line collector: every content-transfer path streams
 * its stdout (`onStdoutLine`, the fix for the 256MB output cap), so p4Service
 * skips buffering it — but each spawned child's stdout 'data' handler is the
 * per-line sink. `subcommand(child)` keys the line to the command that ran it,
 * which is also how the watchdog's `timeoutMs` is observed per spawn (one spawn
 * per `run`, index-aligned via the child identity).
 *
 * Pinning the *dispatched options* (not the private constant) means deleting a
 * `CONTENT_TRANSFER_EXEC` spread in client.ts fails here even with every other
 * test green.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { P4ExecOptions, P4ExecResult } from '../p4Service.js'

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
    executeCommand: () => Promise.resolve(undefined),
  }
}

const { PerforceClient } = await import('../client.js')
const { ConcurrencyGate } = await import('../concurrency.js')
type PerforceClientInstance = import('../client.js').PerforceClient

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const ROOT_FWD = process.platform === 'win32' ? 'C:/ws' : '/ws'
const FILE = `${ROOT_FWD}/tracked.txt`
const DEPOT = '//depot/tracked.txt'

function subcommand(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-Mj' || a === '-ztag') continue
    if (a === '-p' || a === '-u' || a === '-c' || a === '-x') {
      i++ // skip its value
      continue
    }
    return a
  }
  return undefined
}

/**
 * Observe each spawned command's effective watchdog timeout. A streaming command
 * (every content transfer) registers a per-line stdout sink — the handler p4Service
 * attaches — so one apiece is enough to tag the spawn. We can't read `timeoutMs`
 * off the child, so instead the FakeChildProcess records which `subcommand` each
 * spawn ran and the test re-derives the expectation from the invariant table.
 *
 * What this file actually pins is simpler and stronger: the client passes
 * `timeoutMs: 0` down to `_spawn`, where it disarms the watchdog. That hand-off is
 * asserted by spying on `P4Service.prototype.exec` for the exact options object.
 */
interface SpawnRecord {
  cmd: string
  argv: string[]
}

interface Case {
  name: string
  invoke: (client: PerforceClientInstance) => Promise<unknown>
  /** The mutation subcommand(s) this call dispatches that must carry `timeoutMs: 0`. */
  transfer: string[]
  /** Mutation subcommand(s) that must NOT carry a content-transfer timeout. */
  metadata?: string[]
}

const cases: Case[] = [
  {
    name: 'sync (whole-repo get)',
    invoke: (c) => c.sync('#head'),
    transfer: ['sync'],
  },
  {
    name: 'syncFiles (per-file get)',
    invoke: (c) => c.syncFiles([FILE], '#head'),
    transfer: ['sync'],
  },
  {
    name: 'revert (restore have revision)',
    invoke: (c) => c.revert([FILE]),
    transfer: ['revert'],
  },
  {
    name: 'revertChangelist',
    invoke: (c) => c.revertChangelist('42'),
    transfer: ['revert'],
  },
  {
    name: 'submit (default changelist)',
    invoke: (c) => c.submit('default', 'a description'),
    transfer: ['submit'],
  },
  {
    name: 'submit (numbered changelist)',
    invoke: (c) => c.submit('42'),
    transfer: ['submit'],
  },
  {
    name: 'shelve',
    invoke: (c) => c.shelve('42'),
    transfer: ['shelve'],
  },
  {
    name: 'unshelve',
    invoke: (c) => c.unshelve('42'),
    transfer: ['unshelve'],
  },
  {
    name: 'unshelveFile',
    invoke: (c) => c.unshelveFile('42', DEPOT),
    transfer: ['unshelve'],
  },
  {
    name: 'unshelveByNumber',
    invoke: (c) => c.unshelveByNumber('42'),
    transfer: ['unshelve'],
  },
  {
    name: 'unshelveFiles (subset restore)',
    invoke: (c) => c.unshelveFiles('42', [DEPOT]),
    transfer: ['unshelve'],
  },
  {
    name: 'clean (revertReconcile — discard working-tree drift)',
    invoke: (c) => c.revertReconcile([FILE]),
    transfer: ['clean'],
  },
  // --- Metadata / scan mutations: keep the `commandTimeout` watchdog. ---
  {
    name: 'edit (open for edit — metadata)',
    invoke: (c) => c.edit([FILE]),
    transfer: [],
    metadata: ['edit'],
  },
  {
    name: 'add (open for add — metadata)',
    invoke: (c) => c.add([FILE]),
    transfer: [],
    metadata: ['add'],
  },
  {
    name: 'delete (open for delete — metadata)',
    invoke: (c) => c.delete([FILE]),
    transfer: [],
    metadata: ['delete'],
  },
  {
    name: 'revertUnchanged (revert -a — scan)',
    invoke: (c) => c.revertUnchanged(),
    transfer: [],
    metadata: ['revert'],
  },
  {
    name: 'deleteChangelist (change -d — metadata)',
    invoke: (c) => c.deleteChangelist('42'),
    transfer: [],
    metadata: ['change'],
  },
]

describe('content-transfer mutations disarm the watchdog; metadata mutations keep it', () => {
  const spawns: SpawnRecord[] = []
  let execSpy: MockInstance<
    (args: readonly string[], options?: P4ExecOptions | undefined) => Promise<P4ExecResult>
  >

  beforeEach(async () => {
    installScmBridge()
    spawnMock.mockReset()
    spawns.length = 0
    spawnMock.mockImplementation((...args: unknown[]) => {
      const argv = (args[1] as string[]) ?? []
      const cmd = subcommand(argv) ?? ''
      spawns.push({ cmd, argv })
      const child = new FakeChildProcess()
      queueMicrotask(() => {
        if (cmd === 'info') {
          child.stdout.emit(
            'data',
            Buffer.from(`... clientName testclient\n... clientRoot ${ROOT}\n... userName bob\n\n`),
          )
        }
        child.emit('close', 0)
      })
      return child
    })
    const { P4Service } = await import('../p4Service.js')
    execSpy = vi.spyOn(P4Service.prototype, 'exec')
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
    spawnMock.mockReset()
    execSpy.mockRestore()
  })

  for (const c of cases) {
    it(c.name, async () => {
      const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
        enabled: true,
        workspaceTtlMs: 4000,
      })
      expect(client).toBeDefined()
      spawns.length = 0
      execSpy.mockClear()

      await c.invoke(client!)

      // Read the effective options each mutation dispatched with, straight from the
      // spy — `timeoutMs: 0` is the disarm-the-watchdog signal this file pins.
      const timeoutByCmd = new Map<string, Array<number | undefined>>()
      for (const call of execSpy.mock.calls) {
        const [argv, options] = call
        const cmd = subcommand([...argv])
        if (!cmd) continue
        const list = timeoutByCmd.get(cmd) ?? []
        list.push(options?.timeoutMs)
        timeoutByCmd.set(cmd, list)
      }

      for (const cmd of c.transfer) {
        const timeouts = timeoutByCmd.get(cmd) ?? []
        expect(timeouts.length, `${c.name}: ${cmd} should be dispatched via exec`).toBeGreaterThan(
          0,
        )
        for (const t of timeouts) {
          expect(t, `${c.name}: ${cmd} must carry timeoutMs: 0 (CONTENT_TRANSFER_EXEC)`).toBe(0)
        }
      }
      for (const cmd of c.metadata ?? []) {
        const timeouts = timeoutByCmd.get(cmd) ?? []
        expect(timeouts.length, `${c.name}: ${cmd} should be dispatched via exec`).toBeGreaterThan(
          0,
        )
        for (const t of timeouts) {
          expect(
            t,
            `${c.name}: metadata ${cmd} must NOT be exempt from commandTimeout (timeoutMs: 0)`,
          ).not.toBe(0)
        }
      }

      client!.dispose()
    })
  }
})
