/*---------------------------------------------------------------------------------------------
 *  Tests for SessionChangesStoreMainService — v2 per-session directories,
 *  chunked baselines, index commits/GC, v1 compatibility, manifest and handles.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LogLevel,
  StorageScope,
  type ILogger,
  type ILoggerService,
} from '@universe-editor/platform'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { createStorage } from '../../../storage.js'
import { MainStorageService } from '../storageMainService.js'
import {
  SessionChangesStoreMainService,
  _getSharedBucketCountForTests,
  type SessionChangesStoreMainServiceOptions,
} from '../sessionChangesStoreMainService.js'
import {
  SESSION_CHANGES_BASELINE_CHUNK_CHARS,
  type SessionChangesIndexEntry,
} from '../../../../shared/ipc/sessionChangesStoreService.js'

let tmpRoot: string

vi.mock('electron', () => ({
  app: { getPath: () => tmpRoot },
}))

class CapturingLoggerService implements ILoggerService {
  declare readonly _serviceBrand: undefined
  readonly logs: string[] = []
  createLogger(): ILogger {
    const logs = this.logs
    return {
      info: (msg: string) => logs.push(msg),
      warn: (msg: string) => logs.push(`WARN ${msg}`),
    } as unknown as ILogger
  }
  setLevel(): void {}
  getLevel(): LogLevel {
    return LogLevel.Info
  }
}

function payload(sessionId: string, files: readonly unknown[] = []): unknown {
  return { schemaVersion: 3, sessionId, files }
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function shardFileName(sessionId: string): string {
  return `${hashKey(sessionId)}.json`
}

function sessionDir(userDataDir: string, workspaceId: string, sessionId: string): string {
  return join(userDataDir, 'session-changes', workspaceId, 'sessions', hashKey(sessionId))
}

function entryPath(
  userDataDir: string,
  workspaceId: string,
  sessionId: string,
  key: string,
  gen: string,
): string {
  return join(
    sessionDir(userDataDir, workspaceId, sessionId),
    'files',
    `${hashKey(key)}.${gen}.json`,
  )
}

function baselinePath(
  userDataDir: string,
  workspaceId: string,
  sessionId: string,
  key: string,
  gen: string,
): string {
  return join(
    sessionDir(userDataDir, workspaceId, sessionId),
    'baselines',
    `${hashKey(key)}.${gen}.json`,
  )
}

function dirNames(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function entryDir(userDataDir: string, workspaceId: string, sessionId: string): string {
  return join(sessionDir(userDataDir, workspaceId, sessionId), 'files')
}

function baselineDir(userDataDir: string, workspaceId: string, sessionId: string): string {
  return join(sessionDir(userDataDir, workspaceId, sessionId), 'baselines')
}

function indexEntry(
  key: string,
  overrides: Partial<SessionChangesIndexEntry> = {},
): SessionChangesIndexEntry {
  return {
    key,
    path: key,
    batchCount: 0,
    origin: 'agent',
    gen: 'a1',
    ...overrides,
  }
}

function chunks(text: string): string[] {
  if (text.length <= SESSION_CHANGES_BASELINE_CHUNK_CHARS) return [text]
  const out: string[] = []
  for (let i = 0; i < text.length; i += SESSION_CHANGES_BASELINE_CHUNK_CHARS) {
    out.push(text.slice(i, i + SESSION_CHANGES_BASELINE_CHUNK_CHARS))
  }
  return out
}

async function writeBaseline(
  store: SessionChangesStoreMainService,
  handle: string,
  sessionId: string,
  key: string,
  gen: string,
  text: string,
): Promise<void> {
  const parts = chunks(text)
  for (let i = 0; i < parts.length; i++) {
    expect(
      await store.writeBaseline(handle, sessionId, key, gen, {
        index: i,
        count: parts.length,
        text: parts[i]!,
      }),
    ).toEqual({ ok: true })
  }
}

async function writeV2(
  store: SessionChangesStoreMainService,
  handle: string,
  sessionId: string,
  files: Array<{
    key: string
    path?: string
    batches?: readonly unknown[]
    baseline?: string | null
    baselineSource?: 'reported' | 'git'
    batchCount?: number
    origin?: 'agent' | 'watched'
    created?: boolean
    ignored?: boolean
  }>,
  workspaceId = 'aaaa',
): Promise<{ readonly gens: Map<string, { gen: string; baselineGen?: string }> }> {
  const gens = new Map<string, { gen: string; baselineGen?: string }>()
  let seq = 0
  const next = (): string => `g${(++seq).toString(36)}`
  await store.writeEntries(
    handle,
    sessionId,
    files.map((file) => {
      const gen = next()
      gens.set(file.key, { gen })
      return { key: file.key, gen, batches: file.batches ?? [] }
    }),
  )
  for (const file of files) {
    if (typeof file.baseline === 'string') {
      const baselineGen = next()
      gens.get(file.key)!.baselineGen = baselineGen
      await writeBaseline(store, handle, sessionId, file.key, baselineGen, file.baseline)
    }
  }
  await store.commitIndex(
    handle,
    sessionId,
    files.map((file) => {
      const generation = gens.get(file.key)!
      return indexEntry(file.key, {
        path: file.path ?? file.key,
        batchCount: file.batchCount ?? file.batches?.length ?? 0,
        gen: generation.gen,
        ...(file.origin !== undefined ? { origin: file.origin } : {}),
        ...(file.baseline === null
          ? { baseline: 'null' as const }
          : typeof file.baseline === 'string'
            ? { baseline: 'text' as const }
            : {}),
        ...(generation.baselineGen !== undefined ? { baselineGen: generation.baselineGen } : {}),
        ...(file.baselineSource !== undefined ? { baselineSource: file.baselineSource } : {}),
        ...(file.created ? { created: true } : {}),
        ...(file.ignored ? { ignored: true } : {}),
      })
    }),
  )
  void workspaceId
  return { gens }
}

describe('SessionChangesStoreMainService', () => {
  let globalFile: string
  let loggers: CapturingLoggerService

  beforeEach(() => {
    tmpRoot = mkTempDir('universe-editor-sessionchanges-')
    globalFile = join(tmpRoot, 'state.json')
    loggers = new CapturingLoggerService()
  })

  afterEach(() => {
    removeDirWithRetry(tmpRoot)
  })

  async function makeMainStorage(): Promise<MainStorageService> {
    const storage = new MainStorageService(createStorage(globalFile))
    await storage.whenReady
    return storage
  }

  function makeStore(
    storage: MainStorageService,
    options: Partial<SessionChangesStoreMainServiceOptions> = {},
  ): SessionChangesStoreMainService {
    return new SessionChangesStoreMainService(storage, loggers, {
      userDataDir: tmpRoot,
      ...options,
    })
  }

  it('writes, lists, reads and removes a v2 session directory', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const opened = await store.openBucket()
    expect(opened.scope).toBe(StorageScope.WORKSPACE)
    expect(opened.label).toBe('workspace:aaaa')

    const batches = [{ toolCallId: 'tc-1', hunks: [{ lines: ['+a'] }] }]
    const { gens } = await writeV2(store, opened.handle, 's1', [
      { key: '/a.ts', path: '/a.ts', batches, baseline: '旧内容', baselineSource: 'reported' },
    ])
    const gen = gens.get('/a.ts')!.gen
    const baselineGen = gens.get('/a.ts')!.baselineGen!

    expect((await store.list(opened.handle)).map((m) => m.sessionId)).toEqual(['s1'])
    expect((await store.list(opened.handle))[0]?.bytes).toBeGreaterThan(0)

    expect(await store.read(opened.handle, 's1')).toEqual({
      status: 'ok',
      format: 'v2',
      schemaVersion: 2,
      files: [
        {
          key: '/a.ts',
          path: '/a.ts',
          batchCount: 1,
          origin: 'agent',
          gen,
          baseline: 'text',
          baselineGen,
          baselineSource: 'reported',
        },
      ],
    })
    expect(
      await store.readEntries(opened.handle, 's1', [
        { key: '/a.ts', gen },
        { key: '/missing.ts', gen },
      ]),
    ).toEqual({
      status: 'error',
      error: 'missing entry /missing.ts',
    })
    expect(await store.readEntries(opened.handle, 's1', [{ key: '/a.ts', gen }])).toEqual({
      status: 'ok',
      entries: [{ key: '/a.ts', batches }],
    })
    expect(await store.readBaseline(opened.handle, 's1', '/a.ts', baselineGen, 0)).toEqual({
      status: 'ok',
      index: 0,
      count: 1,
      text: '旧内容',
    })
    expect(await store.read(opened.handle, 'missing')).toEqual({ status: 'missing' })

    await store.remove(opened.handle, 's1')
    expect(await store.read(opened.handle, 's1')).toEqual({ status: 'missing' })
    expect(await store.list(opened.handle)).toEqual([])
    await expect(access(sessionDir(tmpRoot, 'aaaa', 's1'))).rejects.toThrow()
    store.dispose()
    storage.dispose()
  })

  it('assembles a chunked baseline and discards partial or out-of-order writes', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const { handle } = await store.openBucket()

    const text = 'x'.repeat(SESSION_CHANGES_BASELINE_CHUNK_CHARS + 10)
    const parts = chunks(text)
    expect(parts).toHaveLength(2)
    const gen = 'a1'

    // Out of order: chunk 1 without chunk 0.
    expect(
      await store.writeBaseline(handle, 's1', '/a.ts', gen, {
        index: 1,
        count: 2,
        text: parts[1]!,
      }),
    ).toEqual({ ok: false, error: 'baseline assembly was discarded; restart from chunk 0' })
    // A skipped chunk with an assembly in progress is rejected as out of order.
    await store.writeBaseline(handle, 's1', '/b.ts', gen, { index: 0, count: 3, text: 'a' })
    expect(
      await store.writeBaseline(handle, 's1', '/b.ts', gen, { index: 2, count: 3, text: 'c' }),
    ).toEqual({ ok: false, error: 'baseline chunks arrived out of order; restart from chunk 0' })
    // Chunk 0 then a new chunk 0 restarts assembly.
    await store.writeBaseline(handle, 's1', '/a.ts', gen, { index: 0, count: 2, text: parts[0]! })
    await store.writeBaseline(handle, 's1', '/a.ts', gen, { index: 0, count: 2, text: parts[0]! })
    // Nothing is written before the last chunk arrives.
    expect(dirNames(baselineDir(tmpRoot, 'aaaa', 's1'))).toEqual([])
    await store.writeBaseline(handle, 's1', '/a.ts', gen, { index: 1, count: 2, text: parts[1]! })
    expect(
      await store.commitIndex(handle, 's1', [
        indexEntry('/a.ts', { baseline: 'text', baselineGen: gen }),
      ]),
    ).toEqual({ ok: true })
    expect(await store.readBaseline(handle, 's1', '/a.ts', gen, 0)).toEqual({
      status: 'ok',
      index: 0,
      count: 2,
      text: parts[0],
    })
    expect(await store.readBaseline(handle, 's1', '/a.ts', gen, 1)).toEqual({
      status: 'ok',
      index: 1,
      count: 2,
      text: parts[1],
    })
    // A chunk index beyond the count is rejected.
    expect(await store.readBaseline(handle, 's1', '/a.ts', gen, 2)).toEqual({
      status: 'error',
      error: 'baseline chunk 2 out of range (2)',
    })
    store.dispose()
    storage.dispose()
  })

  it('drops a half-assembled baseline when a new chunk 0 arrives', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const { handle } = await store.openBucket()

    const text = 'a'.repeat(SESSION_CHANGES_BASELINE_CHUNK_CHARS * 2)
    const parts = chunks(text)
    expect(parts).toHaveLength(2)
    const gen = 'a1'
    await store.writeBaseline(handle, 's1', '/a.ts', gen, {
      index: 0,
      count: 2,
      text: parts[0]!,
    })
    await store.writeBaseline(handle, 's1', '/a.ts', gen, {
      index: 0,
      count: 2,
      text: parts[1]!,
    })
    expect(
      await store.writeBaseline(handle, 's1', '/a.ts', gen, {
        index: 1,
        count: 2,
        text: parts[1]!,
      }),
    ).toEqual({ ok: true })
    expect(await store.readBaseline(handle, 's1', '/a.ts', gen, 1)).toMatchObject({
      status: 'ok',
      text: parts[1],
    })
    store.dispose()
    storage.dispose()
  })

  it('GCs files and baselines the committed index no longer references', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const { handle } = await store.openBucket()

    const { gens } = await writeV2(store, handle, 's1', [
      { key: '/a.ts', batches: [], baseline: 'a' },
      { key: '/b.ts', batches: [], baseline: 'b' },
    ])
    const genA = gens.get('/a.ts')!.gen
    const baselineGenA = gens.get('/a.ts')!.baselineGen!
    const genB = gens.get('/b.ts')!.gen
    const baselineGenB = gens.get('/b.ts')!.baselineGen!
    await expect(access(entryPath(tmpRoot, 'aaaa', 's1', '/a.ts', genA))).resolves.toBeUndefined()
    await expect(
      access(baselinePath(tmpRoot, 'aaaa', 's1', '/b.ts', baselineGenB)),
    ).resolves.toBeUndefined()

    await store.commitIndex(handle, 's1', [
      indexEntry('/a.ts', { gen: genA, baseline: 'text', baselineGen: baselineGenA }),
    ])
    await expect(access(entryPath(tmpRoot, 'aaaa', 's1', '/a.ts', genA))).resolves.toBeUndefined()
    await expect(access(entryPath(tmpRoot, 'aaaa', 's1', '/b.ts', genB))).rejects.toThrow()
    await expect(
      access(baselinePath(tmpRoot, 'aaaa', 's1', '/b.ts', baselineGenB)),
    ).rejects.toThrow()
    store.dispose()
    storage.dispose()
  })

  it('leaves the previous committed generation readable until the index commits', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const { handle } = await store.openBucket()

    const first = await writeV2(store, handle, 's1', [
      { key: '/a.ts', batches: [{ toolCallId: 'tc-old' }], baseline: 'old' },
    ])
    const committed = first.gens.get('/a.ts')!

    // Write a new generation but never commit: a crash here must not expose it.
    await store.writeEntries(handle, 's1', [
      { key: '/a.ts', gen: 'new1', batches: [{ toolCallId: 'tc-new' }] },
    ])
    await writeBaseline(store, handle, 's1', '/a.ts', 'new2', 'new baseline')

    const reopened = makeStore(storage)
    const opened = await reopened.openBucket()
    const read = await reopened.read(opened.handle, 's1')
    expect(read).toMatchObject({
      status: 'ok',
      format: 'v2',
      files: [{ key: '/a.ts', gen: committed.gen, baselineGen: committed.baselineGen }],
    })
    expect(
      await reopened.readEntries(opened.handle, 's1', [{ key: '/a.ts', gen: committed.gen }]),
    ).toEqual({ status: 'ok', entries: [{ key: '/a.ts', batches: [{ toolCallId: 'tc-old' }] }] })
    expect(
      await reopened.readBaseline(opened.handle, 's1', '/a.ts', committed.baselineGen!, 0),
    ).toMatchObject({ status: 'ok', text: 'old' })
    reopened.dispose()
    store.dispose()
    storage.dispose()
  })

  it('collects orphaned bodies on the next commit', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const { handle } = await store.openBucket()

    const first = await writeV2(store, handle, 's1', [
      { key: '/a.ts', batches: [], baseline: 'old' },
    ])
    const old = first.gens.get('/a.ts')!
    // Uncommitted generations, including their createStorage sidecars.
    await store.writeEntries(handle, 's1', [{ key: '/a.ts', gen: 'orphan1', batches: [] }])
    await writeBaseline(store, handle, 's1', '/a.ts', 'orphan2', 'orphan baseline')
    expect(dirNames(entryDir(tmpRoot, 'aaaa', 's1'))).toContain(`${hashKey('/a.ts')}.orphan1.json`)
    expect(dirNames(baselineDir(tmpRoot, 'aaaa', 's1'))).toContain(
      `${hashKey('/a.ts')}.orphan2.json`,
    )

    await store.writeEntries(handle, 's1', [{ key: '/a.ts', gen: 'new1', batches: [] }])
    await writeBaseline(store, handle, 's1', '/a.ts', 'new2', 'new baseline')
    await store.commitIndex(handle, 's1', [
      indexEntry('/a.ts', { gen: 'new1', baseline: 'text', baselineGen: 'new2' }),
    ])
    expect(dirNames(entryDir(tmpRoot, 'aaaa', 's1'))).toEqual([`${hashKey('/a.ts')}.new1.json`])
    expect(dirNames(baselineDir(tmpRoot, 'aaaa', 's1'))).toEqual([`${hashKey('/a.ts')}.new2.json`])
    expect(dirNames(entryDir(tmpRoot, 'aaaa', 's1'))).not.toContain(
      `${hashKey('/a.ts')}.${old.gen}.json`,
    )
    store.dispose()
    storage.dispose()
  })

  it('reads an index that only survives as its .bak copy', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const { handle } = await store.openBucket()

    const { gens } = await writeV2(store, handle, 's1', [
      { key: '/a.ts', batches: [], baseline: 'a' },
    ])
    const indexFile = join(sessionDir(tmpRoot, 'aaaa', 's1'), 'index.json')
    // Simulate a crash between `createStorage`'s two renames.
    await fs.rename(indexFile, `${indexFile}.bak`)

    const reopened = makeStore(storage)
    const opened = await reopened.openBucket()
    expect(await reopened.read(opened.handle, 's1')).toMatchObject({
      status: 'ok',
      format: 'v2',
      files: [{ key: '/a.ts', gen: gens.get('/a.ts')!.gen }],
    })
    expect((await reopened.list(opened.handle)).map((meta) => meta.sessionId)).toEqual(['s1'])
    reopened.dispose()
    store.dispose()
    storage.dispose()
  })

  it('reads a v1 shard and deletes it once v2 is committed', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const { handle } = await store.openBucket()

    const v1File = join(tmpRoot, 'session-changes', 'aaaa', 'sessions', shardFileName('s1'))
    await createStorage(v1File).set('data', payload('s1', [{ path: '/a.ts', batches: [] }]))

    expect(await store.read(handle, 's1')).toEqual({
      status: 'ok',
      format: 'v1',
      payload: payload('s1', [{ path: '/a.ts', batches: [] }]),
    })

    await writeV2(store, handle, 's1', [{ key: '/a.ts', batches: [], baseline: 'old' }])
    await expect(access(v1File)).rejects.toThrow()
    expect(await store.read(handle, 's1')).toMatchObject({ status: 'ok', format: 'v2' })
    store.dispose()
    storage.dispose()
  })

  it('removes both v1 and v2 representations', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const { handle } = await store.openBucket()

    const v1File = join(tmpRoot, 'session-changes', 'aaaa', 'sessions', shardFileName('s1'))
    await createStorage(v1File).set('data', payload('s1'))
    await writeV2(store, handle, 's1', [{ key: '/a.ts', batches: [] }])
    await createStorage(v1File).set('data', payload('s1'))

    await store.remove(handle, 's1')
    await expect(access(v1File)).rejects.toThrow()
    await expect(access(sessionDir(tmpRoot, 'aaaa', 's1'))).rejects.toThrow()
    expect(await store.list(handle)).toEqual([])
    store.dispose()
    storage.dispose()
  })

  it('rejects invalid parameters without touching the filesystem', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const { handle } = await store.openBucket()

    expect(await store.writeEntries(handle, '', [])).toEqual({
      ok: false,
      error: 'invalid session id',
    })
    expect(await store.writeEntries(handle, 's1', [{ key: '', gen: 'a1', batches: [] }])).toEqual({
      ok: false,
      error: 'invalid entry key',
    })
    expect(
      await store.writeEntries(handle, 's1', [{ key: '/a', gen: '../evil', batches: [] }]),
    ).toEqual({ ok: false, error: 'invalid entry gen' })
    expect(
      await store.writeEntries(handle, 's1', [{ key: '/a', gen: 'A'.repeat(33), batches: [] }]),
    ).toEqual({ ok: false, error: 'invalid entry gen' })
    expect(
      await store.writeEntries(handle, 's1', [{ key: '/a', gen: 'a1', batches: 'nope' as never }]),
    ).toEqual({ ok: false, error: 'entry batches must be an array' })
    expect(
      await store.writeBaseline(handle, 's1', '/a.ts', 'a1', {
        index: 2,
        count: 2,
        text: '',
      }),
    ).toEqual({ ok: false, error: 'invalid baseline chunk index' })
    expect(
      await store.writeBaseline(handle, 's1', '/a.ts', 'a1', {
        index: 0,
        count: 0,
        text: '',
      }),
    ).toEqual({ ok: false, error: 'invalid baseline chunk count' })
    expect(
      await store.writeBaseline(handle, 's1', '/a.ts', 'a1', {
        index: 0,
        count: 1,
        text: 'x'.repeat(SESSION_CHANGES_BASELINE_CHUNK_CHARS + 1),
      }),
    ).toEqual({ ok: false, error: 'invalid baseline chunk text' })
    expect(
      await store.writeBaseline(handle, 's1', '/a.ts', 'bad/gen', {
        index: 0,
        count: 1,
        text: '',
      }),
    ).toEqual({ ok: false, error: 'invalid entry gen' })
    expect(await store.commitIndex(handle, 's1', [indexEntry('/a'), indexEntry('/a')])).toEqual({
      ok: false,
      error: 'duplicate index entry key',
    })
    expect(await store.commitIndex(handle, 's1', [indexEntry('/a', { gen: '../evil' })])).toEqual({
      ok: false,
      error: 'invalid index entry gen',
    })
    expect(await store.commitIndex(handle, 's1', [indexEntry('/a', { baseline: 'text' })])).toEqual(
      { ok: false, error: 'missing index entry baseline gen' },
    )
    expect(
      await store.commitIndex(handle, 's1', [
        indexEntry('/a', { baseline: 'text', baselineGen: 'bad/gen' }),
      ]),
    ).toEqual({ ok: false, error: 'invalid index entry baseline gen' })
    expect(
      await store.commitIndex(handle, 's1', [indexEntry('/a', { baselineGen: 'a1' })]),
    ).toEqual({ ok: false, error: 'invalid index entry baseline gen' })
    await expect(store.writeEntries('unknown-handle', 's1', [])).rejects.toThrow(
      /unknown session changes bucket handle/,
    )
    store.dispose()
    storage.dispose()
  })

  it('records manifest bytes and a monotonic version per commit', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const { handle } = await store.openBucket()

    const { gens } = await writeV2(store, handle, 's1', [
      { key: '/a.ts', batches: [], baseline: 'baseline' },
    ])
    const { gen, baselineGen } = gens.get('/a.ts')!
    expect(await store.list(handle)).toEqual([
      expect.objectContaining({ sessionId: 's1', version: 1 }),
    ])
    await store.commitIndex(handle, 's1', [
      indexEntry('/a.ts', { gen, baseline: 'text', baselineGen: baselineGen! }),
    ])
    const listed = await store.list(handle)
    expect(listed[0]?.version).toBe(2)
    expect(listed[0]?.bytes).toBeGreaterThan(0)

    const raw = await readFile(join(tmpRoot, 'session-changes', 'aaaa', 'manifest.json'), 'utf8')
    const doc = JSON.parse(raw) as {
      manifest: { sessions: { sessionId: string; bytes: number; version: number }[] }
    }
    expect(doc.manifest.sessions).toEqual([
      expect.objectContaining({ sessionId: 's1', version: 2 }),
    ])
    store.dispose()
    storage.dispose()
  })

  it('uses the GLOBAL bucket when no workspace is open', async () => {
    const storage = await makeMainStorage()
    await storage.globalStorage.set('unrelated', { kept: true })
    const store = makeStore(storage)
    const opened = await store.openBucket()
    expect(opened.scope).toBe(StorageScope.GLOBAL)
    expect(opened.label).toBe('global')
    await writeV2(store, opened.handle, 's1', [{ key: '/a.ts', batches: [] }], 'global')
    expect(await store.list(opened.handle)).toEqual([expect.objectContaining({ sessionId: 's1' })])
    store.dispose()
    storage.dispose()
  })

  it('never lets a session id or key escape the sessions directory', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const { handle } = await store.openBucket()

    const hostile = ['../evil', 'a/b/c', '..', 'con:<>', 'ünïcode']
    for (const id of hostile) {
      await writeV2(store, handle, id, [{ key: id, path: id, batches: [] }])
    }
    const sessionsDir = join(tmpRoot, 'session-changes', 'aaaa', 'sessions')
    const names = await readdir(sessionsDir)
    expect(names).toHaveLength(hostile.length)
    expect(names.every((name) => /^[0-9a-f]{32}$/.test(name))).toBe(true)
    expect(names).not.toContain('..')
    await expect(access(join(tmpRoot, 'session-changes', 'evil'))).rejects.toThrow()

    for (const id of hostile) {
      expect(await store.read(handle, id)).toMatchObject({ status: 'ok', format: 'v2' })
    }
    store.dispose()
    storage.dispose()
  })

  it('imports legacy workspace data in main, verifies it, then removes only that key', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    await storage.workspaceStorage!.set('acp.sessionChanges', {
      schemaVersion: 3,
      sessions: [
        { sessionId: 's1', files: [{ path: '/a.ts', batches: [] }] },
        { sessionId: 's2', files: [] },
      ],
    })
    await storage.workspaceStorage!.set('acp.other', 'keep me')
    await storage.workspaceStorage!.flush()

    const store = makeStore(storage)
    const opened = await store.openBucket()
    expect(opened.importWarning).toMatch(/^migrated:2$/)

    expect((await store.list(opened.handle)).map((m) => m.sessionId)).toEqual(['s1', 's2'])
    expect(await store.read(opened.handle, 's1')).toEqual({
      status: 'ok',
      format: 'v1',
      payload: payload('s1', [{ path: '/a.ts', batches: [] }]),
    })
    expect(await storage.workspaceStorage!.get('acp.sessionChanges')).toBeUndefined()
    expect(await storage.workspaceStorage!.get('acp.other')).toBe('keep me')
    expect(loggers.logs.some((line) => line.includes('imported'))).toBe(true)
    store.dispose()
    storage.dispose()
  })

  it('leaves legacy data in place when a shard write fails', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    await storage.workspaceStorage!.set('acp.sessionChanges', {
      schemaVersion: 3,
      sessions: [{ sessionId: 's1', files: [] }],
    })
    await storage.workspaceStorage!.flush()

    // A file where the sessions directory belongs makes every shard write fail.
    const bucketDir = join(tmpRoot, 'session-changes', 'aaaa')
    await mkdir(bucketDir, { recursive: true })
    await writeFile(join(bucketDir, 'sessions'), 'not a directory', 'utf8')

    const store = makeStore(storage)
    const opened = await store.openBucket()
    expect(opened.importWarning).toContain('legacy import failed')
    expect(await store.list(opened.handle)).toEqual([])
    expect(await storage.workspaceStorage!.get('acp.sessionChanges')).toEqual({
      schemaVersion: 3,
      sessions: [{ sessionId: 's1', files: [] }],
    })
    expect(loggers.logs.some((line) => line.includes('legacy data kept'))).toBe(true)
    store.dispose()
    storage.dispose()
  })

  it('keeps unrecognized legacy shapes untouched and reports why', async () => {
    const storage = await makeMainStorage()
    await storage.globalStorage.set('acp.sessionChanges', { somethingElse: true })
    await storage.globalStorage.flush()

    const store = makeStore(storage)
    const opened = await store.openBucket()
    expect(opened.importWarning).toContain('legacy-unrecognized')
    expect(await storage.globalStorage.get('acp.sessionChanges')).toEqual({ somethingElse: true })
    store.dispose()
    storage.dispose()
  })

  it('keeps malformed legacy session entries untouched', async () => {
    const storage = await makeMainStorage()
    await storage.globalStorage.set('acp.sessionChanges', {
      schemaVersion: 3,
      sessions: [{ sessionId: 7, files: [] }],
    })
    await storage.globalStorage.flush()

    const store = makeStore(storage)
    const opened = await store.openBucket()
    expect(opened.importWarning).toContain('legacy-malformed')
    expect(await storage.globalStorage.get('acp.sessionChanges')).toEqual({
      schemaVersion: 3,
      sessions: [{ sessionId: 7, files: [] }],
    })
    store.dispose()
    storage.dispose()
  })

  it('preserves an unrecognized manifest and rebuilds the list from v1 and v2 shards', async () => {
    const bucketDir = join(tmpRoot, 'session-changes', 'corrupt')
    await mkdir(join(bucketDir, 'sessions'), { recursive: true })
    const manifestRaw = JSON.stringify({ schemaVersion: 99, sessions: 'nope' })
    await writeFile(join(bucketDir, 'manifest.json'), manifestRaw, 'utf8')
    await createStorage(join(bucketDir, 'sessions', shardFileName('s1'))).set(
      'data',
      payload('s1', [{ path: '/a.ts' }]),
    )
    const v2Dir = join(bucketDir, 'sessions', hashKey('s2'))
    await createStorage(join(v2Dir, 'index.json')).set('data', {
      schemaVersion: 2,
      sessionId: 's2',
      files: [indexEntry('/b.ts')],
    })
    await createStorage(join(v2Dir, 'files', `${hashKey('/b.ts')}.a1.json`)).set('data', {
      batches: [],
    })

    const storage = await makeMainStorage()
    await storage.switchWorkspace('corrupt')
    const store = makeStore(storage)
    const opened = await store.openBucket()
    expect(opened.importWarning).toBe('manifest-unrecognized')

    expect((await store.list(opened.handle)).map((m) => m.sessionId).sort()).toEqual(['s1', 's2'])
    expect(await store.read(opened.handle, 's1')).toEqual({
      status: 'ok',
      format: 'v1',
      payload: payload('s1', [{ path: '/a.ts' }]),
    })
    expect(await store.read(opened.handle, 's2')).toMatchObject({ status: 'ok', format: 'v2' })
    expect(await readFile(join(bucketDir, 'manifest.json'), 'utf8')).toBe(manifestRaw)
    store.dispose()
    storage.dispose()
  })

  it('loads a manifest written through createStorage instead of rescanning on restart', async () => {
    const bucketDir = join(tmpRoot, 'session-changes', 'bbbb')
    await mkdir(bucketDir, { recursive: true })
    const manifest = {
      schemaVersion: 1,
      sessions: [{ sessionId: 's1', bytes: 42, version: 7 }],
    }
    await createStorage(join(bucketDir, 'manifest.json')).set('manifest', manifest)
    await createStorage(join(bucketDir, 'sessions', shardFileName('s1'))).set(
      'data',
      payload('s1', [{ path: '/a.ts' }]),
    )

    const storage = await makeMainStorage()
    await storage.switchWorkspace('bbbb')
    const store = makeStore(storage)
    const opened = await store.openBucket()
    expect(opened.importWarning).toBeUndefined()
    expect(await store.list(opened.handle)).toEqual([{ sessionId: 's1', bytes: 42, version: 7 }])
    expect(loggers.logs.some((line) => line.includes('unrecognized'))).toBe(false)
    store.dispose()
    storage.dispose()
  })

  it('pins a handle to the bucket it was opened on across a workspace switch', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const first = await store.openBucket()
    await writeV2(store, first.handle, 's1', [{ key: '/a.ts', batches: [] }])

    await storage.switchWorkspace('bbbb')
    // A late write through the old handle must land in aaaa, not bbbb.
    await writeV2(store, first.handle, 's2', [{ key: '/b.ts', batches: [] }])
    expect((await store.list(first.handle)).map((m) => m.sessionId).sort()).toEqual(['s1', 's2'])

    const second = await store.openBucket()
    expect(second.label).toBe('workspace:bbbb')
    expect(await store.list(second.handle)).toEqual([])
    await expect(access(sessionDir(tmpRoot, 'bbbb', 's2'))).rejects.toThrow()
    await expect(access(sessionDir(tmpRoot, 'aaaa', 's2'))).resolves.toBeUndefined()
    store.dispose()
    storage.dispose()
  })

  it('shares one bucket between two windows on the same workspace', async () => {
    const storageA = await makeMainStorage()
    await storageA.switchWorkspace('aaaa')
    const storeA = makeStore(storageA)
    const a = await storeA.openBucket()
    await writeV2(storeA, a.handle, 's1', [{ key: '/a.ts', batches: [] }])

    const storageB = await makeMainStorage()
    await storageB.switchWorkspace('aaaa')
    const storeB = makeStore(storageB)
    const b = await storeB.openBucket()
    expect((await storeB.list(b.handle)).map((m) => m.sessionId)).toEqual(['s1'])
    await writeV2(storeB, b.handle, 's2', [{ key: '/b.ts', batches: [] }])
    expect((await storeA.list(a.handle)).map((m) => m.sessionId).sort()).toEqual(['s1', 's2'])
    storeA.dispose()
    storeB.dispose()
    storageA.dispose()
    storageB.dispose()
  })

  it('flushAll drains writes through every handle the window opened', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const { handle } = await store.openBucket()
    await writeV2(store, handle, 's1', [{ key: '/a.ts', batches: [] }])

    // Force a fresh out-of-process read: the on-disk manifest must already name s1.
    await store.flushAll()
    const raw = await readFile(join(tmpRoot, 'session-changes', 'aaaa', 'manifest.json'), 'utf8')
    const doc = JSON.parse(raw) as { manifest: { sessions: { sessionId: string }[] } }
    expect(doc.manifest.sessions.map((s) => s.sessionId)).toEqual(['s1'])
    store.dispose()
    storage.dispose()
  })

  it('reuses one handle per bucket and evicts the bucket after the last window releases it', async () => {
    const baseline = _getSharedBucketCountForTests()
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const first = await store.openBucket()
    // Re-opening the same workspace must not pin (and re-cache) a second bucket.
    expect((await store.openBucket()).handle).toBe(first.handle)
    await writeV2(store, first.handle, 's1', [{ key: '/a.ts', batches: [] }])

    // A second window on the same workspace shares the same bucket.
    const otherStorage = await makeMainStorage()
    await otherStorage.switchWorkspace('aaaa')
    const otherStore = makeStore(otherStorage)
    const shared = await otherStore.openBucket()
    expect(shared.handle).not.toBe(first.handle)
    expect(_getSharedBucketCountForTests()).toBe(baseline + 1)

    store.dispose()
    // The other window still pins the bucket, so its handle must keep working.
    expect((await otherStore.list(shared.handle)).map((m) => m.sessionId)).toEqual(['s1'])
    await expect(store.list(first.handle)).rejects.toThrow(/unknown session changes bucket handle/)
    expect(_getSharedBucketCountForTests()).toBe(baseline + 1)

    otherStore.dispose()
    // Last release drops the cached manifest/shard bodies from main.
    expect(_getSharedBucketCountForTests()).toBe(baseline)
    otherStorage.dispose()
  })

  it('closeBucket releases one window handle without disturbing another', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const first = await store.openBucket()
    await writeV2(store, first.handle, 's1', [{ key: '/a.ts', batches: [] }])

    const otherStorage = await makeMainStorage()
    await otherStorage.switchWorkspace('aaaa')
    const otherStore = makeStore(otherStorage)
    const shared = await otherStore.openBucket()

    await store.closeBucket(first.handle)
    await expect(store.list(first.handle)).rejects.toThrow(/unknown session changes bucket handle/)
    expect((await otherStore.list(shared.handle)).map((m) => m.sessionId)).toEqual(['s1'])

    // Closing the same handle twice is a no-op, not an error.
    await expect(store.closeBucket(first.handle)).resolves.toBeUndefined()
    otherStore.dispose()
    otherStorage.dispose()
  })

  it('reads a chunked baseline from disk once per load and invalidates on write', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const { handle } = await store.openBucket()

    const text = 'x'.repeat(SESSION_CHANGES_BASELINE_CHUNK_CHARS * 2 + 5)
    const parts = chunks(text)
    const gen = 'a1'
    await writeBaseline(store, handle, 's1', '/a.ts', gen, text)
    await store.commitIndex(handle, 's1', [
      indexEntry('/a.ts', { baseline: 'text', baselineGen: gen }),
    ])

    const readFileSpy = vi.spyOn(fs, 'readFile')
    try {
      expect(await store.readBaseline(handle, 's1', '/a.ts', gen, 0)).toMatchObject({
        status: 'ok',
      })
      const afterFirst = readFileSpy.mock.calls.length
      for (let i = 1; i < parts.length; i++) {
        expect(await store.readBaseline(handle, 's1', '/a.ts', gen, i)).toMatchObject({
          status: 'ok',
        })
      }
      // The remaining chunks came from the cache.
      expect(readFileSpy.mock.calls.length).toBe(afterFirst)

      // A new baseline generation is read from disk (the old cache is keyed by gen).
      await writeBaseline(store, handle, 's1', '/a.ts', gen, 'new baseline')
      expect(await store.readBaseline(handle, 's1', '/a.ts', gen, 0)).toMatchObject({
        text: 'new baseline',
      })
      expect(readFileSpy.mock.calls.length).toBe(afterFirst + 1)
    } finally {
      readFileSpy.mockRestore()
    }
    store.dispose()
    storage.dispose()
  })

  it('rejects new baseline assemblies past the in-flight count cap', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage, { maxBaselineAssemblies: 1 })
    const { handle } = await store.openBucket()

    expect(
      await store.writeBaseline(handle, 's1', '/a.ts', 'a1', { index: 0, count: 2, text: 'a' }),
    ).toEqual({ ok: true })
    expect(
      await store.writeBaseline(handle, 's1', '/b.ts', 'a2', { index: 0, count: 2, text: 'b' }),
    ).toEqual({ ok: false, error: 'too many baseline assemblies in flight; retry later' })
    // Completing the first assembly frees the slot for the retry.
    expect(
      await store.writeBaseline(handle, 's1', '/a.ts', 'a1', { index: 1, count: 2, text: 'c' }),
    ).toEqual({ ok: true })
    expect(
      await store.writeBaseline(handle, 's1', '/b.ts', 'a2', { index: 0, count: 2, text: 'b' }),
    ).toEqual({ ok: true })
    store.dispose()
    storage.dispose()
  })

  it('rejects a baseline chunk that would exceed the total assembly buffer', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage, { maxBaselineAssemblies: 4, maxBaselineAssemblyChars: 5 })
    const { handle } = await store.openBucket()

    expect(
      await store.writeBaseline(handle, 's1', '/a.ts', 'a1', {
        index: 0,
        count: 2,
        text: 'abcd',
      }),
    ).toEqual({ ok: true })
    expect(
      await store.writeBaseline(handle, 's1', '/b.ts', 'a2', {
        index: 0,
        count: 2,
        text: 'ef',
      }),
    ).toEqual({ ok: false, error: 'baseline assembly buffer is full; retry later' })
    expect(
      await store.writeBaseline(handle, 's1', '/b.ts', 'a2', { index: 0, count: 2, text: 'e' }),
    ).toEqual({ ok: true })
    store.dispose()
    storage.dispose()
  })

  it('discovers a v2 session directory missing from the manifest and repairs it', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const { handle } = await store.openBucket()
    await writeV2(store, handle, 's1', [{ key: '/a.ts', batches: [], baseline: 'a' }])
    store.dispose()
    storage.dispose()

    // A crash between the index commit and the manifest write leaves the dir
    // orphaned; `list()` must surface it and add it back to the manifest.
    await rm(join(tmpRoot, 'session-changes', 'aaaa', 'manifest.json'), { force: true })
    // `readJsonFile` falls back to `.bak`, so drop the rotated copy too — that is
    // what "the manifest never landed" looks like on disk.
    await rm(join(tmpRoot, 'session-changes', 'aaaa', 'manifest.json.bak'), { force: true })
    const reopenedStorage = await makeMainStorage()
    await reopenedStorage.switchWorkspace('aaaa')
    const reopened = makeStore(reopenedStorage)
    const reopenedHandle = await reopened.openBucket()
    const listed = await reopened.list(reopenedHandle.handle)
    expect(listed.map((meta) => meta.sessionId)).toEqual(['s1'])
    expect(listed[0]?.version).toBe(0)
    expect(listed[0]?.bytes).toBeGreaterThan(0)
    const raw = await readFile(join(tmpRoot, 'session-changes', 'aaaa', 'manifest.json'), 'utf8')
    expect(raw).toContain('s1')
    reopened.dispose()
    reopenedStorage.dispose()
  })
})
