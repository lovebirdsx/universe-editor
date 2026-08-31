/**
 * Behind awareness (`setSyncPreviewOptions` / `scheduleSyncPreview` /
 * `runSyncPreviewScan`): the dry-run server comparison that turns "you are behind"
 * into a status-bar count plus grey per-file Explorer markers. Pinned here are the
 * `-ztag` fixture shape (measured on P4D 2024.2 — see `e2e/fixtures/PROBE-FINDINGS.md`),
 * the 500-marker cap: `-m 501` bounds the reply, the cap decision and the count
 * come from the first record's `totalFileCount` (measured untruncated under
 * `-m`), and the record count is only the logged fallback — the skip is never
 * silent either way, the 30s interval
 * floor, the scheduling guards (auto-check, force, re-entry), the two-tier gate
 * (a `changes -m 1 -s submitted` marker that skips the `sync -n` tier when
 * unchanged, and that must fall through to the real scan when it fails), and the
 * state invariants: disabling auto-check clears stale state, and a failed scan
 * keeps the previous result because failure is not evidence of being current.
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

/** One `p4 -ztag changes -m 1 -s submitted` record, shaped like the real probe. */
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

/**
 * Discovery + empty refresh reads; sync/`sync -n` come from the per-test handler.
 * The `changes` gate answers with a fresh CL number per call by default — the
 * depot "keeps moving", so every scan falls through to the real tier; tests that
 * need a sitting-still depot pass a `changesReply` returning one constant CL.
 */
function makeHandler(
  syncReply: (argv: string[]) => Reply,
  changesReply?: (argv: string[]) => Reply,
): (argv: string[]) => Reply {
  let gateCalls = 0
  const gate = changesReply ?? (() => ({ stdout: changeRecord(1_000_000 + gateCalls++) }))
  return (argv) => {
    const cmd = subcommand(argv)
    if (cmd === 'info') return { stdout: DISCOVERY }
    if (cmd === 'sync') return syncReply(argv)
    if (cmd === 'changes') return gate(argv)
    return { stdout: '' }
  }
}

