/**
 * Phase-5 resolve UX: `resolve -am` must never go silent (p4 exits 0 even when
 * files are left unresolved), the pinned "needs resolve" group surfaces U files,
 * `-ay`/`-at` accept sides, and the merge editor opens with the have/head/disc
 * stages plus an `acceptResolved` save follow-up. The partial-success toast is
 * the A-fix guard: routing resolve back through `_mutate` (exit-code only)
 * makes it red.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = { end: vi.fn() }
  kill = vi.fn<() => boolean>(() => true)
}

const spawnMock = vi.fn<(...args: unknown[]) => FakeChildProcess>()
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  executeCommand: vi.fn(),
  showMessage: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
  chmod: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}))

interface FakeGroup {
  id: string
  label: string
  hideWhenEmpty: boolean | undefined
  resourceStates: { resourceUri: string; contextValue: string }[]
  dispose: ReturnType<typeof vi.fn>
}

const BRIDGE_KEY = '__universeExtensionHostBridge__'
const groups = new Map<string, FakeGroup>()

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
      createResourceGroup: (id: string, label: string) => {
        const group: FakeGroup = {
          id,
          label,
          hideWhenEmpty: undefined,
          resourceStates: [],
          dispose: vi.fn(),
        }
        groups.set(id, group)
        return group
      },
      dispose() {},
    }),
    executeCommand: mocks.executeCommand,
    showMessage: mocks.showMessage,
  }
}

const { PerforceClient } = await import('../client.js')
const { ConcurrencyGate } = await import('../concurrency.js')
const { norm } = await import('../pathUtil.js')
type PerforceClientInstance = import('../client.js').PerforceClient

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const CLIENT = 'testclient'
const DEPOT = '//depot/branch_x'
const A = process.platform === 'win32' ? 'C:/ws/a.txt' : '/ws/a.txt'
const B = process.platform === 'win32' ? 'C:/ws/b.txt' : '/ws/b.txt'
const C = process.platform === 'win32' ? 'C:/ws/c.txt' : '/ws/c.txt'

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

/** One `p4 -Mj opened` record (client syntax, like the real server). */
function openedRecord(
  depotFile: string,
  options: { change?: string; unresolved?: boolean } = {},
): string {
  return `${JSON.stringify({
    depotFile,
    clientFile: `//${CLIENT}/${depotFile.slice(DEPOT.length + 1)}`,
    change: options.change ?? 'default',
    action: 'edit',
    rev: '3',
    ...(options.unresolved ? { unresolved: true } : {}),
  })}\n`
}

/** One `p4 -Mj fstat -Ru` record. Real servers report the bare `unresolved` key
 *  (empty value) only here — `opened` never carries it (§11.5) — and fstat's
 *  `clientFile` is a LOCAL path (§3), the one command where that's true. */
function fstatUnresolvedRecord(depotFile: string, localPath: string): string {
  return `${JSON.stringify({
    depotFile,
    clientFile: localPath,
    action: 'edit',
    rev: '3',
    unresolved: '',
  })}\n`
}

/** Default responses: discovery + an empty pending set. */
function defaultHandler(argv: string[]): { stdout: string; exit?: number } {
  const cmd = subcommand(argv)
  if (cmd === 'info') {
    return { stdout: `... clientName ${CLIENT}\n... clientRoot ${ROOT}\n... userName bob\n\n` }
  }
  if (cmd === 'opened') return { stdout: '' }
  if (cmd === 'changes') return { stdout: '' }
  return { stdout: '' }
}

const calls: string[][] = []

/** Route each spawned fake child by p4 subcommand, recording argv. */
function respond(handler: (argv: string[]) => { stdout: string; exit?: number }): void {
  spawnMock.mockImplementation((...args: unknown[]) => {
    const argv = (args[1] as string[]) ?? []
    calls.push(argv)
    const child = new FakeChildProcess()
    queueMicrotask(() => {
      const { stdout, exit } = handler(argv)
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      child.emit('close', exit ?? 0)
    })
    return child
  })
}

async function makeClient(
  handler: (argv: string[]) => { stdout: string; exit?: number } = defaultHandler,
): Promise<PerforceClientInstance> {
  respond(handler)
  const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
    enabled: true,
    workspaceTtlMs: 4000,
  })
  expect(client).toBeDefined()
  return client!
}

const MIXED_RESOLVE = [
  `${A} - merging ${DEPOT}/a.txt#4`,
  'Diff chunks: 0 yours + 0 theirs + 0 both + 0 conflicting',
  `${DEPOT}/a.txt - copy from ${DEPOT}/a.txt`,
  `${B} - merging ${DEPOT}/b.txt#7`,
  'Diff chunks: 0 yours + 0 theirs + 0 both + 2 conflicting',
  `${DEPOT}/b.txt - resolve skipped.`,
  `${C} - merging ${DEPOT}/c.txt#7`,
  'Diff chunks: 0 yours + 0 theirs + 0 both + 2 conflicting',
  `${DEPOT}/c.txt - resolve skipped.`,
].join('\n')

