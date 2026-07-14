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
import type { DiffHunk } from '../diff/reconstructBaseline.js'

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

function makeService(): { svc: SessionChangeTrackerService; files: FakeFileService } {
  const files = new FakeFileService()
  const svc = new SessionChangeTrackerService(
    new FakeStorage(),
    new FakeWorkspaceService(),
    new NoopTelemetryService(),
    new StubLoggerService(),
    files,
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
    svc.record(SID, '/work/new.ts', 'tc-1', [createHunk(['alpha', 'beta'])], true)
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
    svc.record(SID, '/work/empty.ts', 'tc-empty', [], true)
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
    svc.record(SID, '/work/f.ts', 'tc-1', [createHunk(['x'])], true)
    await flush()
    const impact = await svc.restore(SID, ['tc-missing'])
    expect(impact.filesChanged).toEqual([])
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
        svc.record(SID, `/work/f${f}.ts`, `tc-${f}-${round}`, [createHunk([`v${f}`])], true)
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
      svc.record(SID, `/work/f${f}.ts`, `tc-${f}`, [createHunk([`v${f}`])], true)
    }
    await new Promise((r) => setTimeout(r, 20))
    expect(files.reads).toBe(100)
    expect(obs.get()).toHaveLength(100)
    // Never open more than the concurrency cap at once, regardless of file count.
    expect(files.peakInFlight).toBeLessThanOrEqual(8)
    svc.dispose()
  })
})
