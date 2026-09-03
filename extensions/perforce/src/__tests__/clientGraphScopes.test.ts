/**
 * Merged (multi-select) history: `getGraphChanges` takes N filespecs and must
 * issue exactly ONE `p4 changes` — p4 answers the union across filespecs, and the
 * `-x` argfile mechanism in `p4Service` already bounds the command line, so there
 * is no reason to batch. Also pins the cache key's order-independence: the caller
 * (`buildSyncFilespecs`) preserves the user's click order, so an unsorted key
 * would cache the same selection once per order it was clicked in.
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

function changeRecord(id: string): string {
  return JSON.stringify({
    change: id,
    user: 'testuser',
    client: 'testclient',
    time: '1700000000',
    desc: `change ${id}`,
  })
}

interface Harness {
  changesArgvs: string[][]
  create: () => ReturnType<typeof PerforceClient.create>
}

/** Records every `changes` argv and answers with the given changelist ids. */
function harness(ids: readonly string[]): Harness {
  const changesArgvs: string[][] = []
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[1] as string[]) ?? []
    const child = new FakeChildProcess()
    queueMicrotask(() => {
      const cmd = subcommand(argv)
      let stdout = ''
      if (cmd === 'info') {
        stdout = `... clientName testclient\n... clientRoot ${ROOT}\n... userName testuser\n\n`
      } else if (cmd === 'changes') {
        changesArgvs.push(argv)
        stdout = ids.map(changeRecord).join('\n')
      }
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      child.emit('close', 0)
    })
    return child
  })
  return {
    changesArgvs,
    create: () =>
      PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
        enabled: true,
        workspaceTtlMs: 30_000,
      }),
  }
}

const SCOPES = ['X:/p4ws/main/a.txt', 'X:/p4ws/main/b.txt', 'X:/p4ws/main/sub/...']

describe('PerforceClient.getGraphChanges with multiple filespecs', () => {
  beforeEach(() => {
    installScmBridge()
    spawnMock.mockReset()
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
  })

  it('issues one `changes` carrying every filespec', async () => {
    const h = harness(['4522', '4521'])
    const client = await h.create()
    const listing = await client!.getGraphChanges(10, SCOPES)

    expect(h.changesArgvs.length).toBe(1)
    const argv = h.changesArgvs[0]!
    expect(argv.slice(argv.indexOf('changes'))).toEqual([
      'changes',
      '-s',
      'submitted',
      '-l',
      '-m',
      '11', // maxChanges + 1 (the "more available" probe)
      ...SCOPES,
    ])
    expect(listing?.changes.map((c) => c.id)).toEqual(['4522', '4521'])
    expect(listing?.moreAvailable).toBe(false)
    client!.dispose()
  })

  it('dedupes and re-sorts the union (one CL can be reported per filespec)', async () => {
    const h = harness(['4521', '4522', '4521'])
    const client = await h.create()
    const listing = await client!.getGraphChanges(10, SCOPES)
    expect(listing?.changes.map((c) => c.id)).toEqual(['4522', '4521'])
    client!.dispose()
  })

  it('reads moreAvailable off the raw record count, not the deduped list', async () => {
    // `-m 3` caps RECORDS. Three records that dedupe to two distinct changelists
    // still mean p4 truncated: older changes exist. Judging by the deduped length
    // (2 <= 2) would drop the "Load more" button.
    const h = harness(['4523', '4522', '4522'])
    const client = await h.create()
    const listing = await client!.getGraphChanges(2, SCOPES)
    expect(listing?.changes.map((c) => c.id)).toEqual(['4523', '4522'])
    expect(listing?.moreAvailable).toBe(true)
    client!.dispose()
  })

  it('caches order-independently: the same selection clicked in any order hits once', async () => {
    const h = harness(['4522'])
    const client = await h.create()
    await client!.getGraphChanges(10, SCOPES)
    await client!.getGraphChanges(10, [...SCOPES].reverse())
    expect(h.changesArgvs.length).toBe(1)
    client!.dispose()
  })

  it('keys on the filespec set, so a different selection is a separate query', async () => {
    const h = harness(['4522'])
    const client = await h.create()
    await client!.getGraphChanges(10, SCOPES)
    await client!.getGraphChanges(10, [SCOPES[0]!])
    expect(h.changesArgvs.length).toBe(2)
    client!.dispose()
  })
})