beforeEach(() => {
  installBridge()
  spawnMock.mockReset()
  calls.length = 0
  groups.clear()
  vi.clearAllMocks()
  mocks.executeCommand.mockResolvedValue(undefined)
  mocks.readFile.mockResolvedValue('local content')
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
})

describe('PerforceClient.resolve (partial success never goes silent)', () => {
  it('exit 0 with files left unresolved toasts the counts and offers the merge editor', async () => {
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'resolve') return { stdout: MIXED_RESOLVE }
      if (cmd === 'opened') {
        // The real-server shape: `opened` carries NO unresolved key even for
        // files that need resolving (§11.5) — the signal comes from fstat.
        return {
          stdout: openedRecord(`${DEPOT}/b.txt`) + openedRecord(`${DEPOT}/c.txt`),
        }
      }
      if (cmd === 'fstat') {
        return {
          stdout:
            fstatUnresolvedRecord(`${DEPOT}/b.txt`, B) + fstatUnresolvedRecord(`${DEPOT}/c.txt`, C),
        }
      }
      return defaultHandler(argv)
    })
    mocks.showMessage.mockResolvedValue('Resolve Conflicts')

    const ok = await client.resolve([A, B, C])

    expect(ok).toBe(true)
    // The authoritative counts come from the refreshed fstat probe (2 still
    // unresolved of the 3 paths), so 1 merged and 2 remaining.
    expect(mocks.showMessage).toHaveBeenCalledWith(
      'warning',
      'Auto-merged 1; 2 still need manual resolution.',
      ['Resolve Conflicts'],
    )
    // The button routes to the first file still unresolved.
    expect(mocks.executeCommand).toHaveBeenCalledWith('perforce.openMergeEditor', [B])
    // The pinned group mirrors the remaining files.
    expect(groups.get('resolve')?.resourceStates).toHaveLength(2)
    expect(groups.get('resolve')?.resourceStates.map((s) => s.contextValue)).toEqual(['U', 'U'])
    client.dispose()
  })

  it('reports an all-clean run without a warning button', async () => {
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'resolve') {
        return { stdout: `${DEPOT}/a.txt - copy from ${DEPOT}/a.txt\n` }
      }
      return defaultHandler(argv)
    })

    await client.resolve([A])

    expect(mocks.showMessage).toHaveBeenCalledWith('info', 'Auto-merged 1 file(s).', [])
    expect(mocks.executeCommand).not.toHaveBeenCalled()
    client.dispose()
  })

  it('exit 0 with output no source accounts for still toasts (never silent)', async () => {
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      // "no file(s) to resolve": the rows were already resolved elsewhere.
      if (cmd === 'resolve') return { stdout: `${DEPOT}/a.txt - no file(s) to resolve.\n` }
      return defaultHandler(argv)
    })

    await client.resolve([A])

    expect(mocks.showMessage).toHaveBeenCalledWith('info', 'Resolve completed.', [])
    client.dispose()
  })

  it('exit non-zero still toasts the failure', async () => {
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'resolve') return { stdout: '', exit: 1 }
      return defaultHandler(argv)
    })

    const ok = await client.resolve([A])

    expect(ok).toBe(false)
    expect(mocks.showMessage).toHaveBeenCalledWith('error', expect.stringContaining('failed'), [])
    client.dispose()
  })
})

