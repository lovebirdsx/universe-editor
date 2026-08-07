/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/sessionChangeTracker.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  Event,
  LogLevel,
  NoopTelemetryService,
  NullLogger,
  StorageScope,
  URI,
  UriIdentityService,
  type HostPlatform,
  type IDirectoryEntry,
  type IFileService,
  type IFileStat,
  type ILogger,
  type ILoggerService,
  type IStorageService,
  type IWorkspace,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { SessionChangeTrackerService } from '../sessionChangeTracker.js'
import type { DiffHunk } from '../sessionDiffReconstruct.js'

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly buckets = new Map<StorageScope, Map<string, unknown>>([
    [StorageScope.GLOBAL, new Map()],
    [StorageScope.WORKSPACE, new Map()],
  ])
  private readonly _onDidChangeWorkspaceScope = new Emitter<void>()
  readonly onDidChangeWorkspaceScope = this._onDidChangeWorkspaceScope.event
  async get<T = unknown>(
    key: string,
    scope: StorageScope = StorageScope.GLOBAL,
  ): Promise<T | undefined> {
    return this.buckets.get(scope)?.get(key) as T | undefined
  }
  async set(key: string, value: unknown, scope: StorageScope = StorageScope.GLOBAL): Promise<void> {
    this.buckets.get(scope)!.set(key, value)
  }
  async remove(key: string, scope: StorageScope = StorageScope.GLOBAL): Promise<void> {
    this.buckets.get(scope)!.delete(key)
  }
}

class FakeWorkspaceService implements IWorkspaceService {
  declare readonly _serviceBrand: undefined
  readonly recent = []
  readonly onDidChangeRecent = Event.None
  readonly onDidChangeWorkspace = Event.None
  readonly whenReady: Promise<void> = Promise.resolve()
  get current(): IWorkspace | null {
    return { folder: URI.file('/work'), name: '/work' }
  }
  async openFolder(): Promise<void> {}
  async closeFolder(): Promise<void> {}
  async clearRecent(): Promise<void> {}
  async removeRecent(): Promise<void> {}
}

class StubLoggerService implements ILoggerService {
  declare readonly _serviceBrand: undefined
  createLogger(): ILogger {
    return new NullLogger()
  }
  setLevel(): void {}
  getLevel(): LogLevel {
    return LogLevel.Info
  }
}

/** Minimal IFileService: only readFileText is exercised by the tracker. */
class FakeFileService implements IFileService {
  declare readonly _serviceBrand: undefined
  readonly files = new Map<string, string>()
  /** Total readFileText calls — asserts the tracker doesn't fan out unboundedly. */
  reads = 0
  /** Currently in-flight reads and the peak, to bound open-handle pressure. */
  private _inFlight = 0
  peakInFlight = 0
  /** When set, readFileText resolves on the next microtask to expose concurrency. */
  deferReads = false
  set(path: string, content: string): void {
    this.files.set(URI.file(path).fsPath, content)
  }
  remove(path: string): void {
    this.files.delete(URI.file(path).fsPath)
  }
  async readFileText(resource: URI): Promise<string> {
    this.reads++
    this._inFlight++
    this.peakInFlight = Math.max(this.peakInFlight, this._inFlight)
    try {
      if (this.deferReads) await Promise.resolve()
      const c = this.files.get(resource.fsPath)
      if (c === undefined) throw new Error('ENOENT')
      return c
    } finally {
      this._inFlight--
    }
  }
  async readFile(): Promise<Uint8Array> {
    throw new Error('not implemented')
  }
  async writeFile(resource: URI, content: Uint8Array | string): Promise<void> {
    this.files.set(resource.fsPath, typeof content === 'string' ? content : content.toString())
  }
  async exists(resource: URI): Promise<boolean> {
    return this.files.has(resource.fsPath)
  }
  async stat(): Promise<IFileStat> {
    throw new Error('not implemented')
  }
  async list(): Promise<IDirectoryEntry[]> {
    return []
  }
  async createDirectory(): Promise<void> {}
  async delete(): Promise<void> {}
  async rename(): Promise<void> {}
  async copy(): Promise<void> {}
  async listRecursive(): Promise<string[]> {
    return []
  }
}

