import { describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Event,
  LogLevel,
  NoopTelemetryService,
  NullLogger,
  StorageScope,
  URI,
  type ILogger,
  type ILoggerService,
  type IStorageService,
  type IWorkspace,
  type IWorkspaceService,
} from '@universe-editor/platform'
import type { SelectionContext } from '../../promptContext.js'
import {
  AcpMessageAttachmentStore,
  enforceAcpMessageAttachmentBudgets,
  type AcpMessageAttachmentRecord,
} from '../acpMessageAttachmentStore.js'

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly buckets = new Map<StorageScope, Map<string, unknown>>([
    [StorageScope.GLOBAL, new Map()],
    [StorageScope.WORKSPACE, new Map()],
  ])
  private readonly _onDidChangeWorkspaceScope = new Emitter<void>()
  readonly onDidChangeWorkspaceScope = this._onDidChangeWorkspaceScope.event

  async get<T = unknown>(key: string, scope = StorageScope.GLOBAL): Promise<T | undefined> {
    return this.buckets.get(scope)?.get(key) as T | undefined
  }

  async set(key: string, value: unknown, scope = StorageScope.GLOBAL): Promise<void> {
    this.buckets.get(scope)!.set(key, value)
  }

  async remove(key: string, scope = StorageScope.GLOBAL): Promise<void> {
    this.buckets.get(scope)!.delete(key)
  }
}

class FakeWorkspace implements IWorkspaceService {
  declare readonly _serviceBrand: undefined
  readonly current: IWorkspace = { folder: URI.file('/work'), name: 'work' }
  readonly recent = []
  readonly onDidChangeRecent = Event.None
  readonly onDidChangeWorkspace = Event.None
  readonly whenReady = Promise.resolve()
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

const SELECTION: SelectionContext = {
  uri: 'file:///work/src/a.ts',
  relPath: 'src/a.ts',
  text: 'const answer = 42',
  startLine: 3,
  endLine: 3,
  languageId: 'typescript',
}

type MutableSelectionContext = { -readonly [K in keyof SelectionContext]: SelectionContext[K] }

function makeStore(storage = new FakeStorage()): AcpMessageAttachmentStore {
  return new AcpMessageAttachmentStore(
    storage,
    new FakeWorkspace(),
    new NoopTelemetryService(),
    new StubLoggerService(),
  )
}

describe('AcpMessageAttachmentStore', () => {
  it('saves defensive snapshots and removes selected messages', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10)
    const store = makeStore()
    const input: MutableSelectionContext[] = [{ ...SELECTION }]
    store.saveSelections('session', 'm1', input)
    input[0]!.text = 'mutated'

    const loaded = store.getSelections('session', 'm1') as MutableSelectionContext[]
    expect(loaded).toEqual([SELECTION])
    loaded[0]!.text = 'also mutated'
    expect(store.getSelections('session', 'm1')).toEqual([SELECTION])

    store.removeMessages('session', ['m1'])
    expect(store.getSelections('session', 'm1')).toEqual([])
    vi.restoreAllMocks()
  })

  it('copies a filtered message set and replaces target session attachments', () => {
    const store = makeStore()
    store.saveSelections('source', 'm1', [SELECTION])
    store.saveSelections('source', 'm2', [{ ...SELECTION, text: 'second' }])
    store.saveSelections('target', 'stale', [SELECTION])

    store.copySession('source', 'target', ['m2'])

    expect(store.getSelections('target', 'stale')).toEqual([])
    expect(store.getSelections('target', 'm1')).toEqual([])
    expect(store.getSelections('target', 'm2')).toEqual([{ ...SELECTION, text: 'second' }])
  })

  it('persists schema v1 in workspace scope and reloads it', async () => {
    vi.useFakeTimers()
    const storage = new FakeStorage()
    const first = makeStore(storage)
    await first.initialize()
    first.saveSelections('session', 'm1', [SELECTION])
    await vi.advanceTimersByTimeAsync(110)

    expect(storage.buckets.get(StorageScope.WORKSPACE)!.get('acp.messageAttachments')).toEqual({
      schemaVersion: 1,
      entries: [expect.objectContaining({ sessionId: 'session', messageId: 'm1' })],
    })

    const second = makeStore(storage)
    await second.initialize()
    expect(second.getSelections('session', 'm1')).toEqual([SELECTION])
    vi.useRealTimers()
  })

  it('removes an entire session and clears all records', () => {
    const store = makeStore()
    store.saveSelections('a', 'm1', [SELECTION])
    store.saveSelections('b', 'm2', [SELECTION])
    store.removeSession('a')
    expect(store.getSelections('a', 'm1')).toEqual([])
    expect(store.getSelections('b', 'm2')).toEqual([SELECTION])
    store.clear()
    expect(store.getSelections('b', 'm2')).toEqual([])
  })
})

describe('enforceAcpMessageAttachmentBudgets', () => {
  const record = (
    sessionId: string,
    messageId: string,
    updatedAt: number,
    text: string,
  ): AcpMessageAttachmentRecord => ({
    sessionId,
    messageId,
    updatedAt,
    selections: [{ ...SELECTION, text }],
  })

  it('evicts the oldest records per session before enforcing the total budget', () => {
    const entries = [
      record('a', 'old', 1, 'x'.repeat(100)),
      record('a', 'new', 3, 'x'.repeat(100)),
      record('b', 'middle', 2, 'x'.repeat(100)),
    ]
    const oneRecordBytes = new TextEncoder().encode(JSON.stringify(entries[0])).byteLength

    const result = enforceAcpMessageAttachmentBudgets(entries, {
      perSession: oneRecordBytes + 10,
      total: oneRecordBytes * 2 + 20,
    })

    expect(result.entries.map((entry) => entry.messageId)).toEqual(['new', 'middle'])
    expect(result.evicted).toBe(1)
  })

  it('drops a single oversized record without rejecting the caller', () => {
    const result = enforceAcpMessageAttachmentBudgets([record('a', 'huge', 1, 'x'.repeat(100))], {
      perSession: 1,
      total: 1,
    })
    expect(result).toEqual({ entries: [], evicted: 1 })
  })

  it('evicts globally oldest records when the total budget is exceeded', () => {
    const entries = [
      record('a', 'old', 1, 'x'.repeat(100)),
      record('b', 'middle', 2, 'x'.repeat(100)),
      record('c', 'new', 3, 'x'.repeat(100)),
    ]
    const newestTwoBytes = entries
      .slice(1)
      .reduce((sum, entry) => sum + new TextEncoder().encode(JSON.stringify(entry)).byteLength, 0)

    const result = enforceAcpMessageAttachmentBudgets(entries, {
      perSession: Number.MAX_SAFE_INTEGER,
      total: newestTwoBytes,
    })

    expect(result.entries.map((entry) => entry.messageId)).toEqual(['middle', 'new'])
    expect(result.evicted).toBe(1)
  })
})