describe('PerforceClient.resolveChangelist (whole-group resolve)', () => {
  // Three unresolved rows in CL 12345 before the run; afterwards only c.txt is
  // still reported — the resolved rows have left the changelist. The candidate
  // set must therefore be captured BEFORE the p4 call, or a partial merge is
  // reported as "nothing happened". Unresolved comes from the fstat probe, like
  // the real server.
  const phased = (after: () => boolean): { opened: string; fstat: string } => {
    if (!after()) {
      return {
        opened:
          openedRecord(`${DEPOT}/a.txt`, { change: '12345' }) +
          openedRecord(`${DEPOT}/b.txt`, { change: '12345' }) +
          openedRecord(`${DEPOT}/c.txt`, { change: '12345' }),
        fstat:
          fstatUnresolvedRecord(`${DEPOT}/a.txt`, A) +
          fstatUnresolvedRecord(`${DEPOT}/b.txt`, B) +
          fstatUnresolvedRecord(`${DEPOT}/c.txt`, C),
      }
    }
    return {
      opened: openedRecord(`${DEPOT}/c.txt`, { change: '12345' }),
      fstat: fstatUnresolvedRecord(`${DEPOT}/c.txt`, C),
    }
  }

  /** Resolve via the partial transcript; `opened`/fstat phase via {@link phased},
   *  the opened-by-others background scan (`opened -a`) reports nothing. */
  const groupHandler = (
    after: () => boolean,
  ): ((argv: string[]) => { stdout: string; exit?: number }) => {
    return (argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'resolve') return { stdout: MIXED_RESOLVE }
      if (cmd === 'opened')
        return argv.includes('-a') ? { stdout: '' } : { stdout: phased(after).opened }
      if (cmd === 'fstat') return { stdout: phased(after).fstat }
      return defaultHandler(argv)
    }
  }

  it('partial success toasts the counts — routing this back through _mutate goes silent', async () => {
    let after = false
    const client = await makeClient(groupHandler(() => after))
    await client.refresh()
    after = true
    mocks.showMessage.mockResolvedValue('Resolve Conflicts')

    const ok = await client.resolveChangelist('12345')

    expect(ok).toBe(true)
    const resolve = calls.find((argv) => subcommand(argv) === 'resolve')
    expect(resolve).toBeDefined()
    // After the global -u/-c prefix: -am over the whole changelist.
    expect(resolve!.slice(resolve!.indexOf('resolve'))).toEqual(['resolve', '-am', '-c', '12345'])
    // The counts come from the refreshed fstat probe (1 of the 3 candidates
    // still unresolved), so 2 merged and 1 remaining.
    expect(mocks.showMessage).toHaveBeenCalledWith(
      'warning',
      'Auto-merged 2; 1 still need manual resolution.',
      ['Resolve Conflicts'],
    )
    // The button routes to the file still unresolved. Group candidates come from
    // the normed `_changelistByPath` keys, so the path is the normed C.
    expect(mocks.executeCommand).toHaveBeenCalledWith('perforce.openMergeEditor', [norm(C)])
    expect(groups.get('resolve')?.resourceStates).toHaveLength(1)
    expect(groups.get('resolve')?.resourceStates.map((s) => s.contextValue)).toEqual(['U'])
    client.dispose()
  })

  it('the default changelist omits `-c` (p4 rejects `-c default`)', async () => {
    let after = false
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'resolve') return { stdout: `${DEPOT}/a.txt - copy from ${DEPOT}/a.txt\n` }
      if (cmd === 'opened') {
        if (argv.includes('-a')) return { stdout: '' }
        return { stdout: openedRecord(`${DEPOT}/a.txt`, { change: 'default' }) }
      }
      if (cmd === 'fstat') {
        return after ? { stdout: '' } : { stdout: fstatUnresolvedRecord(`${DEPOT}/a.txt`, A) }
      }
      return defaultHandler(argv)
    })
    await client.refresh()
    after = true

    await client.resolveChangelist('default')

    const resolve = calls.find((argv) => subcommand(argv) === 'resolve')
    expect(resolve).toBeDefined()
    const args = resolve!.slice(resolve!.indexOf('resolve'))
    expect(args).toEqual(['resolve', '-am'])
    expect(args).not.toContain('-c')
    client.dispose()
  })

  it('captures the candidate set before the run — post-run rows have left the changelist', async () => {
    let after = false
    const client = await makeClient(groupHandler(() => after))
    await client.refresh()
    after = true

    await client.resolveChangelist('12345')

    // The refreshed `opened` shows only c.txt. Capturing candidates after the run
    // would yield an empty (or 1-row) set, so this partial merge would read as
    // "Resolve completed." (or a bogus zero-merged "1 still needs resolution").
    expect(mocks.showMessage).toHaveBeenCalledWith(
      'warning',
      'Auto-merged 2; 1 still need manual resolution.',
      ['Resolve Conflicts'],
    )
    expect(mocks.showMessage).not.toHaveBeenCalledWith('info', 'Resolve completed.', [])
    client.dispose()
  })

  it('cancellation skips the error toast and still refreshes', async () => {
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'resolve') {
        // Abort while the resolve is in flight; the service resolves a failure
        // result whose signal is already tripped.
        client.cancelBusy()
        return { stdout: '', stderr: 'was cancelled', exit: 1 }
      }
      if (cmd === 'opened') {
        if (argv.includes('-a')) return { stdout: '' }
        return { stdout: openedRecord(`${DEPOT}/a.txt`, { change: '12345' }) }
      }
      if (cmd === 'fstat') return { stdout: fstatUnresolvedRecord(`${DEPOT}/a.txt`, A) }
      return defaultHandler(argv)
    })
    await client.refresh()

    const ok = await client.resolveChangelist('12345')

    expect(ok).toBe(false)
    expect(mocks.showMessage).not.toHaveBeenCalled()
    // Seed refresh + the post-cancel refresh both re-ran `opened` (the -a scan is
    // excluded so the background probe can't flake this count).
    const openedCalls = calls.filter(
      (argv) => subcommand(argv) === 'opened' && !argv.includes('-a'),
    )
    expect(openedCalls).toHaveLength(2)
    client.dispose()
  })
})