function makeService(platform: HostPlatform = 'linux'): {
  svc: SessionChangeTrackerService
  files: FakeFileService
} {
  const files = new FakeFileService()
  const svc = new SessionChangeTrackerService(
    new FakeStorage(),
    new FakeWorkspaceService(),
    new NoopTelemetryService(),
    new StubLoggerService(),
    files,
    new UriIdentityService(platform),
  )
  svc.recomputeThrottleMs = 0 // no throttle in tests — the 5ms flush settles it
  return { svc, files }
}

/** Let the async _recompute (reads file off disk) settle. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5))
}

const SID = 'sess-1'

/** A create hunk shaped like the real `diff` output (all-'+' lines). */
function createHunk(lines: readonly string[]): DiffHunk {
  return {
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines: lines.map((l) => `+${l}`),
  }
}

describe('SessionChangeTrackerService — added (Write create)', () => {
  let svc: SessionChangeTrackerService
  let files: FakeFileService
  beforeEach(async () => {
    const made = makeService()
    svc = made.svc
    files = made.files
    await svc.initialize()
  })
  afterEach(() => svc.dispose())

  it('surfaces a non-empty Write create as added with an empty baseline', async () => {
    files.set('/work/new.ts', 'alpha\nbeta')
    const obs = svc.changesFor(SID)
    svc.record(SID, '/work/new.ts', 'tc-1', [createHunk(['alpha', 'beta'])], { created: true })
    await flush()
    const list = obs.get()
    expect(list).toHaveLength(1)
    expect(list[0]?.status).toBe('added')
    expect(list[0]?.baseline).toBe('')
    expect(list[0]?.current).toBe('alpha\nbeta')
  })

  it('surfaces an EMPTY-content Write create (zero hunks) as added — the core bug', async () => {
    files.set('/work/empty.ts', '')
    const obs = svc.changesFor(SID)
    svc.record(SID, '/work/empty.ts', 'tc-empty', [], { created: true })
    await flush()
    const list = obs.get()
    expect(list).toHaveLength(1)
    expect(list[0]?.status).toBe('added')
    expect(list[0]?.baseline).toBe('')
  })

  it('drops a non-create call with zero hunks (no spurious entry)', async () => {
    files.set('/work/x.ts', 'whatever')
    const obs = svc.changesFor(SID)
    svc.record(SID, '/work/x.ts', 'tc-noop', [])
    await flush()
    expect(obs.get()).toHaveLength(0)
  })
})

describe('SessionChangeTrackerService — modified', () => {
  let svc: SessionChangeTrackerService
  let files: FakeFileService
  beforeEach(async () => {
    const made = makeService()
    svc = made.svc
    files = made.files
    await svc.initialize()
  })
  afterEach(() => svc.dispose())

  it('reconstructs the baseline and reports modified for an Edit', async () => {
    files.set('/work/m.ts', ['a', 'b', 'NEW', 'c'].join('\n'))
    const obs = svc.changesFor(SID)
    svc.record(SID, '/work/m.ts', 'tc-edit', [
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-OLD', '+NEW'] },
    ])
    await flush()
    const list = obs.get()
    expect(list).toHaveLength(1)
    expect(list[0]?.status).toBe('modified')
    expect(list[0]?.baseline).toBe(['a', 'b', 'OLD', 'c'].join('\n'))
  })
})

