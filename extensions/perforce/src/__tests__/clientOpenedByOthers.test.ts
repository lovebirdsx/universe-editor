/**
 * Opened-by-others awareness (`setOpenedByOthersOptions` / `scheduleOpenedByOthers` /
 * `runOpenedByOthersScan`): the `p4 opened -a` scan that turns "someone else has
 * this file open" into grey per-file Explorer markers. Pinned here are the `-Mj`
 * fixture shape (measured on P4D 2024.2 — see `e2e/fixtures/PROBE-FINDINGS.md` §4),
 * the 300-marker cap whose +1 probe (`-m 301`) bounds the reply and is judged
 * on the RAW record count (a self-saturated probe must never read as "nobody
 * has anything open") and whose marker skip is never silent, the red line that the
 * OTHER client's `clientFile` is never translated with this client's root (local
 * paths must come from `p4 where` on the depot path, and the other client's
 * client-syntax path must never be sent back to p4), the scheduling guards
 * (auto-check, interval floor, re-entry, connection), the union publish with the
 * behind markers (one map's rewrite must not erase the other, and a file both
 * behind and occupied publishes one merged marker), and the state invariants: a
 * failed scan keeps the previous result, and going offline clears the markers
 * because "who has what open" is a claim about the server.
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
  setSupplementaryDecorations: vi.fn(),
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
      setSupplementaryDecorations: mocks.setSupplementaryDecorations,
      dispose() {},
    }),
    executeCommand: mocks.executeCommand,
    showMessage: mocks.showMessage,
  }
}

const { PerforceClient } = await import('../client.js')
const { ConcurrencyGate } = await import('../concurrency.js')
const { localize } = await import('../nls.js')
import type { PerforceClient as PerforceClientType } from '../client.js'

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const ROOT_FWD = process.platform === 'win32' ? 'C:/ws' : '/ws'

/**
 * The client's shared clock: the interval guard and the cache both read it, so
 * advancing it here advances time without fake timers.
 */
let clock = 1_000_000

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

