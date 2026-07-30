/**
 * Regression: `getBlame` must not source changelist metadata from
 * `p4 describe -s <cl>`. A describe lists *every file in the changelist*; on a
 * giant branch changelist (hundreds of thousands of files) the output is
 * gigabytes and the command never returns (observed >3min on a real server),
 * so the blame promise never resolved and inline blame stayed blank. Metadata
 * now comes from one `p4 changes -l <file>` (the file's own history — small),
 * so a hung describe can't stall blame.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A controllable fake child process (mirrors clientGraphCache.test.ts).
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
const FILE = `${ROOT}/tracked.txt`

/** Route each spawned fake child by p4 subcommand; `undefined` stdout = hang forever. */
function respond(handler: (argv: string[]) => { stdout: string; exit?: number } | 'hang'): void {
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[1] as string[]) ?? []
    const child = new FakeChildProcess()
    queueMicrotask(() => {
      const r = handler(argv)
      if (r === 'hang') return // never closes: the giant-changelist describe
      if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout))
      child.emit('close', r.exit ?? 0)
    })
    return child
  })
}

function subcommand(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-Mj' || a === '-ztag') continue
    if (a === '-p' || a === '-u' || a === '-c') {
      i++
      continue
    }
    return a
  }
  return undefined
}

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
  '... upper 42',
  '... lower 42',
  '... data line three',
  '',
  '',
].join('\n')

/** `p4 -ztag changes -l <file>`: one record per changelist in the file's history. */
const CHANGES_ZTAG = [
  '... change 42',
  '... time 1748100000',
  '... user alice',
  '... client ws',
  '... status submitted',
  '... changeType public',
  '... path //depot/...',
  '... desc seed the tracked file',
  '',
  '... change 40',
  '... time 1748000000',
  '... user bob',
  '... client ws',
  '... status submitted',
  '... changeType public',
  '... path //depot/...',
  '... desc first draft',
  '',
  '',
].join('\n')

describe('PerforceClient.getBlame', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  it('resolves from `changes -l` metadata even when `describe` would hang forever', async () => {
    let describeCalls = 0
    let changesCalls = 0
    respond((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'info') {
        return { stdout: `... clientName testclient\n... clientRoot ${ROOT}\n... userName bob\n\n` }
      }
      if (cmd === 'annotate') return { stdout: ANNOTATE_ZTAG }
      if (cmd === 'changes') {
        changesCalls++
        return { stdout: CHANGES_ZTAG }
      }
      if (cmd === 'describe') {
        describeCalls++
        return 'hang' // the giant-branch-changelist describe that never returns
      }
      return { stdout: '' }
    })

    const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
      enabled: true,
      workspaceTtlMs: 4000,
    })

    // Before the fix this awaited a per-changelist `describe -s` and hung here.
    const blame = await Promise.race([
      client!.getBlame(FILE),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('getBlame stalled (describe hang)')), 2000),
      ),
    ])

    expect(describeCalls).toBe(0)
    expect(changesCalls).toBe(1)
    expect(blame?.uncommittedLines).toEqual([])
    // Two changelists own contiguous ranges: cl40 → line 1, cl42 → lines 2-3.
    const byHash = new Map(blame?.commits.map((c) => [c.hash, c]))
    expect(byHash.get('40')).toMatchObject({
      authorName: 'bob',
      summary: 'first draft',
      authorDate: 1748000000 * 1000,
      ranges: [{ startLine: 1, endLine: 1 }],
    })
    expect(byHash.get('42')).toMatchObject({
      authorName: 'alice',
      summary: 'seed the tracked file',
      authorDate: 1748100000 * 1000,
      ranges: [{ startLine: 2, endLine: 3 }],
    })

    client!.dispose()
  })

  it('caches the changes lookup per file', async () => {
    let changesCalls = 0
    respond((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'info') {
        return { stdout: `... clientName testclient\n... clientRoot ${ROOT}\n... userName bob\n\n` }
      }
      if (cmd === 'annotate') return { stdout: ANNOTATE_ZTAG }
      if (cmd === 'changes') {
        changesCalls++
        return { stdout: CHANGES_ZTAG }
      }
      return { stdout: '' }
    })

    const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
      enabled: true,
      workspaceTtlMs: 4000,
    })

    await client!.getBlame(FILE)
    await client!.getBlame(FILE)
    expect(changesCalls).toBe(1)

    client!.dispose()
  })

  it('still returns blame (metadata-less) when the changes lookup fails', async () => {
    respond((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'info') {
        return { stdout: `... clientName testclient\n... clientRoot ${ROOT}\n... userName bob\n\n` }
      }
      if (cmd === 'annotate') return { stdout: ANNOTATE_ZTAG }
      if (cmd === 'changes') return { stdout: '', exit: 1 }
      return { stdout: '' }
    })

    const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
      enabled: true,
      workspaceTtlMs: 4000,
    })

    const blame = await client!.getBlame(FILE)
    expect(blame?.commits.map((c) => c.hash).sort()).toEqual(['40', '42'])

    client!.dispose()
  })
})