describe('SessionChangeTrackerService — restore (codex rewind file rollback)', () => {
  let svc: SessionChangeTrackerService
  let files: FakeFileService
  beforeEach(async () => {
    const made = makeService()
    svc = made.svc
    files = made.files
    await svc.initialize()
  })
  afterEach(() => svc.dispose())

  it('un-applies only the named post-anchor batches and writes files back', async () => {
    // Two sequential edits to the same file: tc-1 (kept, pre-anchor) then tc-2
    // (post-anchor, to be rolled back). Current disk reflects both.
    files.set('/work/f.ts', ['a', 'TWO', 'c'].join('\n'))
    svc.record(SID, '/work/f.ts', 'tc-1', [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-A', '+a'] },
    ])
    svc.record(SID, '/work/f.ts', 'tc-2', [
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-ONE', '+TWO'] },
    ])
    await flush()

    const impact = await svc.restore(SID, ['tc-2'])
    expect(impact.filesChanged).toEqual(['/work/f.ts'])
    expect(impact.insertions).toBe(1)
    expect(impact.deletions).toBe(1)
    // Only tc-2 rolled back: 'TWO' → 'ONE'; tc-1's 'a' stays.
    expect(files.files.get(URI.file('/work/f.ts').fsPath)).toBe(['a', 'ONE', 'c'].join('\n'))
  })

  it('previewRestore computes impact without touching disk', async () => {
    files.set('/work/f.ts', ['a', 'TWO'].join('\n'))
    svc.record(SID, '/work/f.ts', 'tc-2', [
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-ONE', '+TWO'] },
    ])
    await flush()

    const impact = await svc.previewRestore(SID, ['tc-2'])
    expect(impact.filesChanged).toEqual(['/work/f.ts'])
    // Disk unchanged by a preview.
    expect(files.files.get(URI.file('/work/f.ts').fsPath)).toBe(['a', 'TWO'].join('\n'))
  })

  it('returns an empty impact when no batches match', async () => {
    files.set('/work/f.ts', 'x')
    svc.record(SID, '/work/f.ts', 'tc-1', [createHunk(['x'])], { created: true })
    await flush()
    const impact = await svc.restore(SID, ['tc-missing'])
    expect(impact.filesChanged).toEqual([])
  })
})

