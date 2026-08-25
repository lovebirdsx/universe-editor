import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileSystemError,
  REMOTE_SCHEME,
  URI,
  type IDirectoryEntry,
  type IFileService,
  type IFileStat,
} from '@universe-editor/platform'
import {
  FILE_CLIPBOARD_CONFIRM_BYTES,
  FILE_CLIPBOARD_REFUSE_BYTES,
  FILE_CLIPBOARD_REFUSE_ENTRIES,
  type IFileClipboardSnapshot,
} from '../../../../shared/ipc/fileClipboardService.js'
import type { IOsClipboardBackend, IOsClipboardReadResult } from '../osClipboardBackend.js'
import { FileClipboardMainService } from '../fileClipboardMainService.js'

interface FakeNode {
  readonly isDirectory: boolean
  readonly size: number
  readonly children: string[]
}

class FakeFileService implements IFileService {
  declare readonly _serviceBrand: undefined
  readonly nodes = new Map<string, FakeNode>()
  readonly copied: { source: string; target: string }[] = []
  statCalls = 0
  listCalls = 0

  addFile(uri: URI, size = 0): void {
    this.nodes.set(uri.toString(), { isDirectory: false, size, children: [] })
  }

  addDir(uri: URI, children: string[] = []): void {
    this.nodes.set(uri.toString(), { isDirectory: true, size: 0, children })
  }

  async stat(resource: URI): Promise<IFileStat> {
    this.statCalls++
    const node = this.nodes.get(resource.toString())
    if (!node) throw new FileSystemError(`ENOENT: ${resource.toString()}`, 'ENOENT')
    return {
      resource,
      isFile: !node.isDirectory,
      isDirectory: node.isDirectory,
      size: node.size,
      mtime: 0,
    }
  }

  async list(resource: URI): Promise<IDirectoryEntry[]> {
    this.listCalls++
    const node = this.nodes.get(resource.toString())
    if (!node?.isDirectory) throw new FileSystemError(`ENOENT: ${resource.toString()}`, 'ENOENT')
    return node.children.map((name) => {
      const child = this.nodes.get(URI.joinPath(resource, name).toString())
      return {
        name,
        isFile: !child?.isDirectory,
        isDirectory: child?.isDirectory ?? false,
      }
    })
  }

  async copy(source: URI, target: URI): Promise<void> {
    this.copied.push({ source: source.toString(), target: target.toString() })
  }

  async exists(resource: URI): Promise<boolean> {
    return this.nodes.has(resource.toString())
  }

  async readFile(): Promise<Uint8Array> {
    throw new Error('not implemented')
  }
  async readFileHead(): Promise<Uint8Array> {
    throw new Error('not implemented')
  }
  async readFileText(): Promise<string> {
    throw new Error('not implemented')
  }
  async writeFile(): Promise<void> {
    throw new Error('not implemented')
  }
  async createDirectory(): Promise<void> {}
  async delete(): Promise<void> {}
  async rename(): Promise<void> {}
  async listRecursive(): Promise<URI[]> {
    return []
  }
}

type WriteResult = { ok: boolean; signature: string }

class FakeBackend implements IOsClipboardBackend {
  readonly writeCalls: { paths: string[]; isCut: boolean }[] = []
  readCalls = 0
  clearCalls = 0
  osContent: IOsClipboardReadResult | undefined = undefined
  writeImpl: (paths: readonly string[], isCut: boolean) => Promise<WriteResult> = async (
    paths,
  ) => ({ ok: true, signature: paths.join('\n') })

  async writeFiles(paths: readonly string[], isCut: boolean): Promise<WriteResult> {
    this.writeCalls.push({ paths: [...paths], isCut })
    return this.writeImpl(paths, isCut)
  }

  async readFiles(): Promise<IOsClipboardReadResult | undefined> {
    this.readCalls++
    return this.osContent
  }