describe('PerforceClient resolve -ay / -at', () => {
  it('resolveAcceptYours runs resolve -ay over the paths', async () => {
    const client = await makeClient()
    await client.resolveAcceptYours([A, B])
    const resolve = calls.find((argv) => subcommand(argv) === 'resolve')
    expect(resolve).toBeDefined()
    expect(resolve).toContain('-ay')
    expect(resolve).toContain(A)
    expect(resolve).toContain(B)
    client.dispose()
  })

  it('resolveAcceptTheirs runs resolve -at over the paths', async () => {
    const client = await makeClient()
    await client.resolveAcceptTheirs([A])
    const resolve = calls.find((argv) => subcommand(argv) === 'resolve')
    expect(resolve).toBeDefined()
    expect(resolve).toContain('-at')
    expect(resolve).toContain(A)
    client.dispose()
  })
})

describe('PerforceClient.openMergeEditor', () => {
  it('opens the merge editor with have/head/disc stages and the acceptResolved save command', async () => {
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'fstat') {
        return {
          stdout: `${JSON.stringify({ depotFile: `${DEPOT}/a.txt`, clientFile: A, haveRev: '3', headRev: '7' })}\n`,
        }
      }
      if (cmd === 'print') {
        const spec = argv[argv.length - 1] ?? ''
        return { stdout: spec.endsWith('#3') ? 'base content' : 'head content' }
      }
      return defaultHandler(argv)
    })
    mocks.readFile.mockResolvedValue('conflicted local content')

    await client.openMergeEditor(A)

    const open = mocks.executeCommand.mock.calls.find((c) => c[0] === '_workbench.openMergeEditor')
    expect(open).toBeDefined()
    expect(open![1][0]).toEqual({
      path: A,
      base: 'base content',
      current: 'conflicted local content',
      incoming: 'head content',
      merged: 'conflicted local content',
      currentLabel: 'Yours (have #3)',
      incomingLabel: 'Theirs (head #7)',
      saveCommand: { command: 'perforce.acceptResolved', arguments: [A] },
    })
    client.dispose()
  })

  it("treats haveRev 'none' (open-for-add) as an empty base and never prints #none", async () => {
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'fstat') {
        return {
          stdout: `${JSON.stringify({ depotFile: `${DEPOT}/a.txt`, clientFile: A, haveRev: 'none', headRev: '5' })}\n`,
        }
      }
      if (cmd === 'print') return { stdout: 'head content' }
      return defaultHandler(argv)
    })

    await client.openMergeEditor(A)

    const open = mocks.executeCommand.mock.calls.find((c) => c[0] === '_workbench.openMergeEditor')
    expect(open).toBeDefined()
    const payload = open![1][0] as { base: string; currentLabel: string }
    expect(payload.base).toBe('')
    expect(payload.currentLabel).toBe('Yours')
    const prints = calls.filter((argv) => subcommand(argv) === 'print')
    expect(prints.some((argv) => argv.join(' ').includes('#none'))).toBe(false)
    client.dispose()
  })
})

