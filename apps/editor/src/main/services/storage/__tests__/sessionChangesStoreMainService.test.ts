/*---------------------------------------------------------------------------------------------
 *  Tests for SessionChangesStoreMainService — per-session shards, manifest,
 *  legacy import and handle→bucket pinning.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
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
} from '../sessionChangesStoreMainService.js'

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

function shardFileName(sessionId: string): string {
  return `${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}.json`
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

  function makeStore(storage: MainStorageService): SessionChangesStoreMainService {
    return new SessionChangesStoreMainService(storage, loggers, { userDataDir: tmpRoot })
  }

  it('writes, lists, reads and removes per-session shards in a workspace bucket', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const opened = await store.openBucket()
    expect(opened.scope).toBe(StorageScope.WORKSPACE)
    expect(opened.label).toBe('workspace:aaaa')

    expect(await store.write(opened.handle, 's1', payload('s1', [{ path: '/a.ts' }]))).toEqual({
      ok: true,
    })
    const list = await store.list(opened.handle)
    expect(list.map((m) => m.sessionId)).toEqual(['s1'])
    expect(list[0]?.bytes).toBeGreaterThan(0)

    const read = await store.read(opened.handle, 's1')
    expect(read).toEqual({ status: 'ok', payload: payload('s1', [{ path: '/a.ts' }]) })
    expect(await store.read(opened.handle, 'missing')).toEqual({ status: 'missing' })

    await store.remove(opened.handle, 's1')
    expect(await store.read(opened.handle, 's1')).toEqual({ status: 'missing' })
    expect(await store.list(opened.handle)).toEqual([])
    await expect(
      access(join(tmpRoot, 'session-changes', 'aaaa', 'sessions', shardFileName('s1'))),
    ).rejects.toThrow()
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
    await store.write(opened.handle, 's1', payload('s1'))
    expect(await store.list(opened.handle)).toEqual([expect.objectContaining({ sessionId: 's1' })])
    store.dispose()
    storage.dispose()
  })

  it('never lets a session id escape the sessions directory', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const { handle } = await store.openBucket()

    const hostile = ['../evil', 'a/b/c', '..', 'con:<>', 'ünïcode']
    for (const id of hostile) {
      expect(await store.write(handle, id, payload(id))).toEqual({ ok: true })
    }
    const sessionsDir = join(tmpRoot, 'session-changes', 'aaaa', 'sessions')
    const names = await readdir(sessionsDir)
    expect(names).toHaveLength(hostile.length)
    expect(names.every((name) => name.endsWith('.json'))).toBe(true)
    expect(names).not.toContain('..')
    await expect(access(join(tmpRoot, 'session-changes', 'evil'))).rejects.toThrow()

    for (const id of hostile) {
      expect(await store.read(handle, id)).toEqual({ status: 'ok', payload: payload(id) })
    }
    store.dispose()
    storage.dispose()
  })

  it('rejects a write whose payload names another session or is not an object', async () => {
    const storage = await makeMainStorage()
    const store = makeStore(storage)
    const { handle } = await store.openBucket()
    expect(await store.write(handle, 's1', { sessionId: 'other' })).toEqual({
      ok: false,
      error: 'session change payload session id mismatch',
    })
    expect(await store.write(handle, 's1', null)).toEqual({
      ok: false,
      error: 'session change payload must be an object',
    })
    await expect(store.write('unknown-handle', 's1', payload('s1'))).rejects.toThrow(
      /unknown session changes bucket handle/,
    )
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

  it('preserves an unrecognized manifest and rebuilds the list from shard files', async () => {
    const bucketDir = join(tmpRoot, 'session-changes', 'corrupt')
    await mkdir(join(bucketDir, 'sessions'), { recursive: true })
    const manifestRaw = JSON.stringify({ schemaVersion: 99, sessions: 'nope' })
    await writeFile(join(bucketDir, 'manifest.json'), manifestRaw, 'utf8')
    const shardFile = join(bucketDir, 'sessions', shardFileName('s1'))
    await createStorage(shardFile).set('data', payload('s1', [{ path: '/a.ts' }]))

    const storage = await makeMainStorage()
    await storage.switchWorkspace('corrupt')
    const store = makeStore(storage)
    const opened = await store.openBucket()
    expect(opened.importWarning).toBe('manifest-unrecognized')

    expect((await store.list(opened.handle)).map((m) => m.sessionId)).toEqual(['s1'])
    expect(await store.read(opened.handle, 's1')).toEqual({
      status: 'ok',
      payload: payload('s1', [{ path: '/a.ts' }]),
    })
    expect(await readFile(join(bucketDir, 'manifest.json'), 'utf8')).toBe(manifestRaw)
    store.dispose()
    storage.dispose()
  })

  it('loads a manifest written through createStorage instead of rescanning on restart', async () => {
    // The real writer is createStorage, whose file is `{ manifest: ManifestDoc }`.
    // Treating that wrapping as the doc itself made every restart rescan shards
    // and skip (then retry forever) the legacy import.
    const bucketDir = join(tmpRoot, 'session-changes', 'bbbb')
    await mkdir(bucketDir, { recursive: true })
    const manifest = { schemaVersion: 1, sessions: [{ sessionId: 's1', bytes: 42 }] }
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
    expect((await store.list(opened.handle)).map((m) => m.sessionId)).toEqual(['s1'])
    expect(loggers.logs.some((line) => line.includes('unrecognized'))).toBe(false)
    store.dispose()
    storage.dispose()
  })

  it('pins a handle to the bucket it was opened on across a workspace switch', async () => {
    const storage = await makeMainStorage()
    await storage.switchWorkspace('aaaa')
    const store = makeStore(storage)
    const first = await store.openBucket()
    await store.write(first.handle, 's1', payload('s1'))

    await storage.switchWorkspace('bbbb')
    // A late write through the old handle must land in aaaa, not bbbb.
    expect(await store.write(first.handle, 's2', payload('s2'))).toEqual({ ok: true })
    expect((await store.list(first.handle)).map((m) => m.sessionId).sort()).toEqual(['s1', 's2'])

    const second = await store.openBucket()
    expect(second.label).toBe('workspace:bbbb')
    expect(await store.list(second.handle)).toEqual([])
    await expect(
      access(join(tmpRoot, 'session-changes', 'bbbb', 'sessions', shardFileName('s2'))),
    ).rejects.toThrow()
    await expect(
      access(join(tmpRoot, 'session-changes', 'aaaa', 'sessions', shardFileName('s2'))),
    ).resolves.toBeUndefined()
    store.dispose()
    storage.dispose()
  })

  it('shares one bucket between two windows on the same workspace', async () => {
    const storageA = await makeMainStorage()
    await storageA.switchWorkspace('aaaa')
    const storeA = makeStore(storageA)
    const a = await storeA.openBucket()
    await storeA.write(a.handle, 's1', payload('s1'))

    const storageB = await makeMainStorage()
    await storageB.switchWorkspace('aaaa')
    const storeB = makeStore(storageB)
    const b = await storeB.openBucket()
    expect((await storeB.list(b.handle)).map((m) => m.sessionId)).toEqual(['s1'])
    await storeB.write(b.handle, 's2', payload('s2'))
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
    await store.write(handle, 's1', payload('s1'))

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
    await store.write(first.handle, 's1', payload('s1'))

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
    await store.write(first.handle, 's1', payload('s1'))

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
})