describe('SessionChangeTrackerService — size budgets (OOM guard)', () => {
  // A workspace bucket once accumulated ~150MB of hunks; loading it shuttled
  // 100MB+ payloads across IPC/log channels and aborted the main process.

  class CapturingLoggerService implements ILoggerService {
    declare readonly _serviceBrand: undefined
    readonly infos: string[] = []
    createLogger(): ILogger {
      const infos = this.infos
      return {
        info: (msg: string) => {
          infos.push(msg)
        },
      } as unknown as ILogger
    }
    setLevel(): void {}
    getLevel(): LogLevel {
      return LogLevel.Info
    }
  }

  function makeBudgeted(overrides: {
    maxTrackedSessions?: number
    maxSessionBytes?: number
    maxTotalBytes?: number
    storage?: FakeStorage
    loggerService?: ILoggerService
  }): { svc: SessionChangeTrackerService; files: FakeFileService; storage: FakeStorage } {
    const storage = overrides.storage ?? new FakeStorage()
    const files = new FakeFileService()
    const svc = new SessionChangeTrackerService(
      storage,
      new FakeWorkspaceService(),
      new NoopTelemetryService(),
      overrides.loggerService ?? new StubLoggerService(),
      files,
      new UriIdentityService('linux'),
    )
    svc.recomputeThrottleMs = 0
    if (overrides.maxTrackedSessions !== undefined) {
      svc.maxTrackedSessions = overrides.maxTrackedSessions
    }
    if (overrides.maxSessionBytes !== undefined) svc.maxSessionBytes = overrides.maxSessionBytes
    if (overrides.maxTotalBytes !== undefined) svc.maxTotalBytes = overrides.maxTotalBytes
    return { svc, files, storage }
  }

  function persistedSessionIds(storage: FakeStorage): string[] {
    const raw = storage.buckets.get(StorageScope.WORKSPACE)?.get('acp.sessionChanges') as
      | { sessions: { sessionId: string }[] }
      | undefined
    return (raw?.sessions ?? []).map((s) => s.sessionId)
  }

  /** ~100-byte batch, comfortably below the small budgets used here. */
  function smallEdit(toolCallId: string): { toolCallId: string; hunks: DiffHunk[] } {
    return {
      toolCallId,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
    }
  }

  it('skips a single batch that alone exceeds the per-session budget', async () => {
    const { svc, files, storage } = makeBudgeted({ maxSessionBytes: 64 })
    await svc.initialize()
    files.set('/work/big.ts', 'x'.repeat(500))
    const obs = svc.changesFor(SID)
    svc.record(SID, '/work/big.ts', 'tc-big', [createHunk(['x'.repeat(500)])], { created: true })
    await flush()
    expect(obs.get()).toHaveLength(0)
    svc.dispose()
    expect(storage.buckets.get(StorageScope.WORKSPACE)?.has('acp.sessionChanges')).toBe(false)
  })

  it('over-budget hunks drop rollback batches but keep the pinned-baseline diff', async () => {
    const { svc, files } = makeBudgeted({ maxSessionBytes: 200 })
    await svc.initialize()
    files.set('/work/a.ts', 'b')
    const obs = svc.changesFor(SID)
    const first = smallEdit('tc-1')
    svc.record(SID, '/work/a.ts', first.toolCallId, first.hunks, { baseline: 'a' })
    await flush()
    expect(obs.get()).toHaveLength(1)
    // A second batch tips the session over budget — batches are dropped (rewind
    // rollback degraded) but the baseline-vs-disk diff survives.
    const second = smallEdit('tc-2')
    svc.record(SID, '/work/a.ts', second.toolCallId, second.hunks)
    await flush()
    const list = obs.get()
    expect(list).toHaveLength(1)
    expect(list[0]?.baseline).toBe('a')
    expect(list[0]?.status).toBe('modified')
    const impact = await svc.restore(SID, ['tc-1', 'tc-2'])
    expect(impact.filesChanged).toEqual([])
    svc.dispose()
  })

  it('drops entries without a baseline once accumulated hunks exceed the budget', async () => {
    const { svc, files } = makeBudgeted({ maxSessionBytes: 150 })
    await svc.initialize()
    files.set('/work/a.ts', 'b')
    const obs = svc.changesFor(SID)
    const first = smallEdit('tc-1')
    svc.record(SID, '/work/a.ts', first.toolCallId, first.hunks)
    await flush()
    expect(obs.get()).toHaveLength(1)
    // No baseline was ever reported, so once the batches are dropped there is
    // nothing left to diff against — the entry disappears.
    const second = smallEdit('tc-2')
    svc.record(SID, '/work/a.ts', second.toolCallId, second.hunks)
    await flush()
    expect(obs.get()).toHaveLength(0)
    svc.dispose()
  })

  it('evicts the least-recently-recorded session beyond the count cap', async () => {
    const { svc, files, storage } = makeBudgeted({ maxTrackedSessions: 3 })
    await svc.initialize()
    for (const s of ['s1', 's2', 's3', 's4']) {
      files.set(`/work/${s}.ts`, 'v')
      svc.record(s, `/work/${s}.ts`, 'tc-1', [createHunk(['v'])], { created: true })
    }
    svc.dispose() // flush the debounced write
    expect(persistedSessionIds(storage)).toEqual(['s2', 's3', 's4'])
  })

  it('prunes over-budget and malformed sessions on load, persisting the slimmed state', async () => {
    const storage = new FakeStorage()
    storage.buckets.get(StorageScope.WORKSPACE)?.set('acp.sessionChanges', {
      schemaVersion: 3,
      sessions: [
        {
          // Baselines alone exceed the budget — batch-clearing can't save this
          // session, so it is dropped whole on load.
          sessionId: 'huge',
          files: [{ path: '/work/h.ts', batches: [], baseline: 'x'.repeat(1000) }],
        },
        { sessionId: 'small', files: [{ path: '/work/s.ts', batches: [smallEdit('tc-1')] }] },
        { bogus: true },
      ],
    })
    const { svc, files } = makeBudgeted({ maxSessionBytes: 512, storage })
    await svc.initialize()
    files.set('/work/s.ts', 'b')
    const obs = svc.changesFor('small')
    await flush()
    expect(obs.get()).toHaveLength(1) // the healthy session survives pruning
    svc.dispose() // flush the pruned-state write
    expect(persistedSessionIds(storage)).toEqual(['small'])
  })

  it('clears batches but keeps the session when only the batches blow the budget on load', async () => {
    const storage = new FakeStorage()
    storage.buckets.get(StorageScope.WORKSPACE)?.set('acp.sessionChanges', {
      schemaVersion: 3,
      sessions: [
        {
          sessionId: 'bulky',
          files: [
            {
              path: '/work/h.ts',
              baseline: 'a',
              batches: [
                {
                  toolCallId: 'tc-9',
                  hunks: [
                    {
                      oldStart: 1,
                      oldLines: 0,
                      newStart: 1,
                      newLines: 1,
                      lines: [`+${'x'.repeat(1000)}`],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
    const { svc, files } = makeBudgeted({ maxSessionBytes: 512, storage })
    await svc.initialize()
    files.set('/work/h.ts', 'b')
    const obs = svc.changesFor('bulky')
    await flush()
    const list = obs.get()
    expect(list).toHaveLength(1)
    expect(list[0]?.baseline).toBe('a')
    svc.dispose()
    expect(persistedSessionIds(storage)).toEqual(['bulky'])
  })

  it('discards pre-v3 persisted data instead of migrating it', async () => {
    const storage = new FakeStorage()
    storage.buckets.get(StorageScope.WORKSPACE)?.set('acp.sessionChanges', {
      schemaVersion: 2,
      sessions: [
        { sessionId: 'legacy', files: [{ path: '/work/a.ts', batches: [smallEdit('tc-1')] }] },
      ],
    })
    const { svc, files } = makeBudgeted({ storage })
    await svc.initialize()
    files.set('/work/a.ts', 'b')
    const obs = svc.changesFor('legacy')
    await flush()
    expect(obs.get()).toHaveLength(0)
    svc.dispose()
  })

  it('logs a bounded summary instead of the full state on load', async () => {
    const storage = new FakeStorage()
    storage.buckets.get(StorageScope.WORKSPACE)?.set('acp.sessionChanges', {
      schemaVersion: 3,
      sessions: [
        { sessionId: 's1', files: [{ path: '/work/a.ts', batches: [smallEdit('tc-1')] }] },
      ],
    })
    const loggers = new CapturingLoggerService()
    const { svc } = makeBudgeted({ storage, loggerService: loggers })
    await svc.initialize()
    const loadLine = loggers.infos.find((m) => m.includes('loaded from'))
    expect(loadLine).toBeDefined()
    expect(loadLine!.length).toBeLessThan(200)
    expect(loadLine).toContain('1 entries')
    svc.dispose()
  })
})

describe('SessionChangeTrackerService — pinned baseline (agent-reported pre-edit content)', () => {
  let svc: SessionChangeTrackerService
  let files: FakeFileService
  beforeEach(async () => {
    const made = makeService()
    svc = made.svc
    files = made.files
    await svc.initialize()
  })
  afterEach(() => svc.dispose())

  const edit = (toolCallId: string): { toolCallId: string; hunks: DiffHunk[] } => ({
    toolCallId,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
  })

  it('pins the first reported baseline and ignores later reports (first-touch-wins)', async () => {
    files.set('/work/p.ts', 'current')
    const obs = svc.changesFor(SID)
    const e1 = edit('tc-1')
    svc.record(SID, '/work/p.ts', e1.toolCallId, e1.hunks, { baseline: 'first' })
    const e2 = edit('tc-2')
    svc.record(SID, '/work/p.ts', e2.toolCallId, e2.hunks, { baseline: 'second' })
    await flush()
    const list = obs.get()
    expect(list).toHaveLength(1)
    expect(list[0]?.baseline).toBe('first')
    expect(list[0]?.baselineSource).toBe('reported')
    expect(list[0]?.status).toBe('modified')
    expect(list[0]?.batchCount).toBe(2)
  })

  it('stays comparable when the user hand-edits on top of the agent edit', async () => {
    // The historic false-positive: hunk un-apply against a hand-edited file
    // either degraded or silently rebuilt a wrong baseline. With a pinned
    // baseline the diff is always pinned-vs-disk, whatever the disk holds.
    files.set('/work/p.ts', 'user tweaked this afterwards')
    const obs = svc.changesFor(SID)
    const e1 = edit('tc-1')
    svc.record(SID, '/work/p.ts', e1.toolCallId, e1.hunks, { baseline: 'agent saw this' })
    await flush()
    const list = obs.get()
    expect(list[0]?.status).toBe('modified')
    expect(list[0]?.baseline).toBe('agent saw this')
    expect(list[0]?.current).toBe('user tweaked this afterwards')
  })

  it('treats a null baseline as created even without the created flag', async () => {
    files.set('/work/n.ts', 'body')
    const obs = svc.changesFor(SID)
    const e1 = edit('tc-1')
    svc.record(SID, '/work/n.ts', e1.toolCallId, e1.hunks, { baseline: null })
    await flush()
    const list = obs.get()
    expect(list[0]?.status).toBe('added')
    expect(list[0]?.baseline).toBe('')
  })

  it('self-heals out of the list when disk returns to the pinned baseline', async () => {
    files.set('/work/s.ts', 'same')
    const obs = svc.changesFor(SID)
    const e1 = edit('tc-1')
    svc.record(SID, '/work/s.ts', e1.toolCallId, e1.hunks, { baseline: 'same' })
    await flush()
    expect(obs.get()).toHaveLength(0)
  })

  it('keeps the pinned baseline for a deleted file so the diff stays previewable', async () => {
    const obs = svc.changesFor(SID)
    const e1 = edit('tc-1')
    svc.record(SID, '/work/gone.ts', e1.toolCallId, e1.hunks, { baseline: 'was here' })
    await flush()
    const list = obs.get()
    expect(list[0]?.status).toBe('deleted')
    expect(list[0]?.baseline).toBe('was here')
  })

  it('drops a created-then-deleted file as net-zero', async () => {
    const obs = svc.changesFor(SID)
    svc.record(SID, '/work/tmp.ts', 'tc-1', [createHunk(['x'])], { created: true, baseline: null })
    await flush()
    expect(obs.get()).toHaveLength(0)
  })

  it('falls back to hunk reconstruction when the baseline exceeds the per-file cap', async () => {
    svc.maxBaselineBytes = 16
    files.set('/work/big.ts', ['a', 'b', 'NEW', 'c'].join('\n'))
    const obs = svc.changesFor(SID)
    svc.record(
      SID,
      '/work/big.ts',
      'tc-1',
      [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-OLD', '+NEW'] }],
      { baseline: 'x'.repeat(100) },
    )
    await flush()
    const list = obs.get()
    expect(list[0]?.baselineSource).toBe('reconstructed')
    expect(list[0]?.baseline).toBe(['a', 'b', 'OLD', 'c'].join('\n'))
  })
})

describe('SessionChangeTrackerService — watched changes (fs-watch fallback)', () => {
  let svc: SessionChangeTrackerService
  let files: FakeFileService
  beforeEach(async () => {
    const made = makeService()
    svc = made.svc
    files = made.files
    await svc.initialize()
  })
  afterEach(() => svc.dispose())

  it('surfaces a watched change with a git baseline', async () => {
    files.set('/work/w.ts', 'now')
    const obs = svc.changesFor(SID)
    svc.recordWatched(SID, '/work/w.ts', { baseline: 'head' })
    await flush()
    const list = obs.get()
    expect(list).toHaveLength(1)
    expect(list[0]?.origin).toBe('watched')
    expect(list[0]?.baselineSource).toBe('git')
    expect(list[0]?.status).toBe('modified')
    expect(list[0]?.baseline).toBe('head')
  })

  it('marks a watched file created when git reports it did not exist before', async () => {
    files.set('/work/new.ts', 'fresh')
    const obs = svc.changesFor(SID)
    svc.recordWatched(SID, '/work/new.ts', { baseline: null })
    await flush()
    const list = obs.get()
    expect(list[0]?.status).toBe('added')
    expect(list[0]?.baseline).toBe('')
  })

  it('degrades a watched change with no obtainable baseline instead of claiming a diff', async () => {
    files.set('/work/u.ts', 'now')
    const obs = svc.changesFor(SID)
    svc.recordWatched(SID, '/work/u.ts')
    await flush()
    const list = obs.get()
    expect(list[0]?.status).toBe('degraded')
    expect(list[0]?.baselineSource).toBe('none')
    expect(list[0]?.baseline).toBe('now')
  })

  it('never downgrades an agent-tracked file to watched', async () => {
    files.set('/work/a.ts', 'now')
    const obs = svc.changesFor(SID)
    svc.record(
      SID,
      '/work/a.ts',
      'tc-1',
      [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
      { baseline: 'agent' },
    )
    svc.recordWatched(SID, '/work/a.ts', { baseline: 'git-head' })
    await flush()
    const list = obs.get()
    expect(list).toHaveLength(1)
    expect(list[0]?.origin).toBe('agent')
    expect(list[0]?.baseline).toBe('agent')
  })

  it('dismissWatched hides the entry and blocks re-adds from the watcher', async () => {
    files.set('/work/w.ts', 'now')
    const obs = svc.changesFor(SID)
    svc.recordWatched(SID, '/work/w.ts', { baseline: 'head' })
    await flush()
    expect(obs.get()).toHaveLength(1)
    svc.dismissWatched(SID, '/work/w.ts')
    await flush()
    expect(obs.get()).toHaveLength(0)
    svc.recordWatched(SID, '/work/w.ts', { baseline: 'head' })
    await flush()
    expect(obs.get()).toHaveLength(0)
  })

  it('an agent report un-dismisses and upgrades a dismissed watched entry', async () => {
    files.set('/work/w.ts', 'now')
    const obs = svc.changesFor(SID)
    svc.recordWatched(SID, '/work/w.ts', { baseline: 'head' })
    svc.dismissWatched(SID, '/work/w.ts')
    svc.record(SID, '/work/w.ts', 'tc-1', [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
    ])
    await flush()
    const list = obs.get()
    expect(list).toHaveLength(1)
    expect(list[0]?.origin).toBe('agent')
    // The watched entry's earlier git baseline stays pinned (first-touch-wins).
    expect(list[0]?.baseline).toBe('head')
    expect(list[0]?.baselineSource).toBe('git')
  })
})

describe('SessionChangeTrackerService — path identity (Windows drive-letter casing)', () => {
  // claude-code reports lowercase drive letters (d:/...) on Windows while the
  // fs-watch fallback reports the workspace folder's casing (D:/...). Both
  // ingresses must key the same record, or the session diff lists the file twice.
  function makeWin32(): { svc: SessionChangeTrackerService; files: FakeFileService } {
    return makeService('win32')
  }

  const editHunk: DiffHunk = {
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: ['-a', '+b'],
  }

  it('recordWatched after an agent record with a different drive-letter casing refreshes, not duplicates', async () => {
    const { svc, files } = makeWin32()
    await svc.initialize()
    files.set('d:/work/w.ts', 'now')
    const obs = svc.changesFor(SID)
    svc.record(SID, 'd:/work/w.ts', 'tc-1', [editHunk], { baseline: 'agent' })
    svc.recordWatched(SID, 'D:/work/w.ts', { baseline: 'git-head' })
    await flush()
    const list = obs.get()
    expect(list).toHaveLength(1)
    expect(list[0]?.origin).toBe('agent')
    expect(list[0]?.baseline).toBe('agent')
    svc.dispose()
  })

  it('an agent record after recordWatched with a different casing upgrades the same record', async () => {
    const { svc, files } = makeWin32()
    await svc.initialize()
    files.set('d:/work/w.ts', 'now')
    const obs = svc.changesFor(SID)
    svc.recordWatched(SID, 'D:/work/w.ts', { baseline: 'head' })
    svc.record(SID, 'd:/work/w.ts', 'tc-1', [editHunk])
    await flush()
    const list = obs.get()
    expect(list).toHaveLength(1)
    expect(list[0]?.origin).toBe('agent')
    // The watched entry's earlier git baseline stays pinned (first-touch-wins).
    expect(list[0]?.baseline).toBe('head')
    expect(list[0]?.baselineSource).toBe('git')
    svc.dispose()
  })

  it('dismissWatched matches across casings and keeps the entry dismissed', async () => {
    const { svc, files } = makeWin32()
    await svc.initialize()
    files.set('d:/work/w.ts', 'now')
    const obs = svc.changesFor(SID)
    svc.recordWatched(SID, 'D:/work/w.ts', { baseline: 'head' })
    await flush()
    expect(obs.get()).toHaveLength(1)
    svc.dismissWatched(SID, 'd:/work/w.ts')
    await flush()
    expect(obs.get()).toHaveLength(0)
    svc.recordWatched(SID, 'D:/work/w.ts', { baseline: 'head' })
    await flush()
    expect(obs.get()).toHaveLength(0)
    svc.dispose()
  })
})

describe('SessionChangeTrackerService — edit-storm resilience (EMFILE guard)', () => {
  /** Build a service with a real throttle so a burst of records coalesces. */
  function makeThrottled(throttleMs: number): {
    svc: SessionChangeTrackerService
    files: FakeFileService
  } {
    const files = new FakeFileService()
    const svc = new SessionChangeTrackerService(
      new FakeStorage(),
      new FakeWorkspaceService(),
      new NoopTelemetryService(),
      new StubLoggerService(),
      files,
      new UriIdentityService('linux'),
    )
    svc.recomputeThrottleMs = throttleMs
    return { svc, files }
  }

  it('coalesces a burst of records into a single recompute', async () => {
    const { svc, files } = makeThrottled(20)
    await svc.initialize()
    // 200 tracked files, each edited many times in a tight loop — the shape that
    // exhausted file handles in production.
    for (let f = 0; f < 200; f++) files.set(`/work/f${f}.ts`, `v${f}`)
    const obs = svc.changesFor(SID)
    for (let round = 0; round < 50; round++) {
      for (let f = 0; f < 200; f++) {
        svc.record(SID, `/work/f${f}.ts`, `tc-${f}-${round}`, [createHunk([`v${f}`])], {
          created: true,
        })
      }
    }
    // Before the throttle fires, no recompute reads have happened yet.
    expect(files.reads).toBe(0)
    await new Promise((r) => setTimeout(r, 40))
    // Exactly one recompute pass ran: one read per file, not per (file × edit).
    expect(files.reads).toBe(200)
    expect(obs.get()).toHaveLength(200)
    svc.dispose()
  })

  it('bounds concurrent reads within a recompute', async () => {
    const { svc, files } = makeThrottled(0)
    await svc.initialize()
    const obs = svc.changesFor(SID)
    files.deferReads = true
    for (let f = 0; f < 100; f++) {
      files.set(`/work/f${f}.ts`, `v${f}`)
      svc.record(SID, `/work/f${f}.ts`, `tc-${f}`, [createHunk([`v${f}`])], { created: true })
    }
    await new Promise((r) => setTimeout(r, 20))
    expect(files.reads).toBe(100)
    expect(obs.get()).toHaveLength(100)
    // Never open more than the concurrency cap at once, regardless of file count.
    expect(files.peakInFlight).toBeLessThanOrEqual(8)
    svc.dispose()
  })
})