describe('the pinned "needs resolve" group', () => {
  it('holds U files while they stay in their changelist group, and is hidden when empty', async () => {
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'opened') {
        return {
          stdout: openedRecord(`${DEPOT}/a.txt`) + openedRecord(`${DEPOT}/b.txt`),
        }
      }
      // The U mark comes from the fstat probe — the real-server path.
      if (cmd === 'fstat') return { stdout: fstatUnresolvedRecord(`${DEPOT}/a.txt`, A) }
      return defaultHandler(argv)
    })

    await client.refresh()

    // Created second (below reconcile), with hideWhenEmpty pinned.
    const resolveGroup = groups.get('resolve')
    expect(resolveGroup).toBeDefined()
    expect(resolveGroup!.hideWhenEmpty).toBe(true)
    expect(resolveGroup!.resourceStates.map((s) => s.resourceUri)).toEqual([A])
    expect(resolveGroup!.resourceStates.map((s) => s.contextValue)).toEqual(['U'])
    // The U file deliberately remains in its owning changelist group too.
    const defaultGroup = groups.get('default')
    expect(defaultGroup).toBeDefined()
    expect(defaultGroup!.resourceStates.map((s) => s.resourceUri)).toEqual([A, B])

    // Nothing unresolved -> the pinned group is empty (host hides it).
    respond((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'opened') return { stdout: openedRecord(`${DEPOT}/b.txt`) }
      return defaultHandler(argv)
    })
    await client.refresh()
    expect(groups.get('resolve')!.resourceStates).toEqual([])

    client.dispose()
  })

  it('still honors an unresolved field reported by opened (other server versions) when fstat reports none', async () => {
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'opened') {
        return {
          stdout:
            openedRecord(`${DEPOT}/a.txt`, { unresolved: true }) + openedRecord(`${DEPOT}/b.txt`),
        }
      }
      if (cmd === 'fstat') return { stdout: '' }
      return defaultHandler(argv)
    })

    await client.refresh()

    expect(groups.get('resolve')?.resourceStates.map((s) => s.contextValue)).toEqual(['U'])
    client.dispose()
  })
})