/** True for the `p4 opened -a` scan (not the refresh's plain `opened`). */
function isOpenedAll(argv: string[]): boolean {
  return subcommand(argv) === 'opened' && argv.includes('-a')
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

/** Local path of `rel` under the client root, backslashed on Windows. */
function localPath(rel: string): string {
  const fwd = `${ROOT_FWD}/${rel}`
  return process.platform === 'win32' ? fwd.replace(/\//g, '\\') : fwd
}

/**
 * One `p4 opened -a` `-Mj` record, shaped like the P4D 2024.2 probe: the
 * `clientFile` is the OTHER client's client syntax, and `user`/`client` only
 * appear under `-a`.
 */
function openedByOtherRecord(
  depotRel: string,
  otherClient = 'otherclient',
  user = 'testuser',
): string {
  return JSON.stringify({
    depotFile: `//depot/branch_x/${depotRel}`,
    clientFile: `//${otherClient}/${depotRel}`,
    rev: '4',
    haveRev: 'none',
    action: 'add',
    change: 'default',
    type: 'binary',
    user,
    client: otherClient,
  })
}

/** `n` opened-by-others records, one JSON object per line (real `-Mj` output). */
function openedByOthersRecords(n: number): string {
  const out: string[] = []
  for (let i = 1; i <= n; i++) out.push(openedByOtherRecord(`Source/f${i}.txt`))
  return out.join('\n')
}

/** Default `p4 where` reply: each depot path maps to the same relative local
 *  path under the client root. */
function mapWhere(argv: string[]): Reply {
  const lines = argv
    .filter((a) => a.startsWith('//depot/'))
    .map((depot) =>
      JSON.stringify({
        depotFile: depot,
        path: localPath(depot.slice('//depot/branch_x/'.length)),
      }),
    )
  return { stdout: lines.join('\n') }
}

/** One `p4 -ztag changes -m 1 -s submitted` record (the behind-check gate). */
function changeRecord(id: number): string {
  return [
    `... change ${id}`,
    '... time 1788093183',
    '... user testuser',
    '... status submitted',
    '... changeType public',
    '... path //depot/branch_x/...',
    '',
  ].join('\n')
}

/** One `p4 -ztag sync -n` record for the union tests. */
function previewRecordFor(rel: string, rev: number): string {
  return [
    `... depotFile //depot/branch_x/${rel}`,
    `... clientFile ${localPath(rel)}`,
    `... rev ${rev}`,
    '... action updated',
    '',
  ].join('\n')
}

/** Discovery + empty refresh reads; `opened -a` / `where` come from the
 *  per-test handlers. The refresh's own `opened` returns empty so the
 *  workspace has no pending changelists. */
function makeHandler(
  openedAllReply: (argv: string[]) => Reply,
  whereReply: (argv: string[]) => Reply,
): (argv: string[]) => Reply {
  return (argv) => {
    const cmd = subcommand(argv)
    if (cmd === 'info') return { stdout: DISCOVERY }
    if (isOpenedAll(argv)) return openedAllReply(argv)
    if (cmd === 'where') return whereReply(argv)
    return { stdout: '' }
  }
}

async function clientWith(handler: (argv: string[]) => Reply): Promise<PerforceClientType> {
  respond(handler)
  const client = await PerforceClient.create(ROOT, {}, new ConcurrencyGate(4), {
    enabled: true,
    workspaceTtlMs: 4000,
    now: () => clock,
  })
  expect(client).toBeDefined()
  return client!
}

async function makeClient(
  openedAllReply: (argv: string[]) => Reply = () => ({ stdout: '' }),
  whereReply: (argv: string[]) => Reply = mapWhere,
  log?: (msg: string) => void,
): Promise<PerforceClientType> {
  respond(makeHandler(openedAllReply, whereReply))
  const client = await PerforceClient.create(
    ROOT,
    {},
    new ConcurrencyGate(4),
    { enabled: true, workspaceTtlMs: 4000, now: () => clock },
    log,
  )
  expect(client).toBeDefined()
  return client!
}

interface PublishedDecoration {
  resourceUri: string
  description: string
  tooltip?: string
}

/** The most recently published decoration set, or [] when none was published. */
function publishedDecorations(): PublishedDecoration[] {
  const call = mocks.setSupplementaryDecorations.mock.calls.at(-1)
  if (!call) return []
  return (call[0] ?? []) as PublishedDecoration[]
}

/** Every `opened -a` argv the client spawned — the refresh's plain `opened`
 *  never counts. */
function openedAllArgvs(): string[][] {
  return spawned.filter((a) => isOpenedAll(a))
}

beforeEach(() => {
  installBridge()
  spawnMock.mockReset()
  spawned.length = 0
  clock = 1_000_000
  vi.clearAllMocks()
  mocks.executeCommand.mockResolvedValue(undefined)
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]
})

describe('opened-by-others markers', () => {
  it('marks files others have open with the local path, user and client', async () => {
    // The marker must key to a local Explorer row (from `p4 where`, never `//`
    // client syntax) and name who holds the file, or the grey hint can't be
    // acted on.
    const client = await makeClient(() => ({ stdout: openedByOthersRecords(2) }))

    const res = await client.runOpenedByOthersScan()

    expect(res).toEqual({ others: 2, capped: false, ok: true })
    const decorations = publishedDecorations()
    expect(decorations).toHaveLength(2)
    for (const [i, d] of decorations.entries()) {
      expect(d.resourceUri.startsWith('//')).toBe(false)
      expect(d.resourceUri.replace(/\\/g, '/')).toBe(`${ROOT_FWD}/Source/f${i + 1}.txt`)
      expect(d.description).toBe(localize('perforce.deco.occupied', 'in use by others'))
      expect(d.tooltip).toContain('testuser@otherclient')
    }
  })

  it('does not mark files open in this client', async () => {
    // The filter must run against the client's OWN name: a file the user has
    // open themselves is not a warning. The own record carries `client:
    // testclient` matching the discovery output.
    const mine = JSON.stringify({
      depotFile: '//depot/branch_x/Source/mine.txt',
      clientFile: '//testclient/Source/mine.txt',
      rev: '2',
      action: 'edit',
      change: 'default',
      type: 'text',
      user: 'testuser',
      client: 'testclient',
    })
    const client = await makeClient(() => ({
      stdout: `${openedByOtherRecord('Source/other.txt')}\n${mine}`,
    }))

    const res = await client.runOpenedByOthersScan()

    expect(res).toEqual({ others: 1, capped: false, ok: true })
    const decorations = publishedDecorations()
    expect(decorations).toHaveLength(1)
    expect(decorations[0]!.resourceUri.replace(/\\/g, '/')).toBe(`${ROOT_FWD}/Source/other.txt`)
  })

  it('clears the markers when nobody has anything open', async () => {
    // An empty `opened -a` is evidence: the markers must go, not linger.
    let scans = 0
    const client = await makeClient(() => {
      scans++
      return scans === 1 ? { stdout: openedByOthersRecords(2) } : { stdout: '' }
    })

    await client.runOpenedByOthersScan()
    expect(publishedDecorations()).toHaveLength(2)

    const res = await client.runOpenedByOthersScan()

    expect(res).toEqual({ others: 0, capped: false, ok: true })
    expect(publishedDecorations()).toEqual([])
  })
})

describe('decoration cap', () => {
  it('caps at 300 markers and reports capped with the floor count', async () => {
    // 301 records mean "more than the cap" — the count must say 300 with capped
    // true (a floor), not an exact 301 it doesn't have.
    const client = await makeClient(() => ({ stdout: openedByOthersRecords(301) }))

    const res = await client.runOpenedByOthersScan()

    expect(res).toEqual({ others: 300, capped: true, ok: true })
    expect(publishedDecorations()).toEqual([])
  })

  it('judges the cap on the RAW reply, not on the filtered set', async () => {
    // `opened -a` includes this client's own files: a user with >300 of their
    // own open saturates the probe with records that all filter out. Judging
    // on the filtered set read that as others=0 — a silent "nobody has
    // anything open" next to cleared markers. The raw reply at probe size is
    // "the open table is bigger than the cap" no matter whose files came
    // first, and it must be loud + keep the previous markers.
    const log = vi.fn<(msg: string) => void>()
    const mine = openedByOtherRecord('Source/self.txt', 'testclient', 'testuser')
    let scans = 0
    const client = await makeClient(
      () => {
        scans++
        return scans === 1
          ? { stdout: openedByOthersRecords(2) }
          : { stdout: Array.from({ length: 301 }, () => mine).join('\n') }
      },
      mapWhere,
      log,
    )

    await client.runOpenedByOthersScan()
    expect(publishedDecorations()).toHaveLength(2)

    const res = await client.runOpenedByOthersScan()

    expect(res).toEqual({ others: 300, capped: true, ok: true })
    // Truncation is not evidence that nobody has anything open: the previous
    // markers survive, exactly like the failure path.
    expect(publishedDecorations()).toHaveLength(2)
    const logText = log.mock.calls.flat().join('\n')
    expect(logText).toContain('saturated')
    expect(logText).toContain('300+')
  })

  it('never goes silent when the cap hides the markers', async () => {
    // An Explorer with zero markers would otherwise read as "nobody has
    // anything open"; the log line is what makes the skip diagnosable.
    const log = vi.fn<(msg: string) => void>()
    const client = await makeClient(() => ({ stdout: openedByOthersRecords(301) }), mapWhere, log)

    await client.runOpenedByOthersScan()

    expect(log.mock.calls.flat().join('\n')).toContain('300')
  })

  it('pushes the 301-probe cap down to the server as -m', async () => {
    // The +1 probe must travel as a server-side limit — fetching a whole
    // team's open table to truncate locally would make every scan O(open set).
    const client = await makeClient()

    await client.runOpenedByOthersScan()

    const argv = openedAllArgvs().at(-1)!
    const at = argv.indexOf('-m')
    expect(at).toBeGreaterThan(-1)
    expect(argv[at + 1]).toBe('301')
  })
})

describe('local-path resolution red line', () => {
  it('derives local paths from p4 where, never from the other client clientFile', async () => {
    // The `opened -a` record's clientFile is `//otherclient/Source/f1.txt`; a
    // clientRoot translation would fake `<root>/Source/f1.txt`. The where
    // reply deliberately maps to a different layout, so a regression to the
    // translation produces a visibly wrong row — and the other client's
    // client-syntax path must never be sent back to p4 at all.
    const client = await makeClient(
      () => ({ stdout: openedByOthersRecords(1) }),
      () => ({
        stdout: JSON.stringify({
          depotFile: '//depot/branch_x/Source/f1.txt',
          path: localPath('mapped/f1.txt'),
        }),
      }),
    )

    await client.runOpenedByOthersScan()

    const decorations = publishedDecorations()
    expect(decorations).toHaveLength(1)
    expect(decorations[0]!.resourceUri.replace(/\\/g, '/')).toBe(`${ROOT_FWD}/mapped/f1.txt`)
    for (const argv of spawned) {
      for (const arg of argv) expect(arg.startsWith('//otherclient')).toBe(false)
    }
    const whereArgv = spawned.filter((a) => subcommand(a) === 'where').at(-1)!
    expect(whereArgv.some((a) => a.includes('//depot/branch_x/Source/f1.txt'))).toBe(true)
  })
})

describe('scheduling guards', () => {
  it('stays silent while auto-check is off', async () => {
    // Disabled auto-check must mean zero scans, not just fewer: the open table
    // on a shared server is not free to read.
    const client = await makeClient(() => ({ stdout: openedByOthersRecords(1) }))
    client.setOpenedByOthersOptions({ autoCheck: false, intervalMs: 300_000 })

    client.scheduleOpenedByOthers()
    await client.whenOpenedByOthersSettled()

    expect(openedAllArgvs()).toHaveLength(0)
  })

  it('skips a scan until the interval has elapsed', async () => {
    // The interval is the real guard against once-per-save scans: a 1s-old
    // scan must not re-run, while one past the floor must.
    const client = await makeClient(() => ({ stdout: openedByOthersRecords(1) }))
    client.setOpenedByOthersOptions({ autoCheck: true, intervalMs: 300_000 })

    client.scheduleOpenedByOthers()
    await client.whenOpenedByOthersSettled()
    expect(openedAllArgvs()).toHaveLength(1)

    clock += 1000
    client.scheduleOpenedByOthers()
    await client.whenOpenedByOthersSettled()
    expect(openedAllArgvs()).toHaveLength(1)

    clock += 300_000
    client.scheduleOpenedByOthers()
    await client.whenOpenedByOthersSettled()
    expect(openedAllArgvs()).toHaveLength(2)
  })

  it('clamps a sub-floor configured interval up to the 30s minimum', async () => {
    // `Math.max` against OPENED_BY_OTHERS_MIN_INTERVAL_MS — a misconfigured 1s
    // interval must not turn into once-per-save open-table reads.
    const client = await makeClient(() => ({ stdout: openedByOthersRecords(1) }))
    client.setOpenedByOthersOptions({ autoCheck: true, intervalMs: 1000 })

    client.scheduleOpenedByOthers()
    await client.whenOpenedByOthersSettled()

    clock += 10_000
    client.scheduleOpenedByOthers()
    await client.whenOpenedByOthersSettled()

    expect(openedAllArgvs()).toHaveLength(1)
  })

  it('absorbs a second schedule while a scan is in flight', async () => {
    // The in-flight flag must swallow back-to-back triggers, or one save storm
    // becomes a pile of serial open-table reads.
    const client = await makeClient(() => ({ stdout: openedByOthersRecords(1) }))
    client.setOpenedByOthersOptions({ autoCheck: true, intervalMs: 30_000 })

    client.scheduleOpenedByOthers()
    client.scheduleOpenedByOthers()
    await client.whenOpenedByOthersSettled()

    expect(openedAllArgvs()).toHaveLength(1)
  })

  it('stays silent while disconnected', async () => {
    // The connection guard is the outer one: an offline client has nothing the
    // server would answer about.
    const client = await makeClient(() => ({ stdout: openedByOthersRecords(1) }))
    client.setOpenedByOthersOptions({ autoCheck: true, intervalMs: 30_000 })
    respond((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'info') return { stdout: DISCOVERY }
      if (cmd === 'opened') {
        return {
          stderr: 'Connect to server failed; TCP connect to 192.0.2.1:1666 failed.',
          exit: 1,
        }
      }
      return { stdout: '' }
    })
    await client.refresh()
    expect(client.status.connection).toBe('offline')

    client.scheduleOpenedByOthers()
    await client.whenOpenedByOthersSettled()

    expect(openedAllArgvs()).toHaveLength(0)
  })

  it('the refresh tail schedules the scan when auto-check is on', async () => {
    // The trigger point: a refresh (save-driven or manual) must schedule the
    // scan fire-and-forget, never inside the spinner-covered refresh chain.
    const client = await makeClient(() => ({ stdout: openedByOthersRecords(1) }))
    client.setOpenedByOthersOptions({ autoCheck: true, intervalMs: 30_000 })

    await client.refresh()
    await client.whenOpenedByOthersSettled()

    expect(openedAllArgvs()).toHaveLength(1)
  })
})