async function makeClient(
  syncReply: (argv: string[]) => Reply = () => ({ stdout: '' }),
  log?: (msg: string) => void,
  changesReply?: (argv: string[]) => Reply,
) {
  respond(makeHandler(syncReply, changesReply))
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

/** Local path of `rel` under the client root, backslashed on Windows. */
function localPath(rel: string): string {
  const fwd = `${ROOT_FWD}/${rel}`
  return process.platform === 'win32' ? fwd.replace(/\//g, '\\') : fwd
}

/**
 * One `p4 -ztag sync -n` record, shaped exactly like the P4D 2024.2 probe:
 * `clientFile` is already a local path, `rev`/`action` on their own lines.
 */
function previewRecord(i: number): string {
  return [
    `... depotFile //depot/branch_x/f${i}.cpp`,
    `... clientFile ${localPath(`f${i}.cpp`)}`,
    `... rev ${i}`,
    '... action updated',
    '',
  ].join('\n')
}

/** `n` behind-file records, blank-line separated like real `-ztag` output. */
function behindRecords(n: number): string {
  const out: string[] = []
  for (let i = 1; i <= n; i++) out.push(previewRecord(i))
  return out.join('\n')
}

/**
 * `n` records where the FIRST one carries `totalFileCount: total` — the
 * measured P4D 2024.2 shape (one grand total in the first file record, next to
 * `totalFileSize`/`change`), which survives `-m` truncation.
 */
function behindRecordsWithTotal(n: number, total: number): string {
  const records: string[] = []
  for (let i = 1; i <= n; i++) {
    const base = [
      `... depotFile //depot/branch_x/f${i}.cpp`,
      `... clientFile ${localPath(`f${i}.cpp`)}`,
      `... rev ${i}`,
      '... action updated',
    ]
    if (i === 1)
      base.push(`... totalFileSize 37318816`, `... totalFileCount ${total}`, '... change 8607110')
    base.push('')
    records.push(base.join('\n'))
  }
  return records.join('\n')
}

/** Every `sync -n` (dry-run) argv the client spawned — the real sync never runs. */
function syncPreviewArgvs(): string[][] {
  return spawned.filter((a) => subcommand(a) === 'sync' && a.includes('-n'))
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

describe('behind decorations and count', () => {
  it('decorates each behind file with its local path and revision', async () => {
    // The marker must key to a local Explorer row (never `//` client syntax) and
    // name the revision, or the grey hint can't be acted on.
    const client = await makeClient(() => ({ stdout: behindRecords(3) }))

    const res = await client.runSyncPreviewScan()

    expect(res).toEqual({ behind: 3, capped: false, ok: true, skipped: false })
    expect(client.status.syncBehindCount).toBe(3)
    const decorations = publishedDecorations()
    expect(decorations).toHaveLength(3)
    for (const [i, d] of decorations.entries()) {
      expect(d.resourceUri.startsWith('//')).toBe(false)
      expect(d.resourceUri.replace(/\\/g, '/')).toBe(`${ROOT_FWD}/f${i + 1}.cpp`)
      expect(d.description.length).toBeGreaterThan(0)
      expect(d.tooltip).toContain(`#${i + 1}`)
    }
  })

  it('keeps the count undefined until a check actually completes', async () => {
    // Undefined ("never checked") must stay distinct from 0 ("checked, current"):
    // the status bar shows nothing for the former and must not fake a
    // reassuring zero it hasn't earned.
    const client = await makeClient(() => ({ stdout: behindRecords(3) }))

    expect(client.status.syncBehindCount).toBeUndefined()
    await client.runSyncPreviewScan()
    expect(client.status.syncBehindCount).toBe(3)
  })

  it('clears the markers when the server says everything is current', async () => {
    // Measured shape: the notice lands on stderr with exit 0. Read as a failure
    // this would toast an error on a healthy workspace; left un-cleared, stale
    // markers would outlive the files they pointed at.
    let scans = 0
    const client = await makeClient(() => {
      scans++
      return scans === 1
        ? { stdout: behindRecords(3) }
        : { stderr: `${ROOT_FWD}/... - file(s) up-to-date.`, exit: 0 }
    })

    await client.runSyncPreviewScan()
    const res = await client.runSyncPreviewScan()

    expect(res).toEqual({ behind: 0, capped: false, ok: true, skipped: false })
    // 0, not undefined — a completed check that found nothing is evidence.
    expect(client.status.syncBehindCount).toBe(0)
    expect(publishedDecorations()).toEqual([])
  })

  // On an `allwrite noclobber` client a behind file that has uncollected local
  // changes is reported as a plain `- can't update modified file` line, which
  // `-ztag` drops. That left the count at 0 and the Explorer bare while the
  // status-bar revision chip showed `↓` for the very same file.
  it('counts and decorates a behind file p4 refused for local changes', async () => {
    const client = await makeClient(() => ({
      stdout: `//depot/branch_x/f1.cpp#7 - can't update modified file ${localPath('f1.cpp')}\n`,
    }))

    const res = await client.runSyncPreviewScan()

    expect(res).toEqual({ behind: 1, capped: false, ok: true, skipped: false })
    expect(client.status.syncBehindCount).toBe(1)
    const decorations = publishedDecorations()
    expect(decorations).toHaveLength(1)
    expect(decorations[0]!.resourceUri.startsWith('//')).toBe(false)
    expect(decorations[0]!.resourceUri.replace(/\\/g, '/')).toBe(`${ROOT_FWD}/f1.cpp`)
    expect(decorations[0]!.tooltip).toContain('#7')
  })
})

describe('decoration cap', () => {
  it('caps at 500 markers and reports capped with the floor count', async () => {
    // 501 records with no totalFileCount (the fallback) mean "more than the
    // cap" — the count must say 500 with capped true (a floor the UI renders
    // as "500+"), not an exact 501 it doesn't have.
    const client = await makeClient(() => ({ stdout: behindRecords(501) }))

    const res = await client.runSyncPreviewScan()

    expect(res).toEqual({ behind: 500, capped: true, ok: true, skipped: false })
    expect(client.status.syncBehindCount).toBe(500)
    expect(publishedDecorations()).toEqual([])
  })

  it('takes the count from totalFileCount, untruncated by -m', async () => {
    // The real-machine shape that motivated this fix: `-m 501` truncates the
    // records to 501 while `totalFileCount` still reports the full 1903. The
    // count and the cap must both come from the total — capping on the
    // returned record count read a genuinely-larger depot as 500 exactly.
    const client = await makeClient(() => ({ stdout: behindRecordsWithTotal(501, 1903) }))

    const res = await client.runSyncPreviewScan()

    expect(res).toEqual({ behind: 1903, capped: true, ok: true, skipped: false })
    expect(client.status.syncBehindCount).toBe(1903)
    expect(publishedDecorations()).toEqual([])
  })

  it('counts plain-line refusals inside totalFileCount without faking their markers', async () => {
    // Measured: totalFileCount can exceed the record count by the locally
    // modified files reported as plain `- can't update` lines (297 = 259
    // records + 38). The count includes them — they ARE files a sync would
    // touch — but only records carry local paths, so only they get markers.
    const client = await makeClient(() => ({ stdout: behindRecordsWithTotal(3, 5) }))

    const res = await client.runSyncPreviewScan()

    expect(res).toEqual({ behind: 5, capped: false, ok: true, skipped: false })
    expect(client.status.syncBehindCount).toBe(5)
    expect(publishedDecorations()).toHaveLength(3)
  })

  it('logs the fallback when the server reports no totalFileCount', async () => {
    // Older servers without the field: the truncated record count is all we
    // have, and that must be said out loud — a count silently derived from a
    // saturated reply is exactly the undercount this fix removes.
    const log = vi.fn<(msg: string) => void>()
    const client = await makeClient(() => ({ stdout: behindRecords(2) }), log)

    await client.runSyncPreviewScan()

    expect(log.mock.calls.flat().join('\n')).toContain('no totalFileCount')
  })

  it('does not log the fallback for a genuinely up-to-date reply', async () => {
    // An empty reply is "up to date" on EVERY server — there is no record to
    // carry the field. Logging the fallback there would cry wolf on every
    // healthy workspace scan.
    const log = vi.fn<(msg: string) => void>()
    const client = await makeClient(
      () => ({ stderr: `${ROOT_FWD}/... - file(s) up-to-date.`, exit: 0 }),
      log,
    )

    await client.runSyncPreviewScan()

    expect(log.mock.calls.flat().join('\n')).not.toContain('no totalFileCount')
  })

  it('never goes silent when the cap hides the markers', async () => {
    // An Explorer with zero markers next to a "500+" number would read as a
    // contradiction; the log line is what makes the skip diagnosable.
    const log = vi.fn<(msg: string) => void>()
    const client = await makeClient(() => ({ stdout: behindRecords(501) }), log)

    await client.runSyncPreviewScan()

    expect(log.mock.calls.flat().join('\n')).toContain('500')
  })

  it('pushes the 501-probe cap down to the server as -m', async () => {
    // The +1 probe must travel as a server-side limit — fetching a 450k-file
    // workspace's worth of records to truncate locally would make every
    // behind-check O(workspace).
    const client = await makeClient(() => ({ stdout: '' }))

    await client.runSyncPreviewScan()

    const argv = syncPreviewArgvs().at(-1)!
    const at = argv.indexOf('-m')
    expect(at).toBeGreaterThan(-1)
    expect(argv[at + 1]).toBe('501')
  })
})

describe('scheduling guards', () => {
  it('stays silent while auto-check is off', async () => {
    // `sync -n` over a whole workspace is the most expensive read this
    // extension issues; a disabled auto-check must mean zero scans, not just
    // fewer.
    const client = await makeClient(() => ({ stdout: behindRecords(1) }))
    client.setSyncPreviewOptions({ autoCheck: false, intervalMs: 30_000 })

    client.scheduleSyncPreview()
    await client.whenSyncPreviewSettled()

    expect(spawned.filter((a) => subcommand(a) === 'sync')).toHaveLength(0)
  })

  it('runs when forced even with auto-check off', async () => {
    // force is "a sync just landed — refresh the number the user acted on",
    // and that must not be swallowed by a config they disabled for background
    // use.
    const client = await makeClient(() => ({ stdout: behindRecords(1) }))
    client.setSyncPreviewOptions({ autoCheck: false, intervalMs: 30_000 })

    client.scheduleSyncPreview({ force: true })
    await client.whenSyncPreviewSettled()

    expect(syncPreviewArgvs()).toHaveLength(1)
  })

  it('skips a scan until the interval has elapsed', async () => {
    // The interval is the real guard against once-per-save scans: a 1s-old
    // check must not re-run, while one past the floor must.
    const client = await makeClient(() => ({ stdout: behindRecords(1) }))
    client.setSyncPreviewOptions({ autoCheck: true, intervalMs: 30_000 })

    client.scheduleSyncPreview()
    await client.whenSyncPreviewSettled()
    expect(syncPreviewArgvs()).toHaveLength(1)

    clock += 1000
    client.scheduleSyncPreview()
    await client.whenSyncPreviewSettled()
    expect(syncPreviewArgvs()).toHaveLength(1)

    clock += 29_001
    client.scheduleSyncPreview()
    await client.whenSyncPreviewSettled()
    expect(syncPreviewArgvs()).toHaveLength(2)
  })

  it('clamps a sub-floor configured interval up to the 30s minimum', async () => {
    // `Math.max` against SYNC_PREVIEW_MIN_INTERVAL_MS — a misconfigured 1s
    // interval must not turn into once-per-save server comparisons.
    const client = await makeClient(() => ({ stdout: behindRecords(1) }))
    client.setSyncPreviewOptions({ autoCheck: true, intervalMs: 1000 })

    client.scheduleSyncPreview()
    await client.whenSyncPreviewSettled()

    clock += 10_000
    client.scheduleSyncPreview()
    await client.whenSyncPreviewSettled()

    expect(syncPreviewArgvs()).toHaveLength(1)
  })

  it('force skips the interval floor', async () => {
    // After a user-initiated get, the stale count must refresh immediately
    // instead of lingering for the rest of the interval.
    const client = await makeClient(() => ({ stdout: behindRecords(1) }))
    client.setSyncPreviewOptions({ autoCheck: true, intervalMs: 30_000 })

    client.scheduleSyncPreview()
    await client.whenSyncPreviewSettled()

    client.scheduleSyncPreview({ force: true })
    await client.whenSyncPreviewSettled()

    expect(syncPreviewArgvs()).toHaveLength(2)
  })

  it('absorbs a second schedule while a scan is in flight', async () => {
    // The in-flight flag must swallow back-to-back triggers, or one save storm
    // becomes a pile of serial O(scope) comparisons.
    const client = await makeClient(() => ({ stdout: behindRecords(1) }))
    client.setSyncPreviewOptions({ autoCheck: true, intervalMs: 30_000 })

    client.scheduleSyncPreview()
    client.scheduleSyncPreview()
    await client.whenSyncPreviewSettled()

    expect(syncPreviewArgvs()).toHaveLength(1)
  })
})

describe('state on disable and failure', () => {
  it('disabling auto-check clears the count and the markers', async () => {
    // Stale markers are worse than none once nothing will refresh them again,
    // and the count must go back to "never checked" rather than freeze at an
    // old value.
    const client = await makeClient(() => ({ stdout: behindRecords(2) }))
    client.setSyncPreviewOptions({ autoCheck: true, intervalMs: 30_000 })
    await client.runSyncPreviewScan()
    expect(client.status.syncBehindCount).toBe(2)
    expect(publishedDecorations()).toHaveLength(2)

    client.setSyncPreviewOptions({ autoCheck: false, intervalMs: 30_000 })

    expect(client.status.syncBehindCount).toBeUndefined()
    expect(publishedDecorations()).toEqual([])
  })

  it('keeps the previous result when a scan fails', async () => {
    // A failed probe is not evidence of being current: replacing the old count
    // and markers with "up to date" on a transient error would lie to the user.
    const log = vi.fn<(msg: string) => void>()
    let scans = 0
    const client = await makeClient(() => {
      scans++
      return scans === 1
        ? { stdout: behindRecords(2) }
        : { stderr: `//depot/branch_x/... - must refer to client 'testclient'.`, exit: 1 }
    }, log)

    await client.runSyncPreviewScan()
    const res = await client.runSyncPreviewScan()

    expect(res).toEqual({ behind: 2, capped: false, ok: false, skipped: false })
    expect(client.status.syncBehindCount).toBe(2)
    expect(publishedDecorations()).toHaveLength(2)
    // Degrade visibly in the log, never silently.
    expect(log.mock.calls.flat().join('\n')).toContain('behind-check failed')
  })
})

describe('cheap gate', () => {
  it('skips the expensive scan when the depot marker has not moved', async () => {
    // The gate exists so the steady state costs a ~130ms `changes` instead of a
    // server-side walk: an unchanged marker must mean zero extra `sync -n`, and
    // the count stays "what we last measured" — "not checked" is not "0".
    const client = await makeClient(
      () => ({ stdout: behindRecords(2) }),
      undefined,
      () => ({ stdout: changeRecord(1_000_001) }),
    )

    await client.runSyncPreviewScan()
    const syncScans = syncPreviewArgvs().length

    const res = await client.runSyncPreviewScan()

    expect(res).toEqual({ behind: 2, capped: false, ok: true, skipped: true })
    expect(syncPreviewArgvs()).toHaveLength(syncScans)
    expect(client.status.syncBehindCount).toBe(2)

    // The gate must stay the cheap `changes -m 1 -s submitted` — the `#have`
    // revision form is 240× slower on the same scope and would silently eat the
    // entire win this test pins down.
    const gateArgv = spawned.filter((a) => subcommand(a) === 'changes').at(-1)!
    expect(gateArgv).toContain('-m')
    expect(gateArgv).toContain('1')
    expect(gateArgv).toContain('-s')
    expect(gateArgv).toContain('submitted')
    expect(gateArgv.some((a) => a.includes('#have'))).toBe(false)
  })

  it('falls through to the real scan when the gate fails', async () => {
    // An unusable gate must open the door, not bolt it: reading "gate failed" as
    // "nothing changed" would freeze the status-bar count at its old value
    // forever, and the failure must be logged — never silent.
    const log = vi.fn<(msg: string) => void>()
    const client = await makeClient(
      () => ({ stdout: behindRecords(2) }),
      log,
      () => ({
        stderr: `//depot/branch_x/... - must refer to client 'testclient'.`,
        exit: 1,
      }),
    )

    const res = await client.runSyncPreviewScan()

    expect(res).toEqual({ behind: 2, capped: false, ok: true, skipped: false })
    expect(client.status.syncBehindCount).toBe(2)
    expect(log.mock.calls.flat().join('\n')).toContain('behind-check gate failed')
  })
})

describe('gate marker invariants', () => {
  it('commits the gate marker only after the expensive scan succeeds', async () => {
    // The marker gates the expensive pass, so it may only advance once that
    // pass produced a result. Advancing it up front means one failed `sync -n`
    // short-circuits every later check until someone submits again — the
    // count would sit stale for hours with no self-healing retry.
    let gateCalls = 0
    let syncCalls = 0
    const client = await makeClient(
      () => {
        syncCalls++
        if (syncCalls === 1) return { stdout: behindRecords(2) }
        if (syncCalls === 2) {
          return { stderr: `//depot/branch_x/... - must refer to client 'testclient'.`, exit: 1 }
        }
        return { stdout: behindRecords(3) }
      },
      undefined,
      () => ({ stdout: changeRecord(gateCalls++ === 0 ? 100 : 200) }),
    )

    const first = await client.runSyncPreviewScan()
    expect(first).toEqual({ behind: 2, capped: false, ok: true, skipped: false })

    const failed = await client.runSyncPreviewScan()
    expect(failed).toEqual({ behind: 2, capped: false, ok: false, skipped: false })

    // The depot is still at CL 200: had the failed pass advanced the marker,
    // this check would skip and the count would stay stuck at 2.
    const retried = await client.runSyncPreviewScan()
    expect(retried).toEqual({ behind: 3, capped: false, ok: true, skipped: false })
    expect(client.status.syncBehindCount).toBe(3)
  })

  it('remembers a zero-record gate so an empty scope skips too', async () => {
    // Zero records on a successful gate is itself a stable answer ("nothing
    // has ever been submitted in this scope"). Reading it as no marker would
    // make an empty depot pay for the expensive pass on every single check.
    const client = await makeClient(
      () => ({ stdout: behindRecords(1) }),
      undefined,
      () => ({ stdout: '' }),
    )

    const first = await client.runSyncPreviewScan()
    expect(first).toEqual({ behind: 1, capped: false, ok: true, skipped: false })
    const syncScans = syncPreviewArgvs().length

    const res = await client.runSyncPreviewScan()

    expect(res).toEqual({ behind: 1, capped: false, ok: true, skipped: true })
    expect(syncPreviewArgvs()).toHaveLength(syncScans)
  })

  it('keeps the capped flag when a skipped check re-reports the count', async () => {
    // The count is a floor, not a total, whenever it saturates the cap.
    // Hardcoding capped:false on the skip path would downgrade "500+" to a
    // precise 500 the scan never established.
    const client = await makeClient(
      () => ({ stdout: behindRecords(501) }),
      undefined,
      () => ({ stdout: changeRecord(1_000_001) }),
    )

    const first = await client.runSyncPreviewScan()
    expect(first).toEqual({ behind: 500, capped: true, ok: true, skipped: false })

    const res = await client.runSyncPreviewScan()
    expect(res).toEqual({ behind: 500, capped: true, ok: true, skipped: true })
  })

  it('forgets the gate marker when the connection goes offline', async () => {
    // The marker is only valid while the count it gates still exists. Keeping
    // it across a disconnect would make the first check after reconnecting see
    // an unchanged marker, skip itself, and leave the count blank until
    // someone happens to submit.
    let syncCalls = 0
    const syncReply = () => {
      syncCalls++
      return { stdout: behindRecords(syncCalls === 1 ? 2 : 3) }
    }
    const gate = (argv: string[]) =>
      argv.includes('submitted') ? { stdout: changeRecord(100) } : { stdout: '' }
    const client = await makeClient(syncReply, undefined, gate)

    await client.runSyncPreviewScan()
    expect(client.status.syncBehindCount).toBe(2)

    // A refresh whose `opened` hits a connect error takes the client offline.
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
    expect(client.status.syncBehindCount).toBeUndefined()

    // Back online with the depot unchanged: the cleared marker must let the
    // first check run for real instead of skipping itself.
    respond(makeHandler(syncReply, gate))
    await client.refresh()
    expect(client.status.connection).toBe('connected')

    const res = await client.runSyncPreviewScan()
    expect(res).toEqual({ behind: 3, capped: false, ok: true, skipped: false })
  })

  it('forgets the gate marker when auto-check is disabled', async () => {
    // Disabling auto-check clears the count the marker gates; a remembered
    // marker would make the first check after re-enabling skip itself and
    // leave the count blank (the status bar would show nothing).
    let syncCalls = 0
    const syncReply = () => {
      syncCalls++
      return { stdout: behindRecords(syncCalls === 1 ? 2 : 3) }
    }
    const gate = (argv: string[]) =>
      argv.includes('submitted') ? { stdout: changeRecord(100) } : { stdout: '' }
    const client = await makeClient(syncReply, undefined, gate)

    await client.runSyncPreviewScan()
    expect(client.status.syncBehindCount).toBe(2)

    client.setSyncPreviewOptions({ autoCheck: false, intervalMs: 30_000 })
    expect(client.status.syncBehindCount).toBeUndefined()

    client.setSyncPreviewOptions({ autoCheck: true, intervalMs: 30_000 })
    const res = await client.runSyncPreviewScan()
    expect(res).toEqual({ behind: 3, capped: false, ok: true, skipped: false })
  })
})

describe('setSyncScope', () => {
  // A constant gate: the depot "stands still" at CL 100, so any skip is
  // entirely the marker's doing — exactly the trap a scope change must break.
  const gate100 = () => ({ stdout: changeRecord(100) })

  it('clears the count, markers and gate marker when the scope changes', async () => {
    let syncCalls = 0
    const client = await makeClient(
      () => {
        syncCalls++
        return { stdout: behindRecords(syncCalls === 1 ? 2 : 3) }
      },
      undefined,
      gate100,
    )

    await client.runSyncPreviewScan()
    expect(client.status.syncBehindCount).toBe(2)
    expect(publishedDecorations()).toHaveLength(2)

    client.setSyncScope([`${ROOT}/other`])

    expect(client.status.syncBehindCount).toBeUndefined()
    expect(publishedDecorations()).toEqual([])

    // The gate reads the same CL 100 the OLD scope's marker remembered: had
    // the marker survived the scope change, this check would skip itself and
    // the new scope's count would never appear.
    const res = await client.runSyncPreviewScan()
    expect(res).toEqual({ behind: 3, capped: false, ok: true, skipped: false })
    expect(client.status.syncBehindCount).toBe(3)
  })

  it('clears nothing when the scope is unchanged', async () => {
    const client = await makeClient(() => ({ stdout: behindRecords(2) }), undefined, gate100)
    client.setSyncScope([`${ROOT}/a`, `${ROOT}/b`])
    await client.runSyncPreviewScan()
    expect(client.status.syncBehindCount).toBe(2)
    expect(publishedDecorations()).toHaveLength(2)

    // The config-change notification fires for unrelated keys too — an
    // unchanged scope must not burn the expensive pass for nothing.
    client.setSyncScope([`${ROOT}/a`, `${ROOT}/b`])

    expect(client.status.syncBehindCount).toBe(2)
    expect(publishedDecorations()).toHaveLength(2)
    // …and the retained marker still lets the next check skip for real.
    const res = await client.runSyncPreviewScan()
    expect(res).toEqual({ behind: 2, capped: false, ok: true, skipped: true })
  })

  it('treats a reordered scope as changed', async () => {
    const client = await makeClient(() => ({ stdout: behindRecords(1) }), undefined, gate100)
    client.setSyncScope([`${ROOT}/a`, `${ROOT}/b`])
    await client.runSyncPreviewScan()
    expect(client.status.syncBehindCount).toBe(1)

    client.setSyncScope([`${ROOT}/b`, `${ROOT}/a`])

    // Different filespec order = a different filespec list; the old state is
    // about the old list and must go.
    expect(client.status.syncBehindCount).toBeUndefined()
  })
})

describe('PerforceClient.previewSyncTotal', () => {
  it('returns the untruncated totalFileCount and probes with -m 1', async () => {
    const client = await makeClient((argv) => {
      if (!argv.includes('-n')) return { stdout: '' }
      return {
        stdout: [
          '... depotFile //depot/branch_x/a.cpp',
          `... clientFile ${localPath('a.cpp')}`,
          '... rev 3',
          '... action updated',
          '... totalFileCount 147',
          '',
        ].join('\n'),
      }
    })

    const total = await client.previewSyncTotal('#head')

    expect(total).toBe(147)
    const argv = syncPreviewArgvs().at(-1)!
    const at = argv.indexOf('-m')
    expect(at).toBeGreaterThan(-1)
    expect(argv[at + 1]).toBe('1')
  })

  it('returns 0 for an up-to-date client', async () => {
    const client = await makeClient(() => ({
      stderr: `${ROOT_FWD}/... - file(s) up-to-date.`,
      exit: 0,
    }))

    const total = await client.previewSyncTotal('#head')

    expect(total).toBe(0)
  })

  it('returns undefined when the probe fails', async () => {
    const client = await makeClient(() => ({
      stderr: `//depot/branch_x/... - must refer to client 'testclient'.`,
      exit: 1,
    }))

    const total = await client.previewSyncTotal('#head')

    expect(total).toBeUndefined()
  })
})