describe('the fstat -Ru unresolved probe inside refresh', () => {
  it('is skipped entirely when nothing is open (zero p4 work)', async () => {
    const client = await makeClient() // opened reports nothing
    await client.refresh()
    expect(calls.some((argv) => subcommand(argv) === 'fstat')).toBe(false)
    client.dispose()
  })

  it('keeps the previous unresolved set when the probe fails instead of clearing the U badges', async () => {
    let failFstat = false
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'opened') return { stdout: openedRecord(`${DEPOT}/a.txt`) }
      if (cmd === 'fstat') {
        return failFstat
          ? { stdout: '', stderr: 'timed out after 20000ms and was killed', exit: 1 }
          : { stdout: fstatUnresolvedRecord(`${DEPOT}/a.txt`, A) }
      }
      return defaultHandler(argv)
    })

    await client.refresh()
    expect(groups.get('resolve')?.resourceStates.map((s) => s.contextValue)).toEqual(['U'])

    failFstat = true
    await client.refresh()
    // A failed probe is not evidence that nothing is unresolved — the badge
    // must survive a transient timeout.
    expect(groups.get('resolve')?.resourceStates.map((s) => s.contextValue)).toEqual(['U'])

    client.dispose()
  })

  it('a successful empty probe really clears the set (zero is not a failure)', async () => {
    let reportUnresolved = true
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'opened') return { stdout: openedRecord(`${DEPOT}/a.txt`) }
      if (cmd === 'fstat') {
        return reportUnresolved
          ? { stdout: fstatUnresolvedRecord(`${DEPOT}/a.txt`, A) }
          : { stdout: '' }
      }
      return defaultHandler(argv)
    })

    await client.refresh()
    expect(groups.get('resolve')?.resourceStates).toHaveLength(1)

    reportUnresolved = false
    await client.refresh()
    expect(groups.get('resolve')?.resourceStates).toEqual([])

    client.dispose()
  })

  it('queries fstat -Ru over the whole client view', async () => {
    const client = await makeClient((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'opened') return { stdout: openedRecord(`${DEPOT}/a.txt`) }
      return defaultHandler(argv)
    })

    await client.refresh()

    const fstat = calls.find((argv) => subcommand(argv) === 'fstat' && argv.includes('-Ru'))
    expect(fstat).toBeDefined()
    expect(fstat!.slice(fstat!.indexOf('fstat'))).toEqual(['fstat', '-Ru', '//...'])
    client.dispose()
  })
})

describe('openMergeEditor timeout budget (table-driven)', () => {
  interface TimeoutCase {
    name: string
    /** The p4 command held open (never exits) to probe its watchdog. */
    hold: 'fstat' | 'print'
    /** Held children that must have been killed after 30s. */
    killed: number
    /** Held children that must NOT have been killed after 30s. */
    alive: number
  }

  const cases: TimeoutCase[] = [
    {
      name: 'fstat (metadata read) keeps the interactive tight timeout',
      hold: 'fstat',
      killed: 1,
      alive: 0,
    },
    {
      name: 'print (content transfer) keeps the full command budget — no tight timeout',
      hold: 'print',
      killed: 0,
      alive: 2, // base + incoming prints
    },
  ]

  for (const c of cases) {
    it(c.name, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      try {
        const held: FakeChildProcess[] = []
        spawnMock.mockImplementation((...args: unknown[]) => {
          const argv = (args[1] as string[]) ?? []
          const child = new FakeChildProcess()
          const cmd = subcommand(argv)
          const holdIt = (): FakeChildProcess => {
            held.push(child)
            return child
          }
          if (cmd === 'info') {
            queueMicrotask(() => {
              child.stdout.emit(
                'data',
                Buffer.from(
                  `... clientName ${CLIENT}\n... clientRoot ${ROOT}\n... userName bob\n\n`,
                ),
              )
              child.emit('close', 0)
            })
          } else if (cmd === 'fstat') {
            if (c.hold === 'fstat') return holdIt()
            queueMicrotask(() => {
              child.stdout.emit(
                'data',
                Buffer.from(
                  `${JSON.stringify({ depotFile: `${DEPOT}/a.txt`, clientFile: A, haveRev: '3', headRev: '7' })}\n`,
                ),
              )
              child.emit('close', 0)
            })
          } else if (cmd === 'print') {
            if (c.hold === 'print') return holdIt()
            queueMicrotask(() => {
              child.stdout.emit('data', Buffer.from('content'))
              child.emit('close', 0)
            })
          } else {
            queueMicrotask(() => child.emit('close', 0))
          }
          return child
        })

        const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
          enabled: true,
          workspaceTtlMs: 4000,
        })
        expect(client).toBeDefined()

        const opening = client!.openMergeEditor(A)
        // Let the flow reach the held command (each spawn responds on a microtask).
        for (let i = 0; i < 50 && held.length === 0; i++) {
          await Promise.resolve()
        }
        expect(held.length).toBeGreaterThan(0)

        await vi.advanceTimersByTimeAsync(35_000)

        const killed = held.filter((child) => child.kill.mock.calls.length > 0)
        expect(killed.length, `expected ${c.killed} killed, got ${killed.length}`).toBe(c.killed)
        expect(held.length - killed.length).toBe(c.alive)

        client!.dispose()
        void opening // The held child never closes; the promise stays pending.
      } finally {
        vi.useRealTimers()
      }
    })
  }
})