describe('state on disable, failure and offline', () => {
  it('disabling auto-check clears the markers', async () => {
    // Stale markers are worse than none once nothing will refresh them again.
    const client = await makeClient(() => ({ stdout: openedByOthersRecords(2) }))
    client.setOpenedByOthersOptions({ autoCheck: true, intervalMs: 30_000 })
    await client.runOpenedByOthersScan()
    expect(publishedDecorations()).toHaveLength(2)

    client.setOpenedByOthersOptions({ autoCheck: false, intervalMs: 30_000 })

    expect(publishedDecorations()).toEqual([])
  })

  it('keeps the previous result when a scan fails', async () => {
    // A failed probe is not evidence that nobody has anything open: replacing
    // the old markers with "all clear" on a transient error would lie to the
    // user.
    const log = vi.fn<(msg: string) => void>()
    let scans = 0
    const client = await makeClient(
      () => {
        scans++
        return scans === 1
          ? { stdout: openedByOthersRecords(2) }
          : {
              stderr: `//depot/branch_x/... - must refer to client 'testclient'.`,
              exit: 1,
            }
      },
      mapWhere,
      log,
    )

    await client.runOpenedByOthersScan()
    const res = await client.runOpenedByOthersScan()

    expect(res).toEqual({ others: 2, capped: false, ok: false })
    expect(publishedDecorations()).toHaveLength(2)
    // Degrade visibly in the log, never silently.
    expect(log.mock.calls.flat().join('\n')).toContain('opened-by-others scan failed')
  })

  it('keeps the previous result when the depot→local resolution fails', async () => {
    // A scan whose `where` hop failed is not evidence about which files to
    // mark: the count and markers stay put instead of publishing a fresh count
    // next to markers that no longer agree with it.
    const log = vi.fn<(msg: string) => void>()
    let whereCalls = 0
    const client = await makeClient(
      () => ({ stdout: openedByOthersRecords(2) }),
      (argv) => (whereCalls++ === 0 ? mapWhere(argv) : { stdout: '', exit: 1 }),
      log,
    )

    await client.runOpenedByOthersScan()
    expect(publishedDecorations()).toHaveLength(2)

    // Advance past the where cache TTL (floor 30s, see registerP4CacheNamespaces)
    // so the second scan really re-runs it.
    clock += 30_001
    const res = await client.runOpenedByOthersScan()

    expect(res).toEqual({ others: 2, capped: false, ok: false })
    expect(publishedDecorations()).toHaveLength(2)
    expect(log.mock.calls.flat().join('\n')).toContain('keeping the previous result')
  })

  it('publishes the count when no file maps into this view (where succeeds, zero hits)', async () => {
    // The real-server common case (PROBE-FINDINGS §10): on a shared server most
    // files opened by others live on branches outside this client's view, so
    // `where` exits 0 with zero records. That is an ANSWER ("nobody's open file
    // is visible here"), not a failed lookup — conflating the two with a
    // `size === 0` check kept the count blank forever on the default scope,
    // which is the one users actually run with.
    const log = vi.fn<(msg: string) => void>()
    const client = await makeClient(
      () => ({ stdout: openedByOthersRecords(2) }),
      () => ({ stdout: '' }), // exit 0, no records: nothing maps into this view
      log,
    )

    const res = await client.runOpenedByOthersScan()

    expect(res).toEqual({ others: 2, capped: false, ok: true })
    // The count is real and must reach the status bar; there is simply no
    // Explorer row to decorate.
    expect(publishedDecorations()).toHaveLength(0)
    expect(log.mock.calls.flat().join('\n')).not.toContain('keeping the previous result')
  })

  it('going offline clears the markers', async () => {
    // "Who has what open" is a claim about the server, so it can't outlive the
    // connection.
    const client = await makeClient(() => ({ stdout: openedByOthersRecords(2) }))
    await client.runOpenedByOthersScan()
    expect(publishedDecorations()).toHaveLength(2)

    respond((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'info') return { stdout: DISCOVERY }
      if (cmd === 'opened') {
        return {
          stderr: 'Connect to server failed; TCP connect to 192.0.2.1:1666 failed.',
          exit: 1,
        }
      }
      return { stdout: '' }
    })
    await client.refresh()
    expect(client.status.connection).toBe('offline')

    expect(publishedDecorations()).toEqual([])
  })

  it('changing the sync scope clears the markers', async () => {
    // The markers (and the count behind them) describe the OLD scope; keeping
    // them would show "someone has X open" next to a sync scope that no
    // longer covers X.
    const client = await makeClient(() => ({ stdout: openedByOthersRecords(2) }))
    await client.runOpenedByOthersScan()
    expect(publishedDecorations()).toHaveLength(2)

    client.setSyncScope([`${ROOT}/other`])

    expect(publishedDecorations()).toEqual([])
  })
})