  async clear(): Promise<void> {
    this.clearCalls++
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const cleanups: string[] = []

function createHarness(): {
  backend: FakeBackend
  fileService: FakeFileService
  service: FileClipboardMainService
  materializeRoot: string
} {
  const backend = new FakeBackend()
  const fileService = new FakeFileService()
  const root = mkdtempSync(join(tmpdir(), 'ue-fileclipboard-'))
  cleanups.push(root)
  const materializeRoot = join(root, 'materialize')
  const service = new FileClipboardMainService(fileService, undefined, backend, materializeRoot)
  return { backend, fileService, service, materializeRoot }
}

function fileResource(path: string, isDirectory = false) {
  return { resource: URI.file(path).toJSON(), isDirectory }
}

function remoteResource(path: string, isDirectory = false) {
  return {
    resource: URI.from({ scheme: REMOTE_SCHEME, authority: 'test-host', path }).toJSON(),
    isDirectory,
  }
}

afterEach(async () => {
  vi.useRealTimers()
  while (cleanups.length > 0) {
    const dir = cleanups.pop()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('FileClipboardMainService', () => {
  it('writeResources stores an internal snapshot and readResources serves it without touching the backend', async () => {
    const { backend, service } = createHarness()
    await service.writeResources([fileResource('/tmp/a.txt'), fileResource('/tmp/a.txt')], false)

    expect(backend.writeCalls).toEqual([{ paths: ['/tmp/a.txt'], isCut: false }])

    const snapshot = await service.readResources()
    expect(snapshot.source).toBe('internal')
    expect(snapshot.isCut).toBe(false)
    expect(snapshot.resources.map((r) => URI.revive(r.resource)?.toString())).toEqual([
      URI.file('/tmp/a.txt').toString(),
    ])
    expect(backend.readCalls).toBe(0)
  })

  it('fires onDidChangeClipboard when a write commits', async () => {
    const { service } = createHarness()
    const events: IFileClipboardSnapshot[] = []
    service.onDidChangeClipboard((snapshot) => events.push(snapshot))

    await service.writeResources([fileResource('/tmp/a.txt')], true)
    expect(events).toHaveLength(1)
    expect(events[0]?.source).toBe('internal')
    expect(events[0]?.isCut).toBe(true)
  })

  it('falls back to the os snapshot when the signature no longer matches (another app overwrote)', async () => {
    vi.useFakeTimers()
    const { backend, fileService, service } = createHarness()
    await service.writeResources([fileResource('/tmp/a.txt')], false)

    backend.osContent = {
      paths: ['/elsewhere/dir'],
      isCut: false,
      signature: 'written-by-another-app',
    }
    fileService.addDir(URI.file('/elsewhere/dir'))

    vi.setSystemTime(Date.now() + 6_000)
    const events: IFileClipboardSnapshot[] = []
    service.onDidChangeClipboard((snapshot) => events.push(snapshot))

    const snapshot = await service.readResources()
    expect(snapshot.source).toBe('os')
    expect(snapshot.resources).toEqual([
      { resource: URI.file('/elsewhere/dir').toJSON(), isDirectory: true },
    ])
    expect(backend.readCalls).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0]?.source).toBe('os')

    // Internal state was dropped; the next read goes to the backend again.
    const again = await service.readResources()
    expect(again.source).toBe('os')
    expect(backend.readCalls).toBe(2)
  })

  it('keeps the internal snapshot when the backend reports no file content (degraded text-only write)', async () => {
    vi.useFakeTimers()
    const { backend, service } = createHarness()
    await service.writeResources([fileResource('/tmp/a.txt')], false)

    backend.osContent = undefined
    vi.setSystemTime(Date.now() + 60_000)

    const snapshot = await service.readResources()
    expect(snapshot.source).toBe('internal')
    expect(snapshot.resources).toEqual([fileResource('/tmp/a.txt')])
  })

  it('reads the os clipboard when internal state is empty', async () => {
    const { backend, fileService, service } = createHarness()
    backend.osContent = { paths: ['/os/copied.txt'], isCut: true, signature: 'os-sig' }
    fileService.addFile(URI.file('/os/copied.txt'), 12)

    const snapshot = await service.readResources()
    expect(snapshot.source).toBe('os')
    expect(snapshot.isCut).toBe(true)
    expect(snapshot.resources).toEqual([
      { resource: URI.file('/os/copied.txt').toJSON(), isDirectory: false },
    ])
  })

  it('returns an empty snapshot when neither side holds file content', async () => {
    const { service } = createHarness()
    const snapshot = await service.readResources()
    expect(snapshot.resources).toEqual([])
    expect(snapshot.isCut).toBe(false)
    expect(snapshot.source).toBe('os')
  })

  it('waits for an in-flight first write instead of returning stale os content', async () => {
    const { backend, service } = createHarness()
    const pending = deferred<WriteResult>()
    backend.writeImpl = () => pending.promise
    backend.osContent = { paths: ['/stale/old.txt'], isCut: false, signature: 'old-sig' }

    const write = service.writeResources([fileResource('/tmp/fresh.txt')], false)
    const read = service.readResources()
    pending.resolve({ ok: true, signature: '/tmp/fresh.txt' })
    await write

    const snapshot = await read
    expect(snapshot.source).toBe('internal')
    expect(snapshot.resources).toEqual([fileResource('/tmp/fresh.txt')])
  })

  it('clear() wipes the os clipboard only while we still own it', async () => {
    const { backend, service } = createHarness()
    await service.writeResources([fileResource('/tmp/a.txt')], false)
    backend.osContent = { paths: ['/tmp/a.txt'], isCut: false, signature: '/tmp/a.txt' }

    await service.clear()
    expect(backend.clearCalls).toBe(1)
    expect(backend.readCalls).toBe(1)
    const after = await service.readResources()
    expect(after.source).toBe('os')
  })

  it('clear() leaves the os clipboard untouched when ownership was lost', async () => {
    const { backend, service } = createHarness()
    await service.writeResources([fileResource('/tmp/a.txt')], false)
    backend.osContent = { paths: ['/other/f.txt'], isCut: false, signature: 'not-ours' }

    await service.clear()
    expect(backend.clearCalls).toBe(0)
    expect(backend.readCalls).toBe(1)
  })

  it('clear() with no state never touches the os clipboard', async () => {
    const { backend, service } = createHarness()
    await service.clear()
    expect(backend.clearCalls).toBe(0)
    expect(backend.readCalls).toBe(0)
  })

  it('a superseded in-flight write does not overwrite the newer state', async () => {
    const { backend, service } = createHarness()
    const first = deferred<WriteResult>()
    backend.writeImpl = () => first.promise
    const firstWrite = service.writeResources([fileResource('/tmp/old.txt')], false)
    await Promise.resolve()
    await Promise.resolve()
    expect(backend.writeCalls).toHaveLength(1)

    const events: IFileClipboardSnapshot[] = []
    service.onDidChangeClipboard((snapshot) => events.push(snapshot))
    backend.writeImpl = async (paths) => ({ ok: true, signature: paths.join('\n') })
    await service.writeResources([fileResource('/tmp/new.txt')], true)

    first.resolve({ ok: true, signature: '/tmp/old.txt' })
    await firstWrite

    const snapshot = await service.readResources()
    expect(snapshot.isCut).toBe(true)
    expect(snapshot.resources).toEqual([fileResource('/tmp/new.txt')])
    expect(events).toHaveLength(1)
  })

  it('a backend-degraded write (ok:false) keeps the in-memory state usable', async () => {
    const { backend, service } = createHarness()
    backend.writeImpl = async () => ({ ok: false, signature: '/tmp/a.txt' })

    await service.writeResources([fileResource('/tmp/a.txt')], false)
    const snapshot = await service.readResources()
    expect(snapshot.source).toBe('internal')
    expect(snapshot.resources).toEqual([fileResource('/tmp/a.txt')])
  })

  it('materializes non-revealable resources to temp and keeps the original uri in memory', async () => {
    const { backend, fileService, service, materializeRoot } = createHarness()
    await service.writeResources([remoteResource('/docs/note.txt')], false)

    expect(fileService.copied).toHaveLength(1)
    const copied = fileService.copied[0]!
    expect(copied.source).toBe('remote-ssh://test-host/docs/note.txt')
    const targetFsPath = URI.parse(copied.target).fsPath
    expect(targetFsPath.startsWith(join(materializeRoot, 's1-'))).toBe(true)
    expect(targetFsPath.endsWith('/0-note.txt')).toBe(true)

    const osPath = backend.writeCalls[0]!.paths[0]!
    expect(osPath.startsWith(materializeRoot)).toBe(true)
    expect(osPath.endsWith('0-note.txt')).toBe(true)

    const snapshot = await service.readResources()
    expect(snapshot.source).toBe('internal')
    expect(URI.revive(snapshot.resources[0]!.resource)?.toString()).toBe(
      'remote-ssh://test-host/docs/note.txt',
    )
  })

  it('skips materialization when opts.materialize is false', async () => {
    const { backend, fileService, service } = createHarness()
    await service.writeResources(
      [remoteResource('/docs/note.txt'), fileResource('/tmp/a.txt')],
      false,
      { materialize: false },
    )

    expect(fileService.copied).toEqual([])
    expect(backend.writeCalls[0]?.paths).toEqual(['/tmp/a.txt'])
    const snapshot = await service.readResources()
    expect(snapshot.resources).toHaveLength(2)
  })

  it('writeResources with empty resources clears the clipboard', async () => {
    const { backend, service } = createHarness()
    await service.writeResources([], false)
    expect(backend.writeCalls).toHaveLength(0)
    expect(backend.clearCalls).toBe(0)
    const snapshot = await service.readResources()
    expect(snapshot.resources).toEqual([])
  })

  describe('checkWriteCost', () => {
    it('does not walk locally revealable resources', async () => {
      const { fileService, service } = createHarness()
      const cost = await service.checkWriteCost([fileResource('/tmp/a.txt')])
      expect(cost).toEqual({
        materializeCount: 0,
        totalBytes: 0,
        needsConfirmation: false,
        refused: false,
      })
      expect(fileService.statCalls).toBe(0)
    })

    it('exactly the confirmation threshold does not need confirmation', async () => {
      const { fileService, service } = createHarness()
      fileService.addFile(
        URI.from({ scheme: REMOTE_SCHEME, authority: 'test-host', path: '/big.bin' }),
        FILE_CLIPBOARD_CONFIRM_BYTES,
      )
      const cost = await service.checkWriteCost([remoteResource('/big.bin')])
      expect(cost.needsConfirmation).toBe(false)
      expect(cost.refused).toBe(false)
      expect(cost.totalBytes).toBe(FILE_CLIPBOARD_CONFIRM_BYTES)
      expect(cost.materializeCount).toBe(1)
    })

    it('sums a remote tree and flags confirmation above the threshold', async () => {
      const { fileService, service } = createHarness()
      const dir = URI.from({ scheme: REMOTE_SCHEME, authority: 'test-host', path: '/dir' })
      fileService.addDir(dir, ['x.bin', 'y.bin', 'sub'])
      fileService.addFile(URI.joinPath(dir, 'x.bin'), FILE_CLIPBOARD_CONFIRM_BYTES)
      fileService.addFile(URI.joinPath(dir, 'y.bin'), 1)
      fileService.addDir(URI.joinPath(dir, 'sub'), ['z.bin'])
      fileService.addFile(URI.joinPath(dir, 'sub', 'z.bin'), 10)

      const cost = await service.checkWriteCost([remoteResource('/dir', true)])
      expect(cost.totalBytes).toBe(FILE_CLIPBOARD_CONFIRM_BYTES + 11)
      expect(cost.needsConfirmation).toBe(true)
      expect(cost.refused).toBe(false)
      expect(cost.materializeCount).toBe(1)
    })

    it('refuses writes above the byte limit', async () => {
      const { fileService, service } = createHarness()
      fileService.addFile(
        URI.from({ scheme: REMOTE_SCHEME, authority: 'test-host', path: '/huge.bin' }),
        FILE_CLIPBOARD_REFUSE_BYTES + 1,
      )
      const cost = await service.checkWriteCost([remoteResource('/huge.bin')])
      expect(cost.refused).toBe(true)
      expect(cost.needsConfirmation).toBe(false)
    })

    it('refuses writes above the entry limit and aborts the walk early', async () => {
      const { fileService, service } = createHarness()
      const dir = URI.from({ scheme: REMOTE_SCHEME, authority: 'test-host', path: '/many' })
      const total = FILE_CLIPBOARD_REFUSE_ENTRIES + 5
      const names: string[] = []
      for (let i = 0; i < total; i++) names.push(`f${i}.txt`)
      fileService.addDir(dir, names)
      for (const name of names) fileService.addFile(URI.joinPath(dir, name), 1)

      const cost = await service.checkWriteCost([remoteResource('/many', true)])
      expect(cost.refused).toBe(true)
      // 1 stat for the root + exactly FILE_CLIPBOARD_REFUSE_ENTRIES children:
      // the walk aborted as soon as the limit was exceeded, leaving 4 files unvisited.
      expect(fileService.statCalls).toBe(FILE_CLIPBOARD_REFUSE_ENTRIES + 1)
    })

    it('counts only the materialize-needed resources', async () => {
      const { fileService, service } = createHarness()
      fileService.addFile(URI.file('/tmp/local.txt'), 999)
      fileService.addFile(
        URI.from({ scheme: REMOTE_SCHEME, authority: 'test-host', path: '/remote.txt' }),
        7,
      )
      const cost = await service.checkWriteCost([
        fileResource('/tmp/local.txt'),
        remoteResource('/remote.txt'),
      ])
      expect(cost.materializeCount).toBe(1)
      expect(cost.totalBytes).toBe(7)
    })
  })
})
