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
  set(path: string, content: string): void {
    this.files.set(URI.file(path).fsPath, content)
  }
  remove(path: string): void {
    this.files.delete(URI.file(path).fsPath)
  }
  async readFileText(resource: URI): Promise<string> {
    const c = this.files.get(resource.fsPath)
    if (c === undefined) throw new Error('ENOENT')
    return c
  }
  async readFile(): Promise<Uint8Array> {
    throw new Error('not implemented')
  }
  async writeFile(): Promise<void> {}
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

describe('SessionChangeTrackerService — deleted', () => {
  let svc: SessionChangeTrackerService
  let files: FakeFileService
  beforeEach(async () => {
    const made = makeService()
    svc = made.svc
    files = made.files
    await svc.initialize()
  })
  afterEach(() => svc.dispose())

  it('marks a deleted file with no baseline diff', async () => {
    // File is gone from disk (never seeded), markDeleted records it.
    const obs = svc.changesFor(SID)
    svc.markDeleted(SID, '/work/gone.ts')
    await flush()
    const list = obs.get()
    expect(list).toHaveLength(1)
    expect(list[0]?.status).toBe('deleted')
    expect(list[0]?.baseline).toBe('')
    expect(list[0]?.current).toBe('')
  })

  it('does not show a marked file that still exists on disk', async () => {
    files.set('/work/here.ts', 'still here')
    const obs = svc.changesFor(SID)
    svc.markDeleted(SID, '/work/here.ts')
    await flush()
    // Pure deletion marker but the file is present → nothing surfaces.
    expect(obs.get()).toHaveLength(0)
  })

  it('unmarkDeleted removes the entry when the file is re-created', async () => {
    const obs = svc.changesFor(SID)
    svc.markDeleted(SID, '/work/back.ts')
    await flush()
    expect(obs.get()).toHaveLength(1)
    files.set('/work/back.ts', 'recreated')
    svc.unmarkDeleted(SID, '/work/back.ts')
    await flush()
    expect(obs.get()).toHaveLength(0)
  })

  it('an edited-then-deleted file reports deleted (not degraded)', async () => {
    files.set('/work/edited.ts', ['a', 'NEW', 'c'].join('\n'))
    const obs = svc.changesFor(SID)
    svc.record(SID, '/work/edited.ts', 'tc-1', [
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-OLD', '+NEW'] },
    ])
    await flush()
    expect(obs.get()[0]?.status).toBe('modified')
    // Agent then removes it; the file disappears and markDeleted fires.
    files.remove('/work/edited.ts')
    svc.markDeleted(SID, '/work/edited.ts')
    await flush()
    const list = obs.get()
    expect(list).toHaveLength(1)
    expect(list[0]?.status).toBe('deleted')
  })
})