describe('union with the behind markers', () => {
  function unionHandler(argv: string[]): Reply {
    const cmd = subcommand(argv)
    if (cmd === 'info') return { stdout: DISCOVERY }
    if (isOpenedAll(argv)) return { stdout: openedByOthersRecords(2) }
    if (cmd === 'where') return mapWhere(argv)
    if (cmd === 'sync') {
      return {
        stdout: `${previewRecordFor('Source/bf1.txt', 1)}\n${previewRecordFor(
          'Source/bf2.txt',
          2,
        )}\n${previewRecordFor('Source/bf3.txt', 3)}`,
      }
    }
    if (cmd === 'changes') {
      return argv.includes('submitted') ? { stdout: changeRecord(1_000_000) } : { stdout: '' }
    }
    return { stdout: '' }
  }

  it("one producer's rewrite never erases the other", async () => {
    // The channel replaces the provider's whole set: a producer publishing its
    // own slice would silently drop the other's. Both scans must survive each
    // other's re-runs.
    const client = await clientWith(unionHandler)

    await client.runSyncPreviewScan()
    await client.runOpenedByOthersScan()
    expect(publishedDecorations()).toHaveLength(5)

    // A later others-scan rewrites its own slice only — behind markers survive.
    await client.runOpenedByOthersScan()
    expect(publishedDecorations()).toHaveLength(5)
  })

  it('a file both behind and open by others publishes one merged marker', async () => {
    // The renderer keys decorations by path, so two entries for one row would
    // let the second overwrite the first. The merged marker must keep both
    // facts: joined description, both tooltips.
    const client = await clientWith((argv) => {
      const cmd = subcommand(argv)
      if (cmd === 'info') return { stdout: DISCOVERY }
      if (isOpenedAll(argv)) {
        return {
          stdout: `${openedByOtherRecord('Source/f1.txt')}\n${openedByOtherRecord('Source/f3.txt')}`,
        }
      }
      if (cmd === 'where') return mapWhere(argv)
      if (cmd === 'sync') {
        return {
          stdout: `${previewRecordFor('Source/f1.txt', 3)}\n${previewRecordFor('Source/f2.txt', 4)}`,
        }
      }
      if (cmd === 'changes') {
        return argv.includes('submitted') ? { stdout: changeRecord(1_000_000) } : { stdout: '' }
      }
      return { stdout: '' }
    })

    await client.runSyncPreviewScan()
    await client.runOpenedByOthersScan()

    // f1 (merged) + f2 (behind only) + f3 (others only)
    const decorations = publishedDecorations()
    expect(decorations).toHaveLength(3)
    const byUri = new Map(decorations.map((d) => [d.resourceUri.replace(/\\/g, '/'), d]))
    const merged = byUri.get(`${ROOT_FWD}/Source/f1.txt`)!
    expect(merged.description).toBe(
      localize('perforce.deco.occupiedAndBehind', 'in use by others · update available'),
    )
    expect(merged.tooltip).toContain('testuser@otherclient')
    expect(merged.tooltip).toContain('#3')
    const behindOnly = byUri.get(`${ROOT_FWD}/Source/f2.txt`)!
    expect(behindOnly.description).toBe(localize('perforce.deco.behind', 'update available'))
    const othersOnly = byUri.get(`${ROOT_FWD}/Source/f3.txt`)!
    expect(othersOnly.description).toBe(localize('perforce.deco.occupied', 'in use by others'))
  })
})
