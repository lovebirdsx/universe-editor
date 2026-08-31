/**
 * Invariant: every click/hover-triggered p4 read really dispatches with
 * `priority: 'interactive'`, so it uses the ConcurrencyGate's reserved slot and
 * jumps ahead of a background fan-out instead of queuing behind it (the
 * minutes-long diff-open wedge). `concurrency.test.ts` / `p4Service.test.ts`
 * prove the mechanism (the gate has a reserved slot; `P4ExecOptions.priority`
 * threads to spawn); this pins that each concrete client path actually opts in.
 * Deleting one `INTERACTIVE_EXEC` here would otherwise silently regress to the
 * wedge with every existing test still green — so the assertion targets the
 * behaviour (the dispatched command carries interactive priority), not a private
 * field.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { P4Priority } from '../concurrency.js'

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
const FILE = process.platform === 'win32' ? 'C:/ws/tracked.txt' : '/ws/tracked.txt'
const DEPOT = '//depot/tracked.txt'

/** Records the `priority` of every `run` call, in call order. One `run` maps to
 *  one `spawn` (the task is `_spawn`), so index-aligned with the spawn recorder. */
class RecordingGate extends ConcurrencyGate {
  readonly priorities: P4Priority[] = []
  override async run<T>(
    task: () => Promise<T>,
    priority: P4Priority = 'background',
    onStart?: (waitedMs: number) => void,
  ): Promise<T> {
    this.priorities.push(priority)
    return super.run(task, priority, onStart)
  }
}

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

/** `p4 -ztag annotate -c -q`: two lines owned by two changelists. */
const ANNOTATE_ZTAG = [
  '... depotFile //depot/tracked.txt',
  '... rev 3',
  '... change 42',
  '... action edit',
  '... type text',
  '... time 1748000000',
  '',
  '... upper 40',
  '... lower 40',
  '... data line one',
  '',
  '... upper 42',
  '... lower 42',
  '... data line two',
  '',
  '',
].join('\n')

/** `p4 -ztag changes -l <file>`: the file's own changelist history. */
const CHANGES_ZTAG = [
  '... change 42',
  '... time 1748100000',
  '... user alice',
  '... client ws',
  '... status submitted',
  '... changeType public',
  '... desc seed the tracked file',
  '',
  '',
].join('\n')

const DESCRIBE_JSON = JSON.stringify({
  change: '12345',
  user: 'bob',
  client: 'testclient',
  time: '1700000000',
  desc: 'a change',
  depotFile0: '//depot/tracked.txt',
  action0: 'edit',
  rev0: '3',
})

const OPENED_JSON = JSON.stringify({
  depotFile: '//depot/tracked.txt',
  clientFile: '//testclient/tracked.txt',
  action: 'edit',
  rev: '1',
  change: 'default',
})

const FSTAT_JSON = JSON.stringify({ depotFile: DEPOT, clientFile: FILE, haveRev: '3' })

interface Case {
  name: string
  invoke: (client: PerforceClientInstance) => Promise<unknown>
  /** p4 subcommands that must dispatch with `priority: 'interactive'`. */
  interactive: string[]
  /** stdout keyed by subcommand, for commands whose empty output would short-circuit
   *  the method before it reaches a later p4 call under test (describe/opened/fstat). */
  seed?: Record<string, string>
}

const cases: Case[] = [
  {
    name: 'getFilelog (Timeline view / active-editor switch)',
    invoke: (c) => c.getFilelog(DEPOT, 10),
    interactive: ['filelog'],
  },
  {
    name: 'getGraphChanges (open the Perforce Graph)',
    invoke: (c) => c.getGraphChanges(10, '//...'),
    interactive: ['changes'],
  },
  {
    name: 'getGraphChangeDetails (click a graph node)',
    invoke: (c) => c.getGraphChangeDetails('12345'),
    interactive: ['describe', 'where'],
    seed: { describe: DESCRIBE_JSON },
  },
  {
    name: 'getPendingCount (graph pending node)',
    invoke: (c) => c.getPendingCount(),
    interactive: ['opened'],
  },
  {
    name: 'getOpenedForGraph (graph pending files)',
    invoke: (c) => c.getOpenedForGraph(),
    interactive: ['opened', 'where'],
    seed: { opened: OPENED_JSON },
  },
  {
    name: 'describeChangeFiles (expand a Swarm review file list)',
    invoke: (c) => c.describeChangeFiles('900'),
    interactive: ['describe', 'where'],
    seed: { describe: DESCRIBE_JSON },
  },
  {
    name: 'getBlame (annotate + changes -l)',
    invoke: (c) => c.getBlame(FILE),
    interactive: ['annotate', 'changes'],
    seed: { annotate: ANNOTATE_ZTAG, changes: CHANGES_ZTAG },
  },
  {
    name: 'differsFromHave (Timeline pending probe)',
    invoke: (c) => c.differsFromHave(FILE),
    interactive: ['diff'],
  },
  {
    name: 'fstat (Timeline / dirty-diff gutter)',
    invoke: (c) => c.fstat(FILE),
    interactive: ['fstat'],
  },
  {
    name: 'listUserClients (switch-workspace quick-pick)',
    invoke: (c) => c.listUserClients(),
    interactive: ['clients'],
  },
  {
    name: 'printRevision (file revision content for a diff)',
    invoke: (c) => c.printRevision(`${DEPOT}#3`),
    interactive: ['print'],
  },
  {
    name: 'getHeadContent (dirty-diff baseline: fstat + print)',
    invoke: (c) => c.getHeadContent(FILE),
    interactive: ['fstat', 'print'],
    seed: { fstat: FSTAT_JSON },
  },
  {
    name: 'openMergeEditor (3-way merge editor open: fstat + print)',
    invoke: (c) => c.openMergeEditor(FILE),
    interactive: ['fstat', 'print'],
    seed: { fstat: FSTAT_JSON },
  },
]

describe('interactive p4 reads dispatch with priority interactive', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
    spawnMock.mockReset()
  })

  for (const c of cases) {
    it(c.name, async () => {
      const gate = new RecordingGate(4)
      const spawns: string[][] = []
      spawnMock.mockImplementation((...args: unknown[]) => {
        const argv = (args[1] as string[]) ?? []
        spawns.push(argv)
        const child = new FakeChildProcess()
        queueMicrotask(() => {
          const cmd = subcommand(argv)
          let stdout = ''
          if (cmd === 'info') {
            stdout = `... clientName testclient\n... clientRoot ${ROOT}\n... userName bob\n\n`
          } else if (cmd && c.seed?.[cmd]) {
            stdout = c.seed[cmd]!
          }
          if (stdout) child.stdout.emit('data', Buffer.from(stdout))
          child.emit('close', 0)
        })
        return child
      })

      const client = await PerforceClient.create(ROOT, {}, gate, {
        enabled: true,
        workspaceTtlMs: 4000,
      })
      expect(client).toBeDefined()
      // Drop discovery's `info` command from the recorders.
      spawns.length = 0
      gate.priorities.length = 0

      await c.invoke(client!)

      for (const cmd of c.interactive) {
        const idx = spawns.findIndex((argv) => subcommand(argv) === cmd)
        expect(idx, `${c.name}: ${cmd} should be spawned`).toBeGreaterThanOrEqual(0)
        expect(
          gate.priorities[idx],
          `${c.name}: ${cmd} should carry 'interactive' priority, got ${gate.priorities[idx]}`,
        ).toBe('interactive')
      }

      client!.dispose()
    })
  }
})
