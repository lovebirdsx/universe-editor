/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/explorer/ExplorerFileOperationService.ts
 *
 *  Exercises the reversible file operations (create / rename / move / copy /
 *  delete) end-to-end: each runs against a fake in-memory IFileService, is
 *  pushed onto a real UndoRedoService, and is then walked back and forth with
 *  undo(source) / redo(source).
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Event,
  IFileService,
  IFileWatcherService,
  ILoggerService,
  IUndoRedoService,
  IWorkspaceService,
  InstantiationService,
  LogLevel,
  ServiceCollection,
  UndoRedoService,
  URI,
  type IDialogService,
  type IDirectoryEntry,
  type IFileService as IFileServiceType,
  type IFileStat,
  type IFileWatcherService as IFileWatcherServiceType,
  type ILogger,
  type INotificationService,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { ExplorerTreeService, IExplorerTreeService } from '../ExplorerTreeService.js'
import {
  EXPLORER_UNDO_SOURCE,
  ExplorerFileOperationService,
} from '../ExplorerFileOperationService.js'
import { IExcludeService } from '../../exclude/ExcludeService.js'
import { FakeExcludeService } from '../../exclude/testing/fakeExcludeService.js'

/**
 * In-memory fs backing both directory structure (dirs) and file contents
 * (fileContents). Modeled on ExplorerTreeService.test.ts's FakeFs but with
 * real readFile/readFileText/stat so the delete-backup path can be exercised.
 */
function makeFs(initial: Record<string, IDirectoryEntry[]> = {}) {
  const dirs = new Map<string, IDirectoryEntry[]>()
  for (const [k, v] of Object.entries(initial)) dirs.set(k, v)
  const fileContents = new Map<string, string>()

  const basename = (resource: URI) => resource.path.split('/').at(-1) ?? resource.path
  const parent = (resource: URI): URI | null => {
    const slash = resource.path.lastIndexOf('/')
    if (slash <= 0) return null
    return resource.with({ path: resource.path.slice(0, slash) })
  }
  const removeParentEntry = (resource: URI) => {
    const p = parent(resource)
    if (!p) return
    const entries = dirs.get(p.toString())
    if (!entries) return
    dirs.set(
      p.toString(),
      entries.filter((entry) => entry.name !== basename(resource)),
    )
  }
  const upsertParentEntry = (resource: URI, isDirectory: boolean) => {
    const p = parent(resource)
    if (!p) return
    const entries = dirs.get(p.toString()) ?? []
    const name = basename(resource)
    if (!entries.some((entry) => entry.name === name)) {
      dirs.set(p.toString(), [...entries, { name, isFile: !isDirectory, isDirectory }])
    }
  }

  const fs: IFileServiceType = {
    _serviceBrand: undefined,
    async readFile(resource: URI) {
      const content = fileContents.get(resource.toString())
      if (content === undefined) throw new Error('ENOENT')
      return new TextEncoder().encode(content)
    },
    async readFileText(resource: URI) {
      const content = fileContents.get(resource.toString())
      if (content === undefined) throw new Error('ENOENT')
      return content
    },
    async writeFile(resource: URI, content: Uint8Array | string) {
      fileContents.set(
        resource.toString(),
        typeof content === 'string' ? content : new TextDecoder().decode(content),
      )
      upsertParentEntry(resource, false)
    },
    async exists(resource: URI) {
      return fileContents.has(resource.toString()) || dirs.has(resource.toString())
    },
    async stat(resource: URI): Promise<IFileStat> {
      const content = fileContents.get(resource.toString())
      const isDirectory = dirs.has(resource.toString())
      return {
        resource,
        isFile: content !== undefined,
        isDirectory,
        size: content !== undefined ? new TextEncoder().encode(content).length : 0,
        mtime: 0,
      }
    },
    async list(resource: URI) {
      return dirs.get(resource.toString()) ?? []
    },
    async createDirectory(resource: URI) {
      if (!dirs.has(resource.toString())) dirs.set(resource.toString(), [])
      upsertParentEntry(resource, true)
    },
    async delete(resource: URI) {
      fileContents.delete(resource.toString())
      dirs.delete(resource.toString())
      removeParentEntry(resource)
      const prefix = resource.toString() + '/'
      for (const key of [...fileContents.keys()]) {
        if (key.startsWith(prefix)) fileContents.delete(key)
      }
      for (const key of [...dirs.keys()]) {
        if (key.startsWith(prefix)) dirs.delete(key)
      }
    },
    async rename(source: URI, target: URI, opts?: { overwrite?: boolean }) {
      if (
        opts?.overwrite !== true &&
        (fileContents.has(target.toString()) || dirs.has(target.toString()))
      ) {
        throw new Error('target exists')
      }
      const sk = source.toString()
      const tk = target.toString()
      if (fileContents.has(sk)) {
        fileContents.set(tk, fileContents.get(sk)!)
        fileContents.delete(sk)
        removeParentEntry(source)
        upsertParentEntry(target, false)
      }
      if (dirs.has(sk)) {
        const prefix = sk + '/'
        const movedDirs: Array<[string, IDirectoryEntry[]]> = []
        for (const [key, value] of dirs) {
          if (key === sk || key.startsWith(prefix)) movedDirs.push([key, value])
        }
        for (const [key] of movedDirs) dirs.delete(key)
        for (const [key, value] of movedDirs) dirs.set(key.replace(sk, tk), value)
        for (const key of [...fileContents.keys()]) {
          if (key.startsWith(prefix)) {
            fileContents.set(key.replace(sk, tk), fileContents.get(key)!)
            fileContents.delete(key)
          }
        }
        removeParentEntry(source)
        upsertParentEntry(target, true)
      }
    },
    async copy(source: URI, target: URI, opts?: { overwrite?: boolean }) {
      if (
        opts?.overwrite !== true &&
        (fileContents.has(target.toString()) || dirs.has(target.toString()))
      ) {
        throw new Error('target exists')
      }
      const sk = source.toString()
      const tk = target.toString()
      if (fileContents.has(sk)) {
        fileContents.set(tk, fileContents.get(sk)!)
        upsertParentEntry(target, false)
        return
      }
      if (dirs.has(sk)) {
        const prefix = sk + '/'
        for (const [key, value] of [...dirs]) {
          if (key === sk || key.startsWith(prefix)) dirs.set(key.replace(sk, tk), [...value])
        }
        for (const key of [...fileContents.keys()]) {
          if (key.startsWith(prefix)) fileContents.set(key.replace(sk, tk), fileContents.get(key)!)
        }
        upsertParentEntry(target, true)
      }
    },
    async listRecursive() {
      return []
    },
  }
  return { fs, dirs, fileContents }
}

class FakeWorkspaceService implements IWorkspaceServiceType {
  declare readonly _serviceBrand: undefined
  private readonly _changed = new Emitter<IWorkspace | null>()
  readonly onDidChangeWorkspace = this._changed.event
  readonly onDidChangeRecent = new Emitter<readonly never[]>().event
  current: IWorkspace | null
  readonly recent = [] as never[]
  readonly whenReady: Promise<void> = Promise.resolve()
  constructor(initial: URI) {
    this.current = { folder: initial, name: 'ws' }
  }
  async openFolder() {}
  async closeFolder() {}
  async clearRecent() {}
  async removeRecent() {}
}

class FakeWatcher implements IFileWatcherServiceType {
  declare readonly _serviceBrand: undefined
  private readonly _emitter = new Emitter<readonly never[]>()
  readonly onDidChangeFiles = this._emitter.event
  async watch() {}
  async setExcludes() {}
  async unwatch() {}
  async watchOutOfWorkspace() {}
}

function makeLogger(): ILogger {
  return {
    level: LogLevel.Info,
    onDidChangeLogLevel: Event.None,
    setLevel: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
    dispose: vi.fn(),
  }
}

const root = URI.file('/ws')

describe('ExplorerFileOperationService', () => {
  let bundle: ReturnType<typeof makeFs>
  let tree: ExplorerTreeService
  let ops: ExplorerFileOperationService
  let undoRedo: IUndoRedoService

  beforeEach(() => {
    bundle = makeFs({ [root.toString()]: [] })

    const dialog: IDialogService = {
      _serviceBrand: undefined,
      confirm: async () => ({ confirmed: true, choice: 'primary' }),
      prompt: async () => undefined,
    }
    const notification = { notify: () => ({ dispose() {} }) } as unknown as INotificationService
    undoRedo = new UndoRedoService(dialog, notification)

    const services = new ServiceCollection()
    services.set(IFileService, bundle.fs)
    services.set(IWorkspaceService, new FakeWorkspaceService(root))
    services.set(IFileWatcherService, new FakeWatcher())
    services.set(IExcludeService, new FakeExcludeService())
    services.set(IUndoRedoService, undoRedo)
    const logger = makeLogger()
    services.set(ILoggerService, {
      _serviceBrand: undefined,
      createLogger: () => logger,
      setLevel: () => {},
      getLevel: () => LogLevel.Info,
    })

    const inst = new InstantiationService(services)
    tree = inst.createInstance(ExplorerTreeService)
    services.set(IExplorerTreeService, tree)
    ops = inst.createInstance(ExplorerFileOperationService)
  })

  it('createFile is undoable and redoable', async () => {
    const created = await ops.createFile(root, 'a.txt')
    expect(await bundle.fs.exists(created)).toBe(true)
    expect(undoRedo.canUndo(EXPLORER_UNDO_SOURCE)).toBe(true)

    await undoRedo.undo(EXPLORER_UNDO_SOURCE)
    expect(await bundle.fs.exists(created)).toBe(false)

    await undoRedo.redo(EXPLORER_UNDO_SOURCE)
    expect(await bundle.fs.exists(created)).toBe(true)
  })

  it('createFolder is undoable and redoable', async () => {
    const created = await ops.createFolder(root, 'dir')
    expect(await bundle.fs.exists(created)).toBe(true)

    await undoRedo.undo(EXPLORER_UNDO_SOURCE)
    expect(await bundle.fs.exists(created)).toBe(false)

    await undoRedo.redo(EXPLORER_UNDO_SOURCE)
    expect(await bundle.fs.exists(created)).toBe(true)
  })

  it('rename is undoable (restores the original name)', async () => {
    const a = await ops.createFile(root, 'a.txt')
    await ops.rename(a, 'b.txt')
    const b = URI.joinPath(root, 'b.txt')
    expect(await bundle.fs.exists(b)).toBe(true)
    expect(await bundle.fs.exists(a)).toBe(false)

    await undoRedo.undo(EXPLORER_UNDO_SOURCE)
    expect(await bundle.fs.exists(a)).toBe(true)
    expect(await bundle.fs.exists(b)).toBe(false)

    await undoRedo.redo(EXPLORER_UNDO_SOURCE)
    expect(await bundle.fs.exists(b)).toBe(true)
    expect(await bundle.fs.exists(a)).toBe(false)
  })

  it('delete backs up file content and restores it on undo', async () => {
    const a = await ops.createFile(root, 'note.txt')
    await bundle.fs.writeFile(a, 'hello world')

    await ops.delete([{ resource: a, isDirectory: false }], /*useTrash*/ false)
    expect(await bundle.fs.exists(a)).toBe(false)

    await undoRedo.undo(EXPLORER_UNDO_SOURCE)
    expect(await bundle.fs.exists(a)).toBe(true)
    expect(await bundle.fs.readFileText(a)).toBe('hello world')

    await undoRedo.redo(EXPLORER_UNDO_SOURCE)
    expect(await bundle.fs.exists(a)).toBe(false)
  })

  it('delete restores a directory subtree on undo', async () => {
    const dir = await ops.createFolder(root, 'dir')
    const inner = URI.joinPath(dir, 'inner.txt')
    await bundle.fs.writeFile(inner, 'x')

    await ops.delete([{ resource: dir, isDirectory: true }], false)
    expect(await bundle.fs.exists(dir)).toBe(false)
    expect(await bundle.fs.exists(inner)).toBe(false)

    await undoRedo.undo(EXPLORER_UNDO_SOURCE)
    expect(await bundle.fs.exists(dir)).toBe(true)
    expect(await bundle.fs.readFileText(inner)).toBe('x')
  })

  it('copy is undoable (removes the copy, keeps the original)', async () => {
    const a = await ops.createFile(root, 'a.txt')
    await bundle.fs.writeFile(a, 'data')
    const dest = await ops.createFolder(root, 'dest')

    const [copied] = await ops.copyResources([{ resource: a, isDirectory: false }], dest)
    expect(copied && (await bundle.fs.exists(copied))).toBe(true)

    await undoRedo.undo(EXPLORER_UNDO_SOURCE)
    expect(await bundle.fs.exists(copied!)).toBe(false)
    expect(await bundle.fs.exists(a)).toBe(true)
  })

  it('move is undoable (moves back)', async () => {
    const a = await ops.createFile(root, 'a.txt')
    const dest = await ops.createFolder(root, 'dest')

    const [moved] = await ops.moveResources([{ resource: a, isDirectory: false }], dest)
    expect(moved && (await bundle.fs.exists(moved))).toBe(true)
    expect(await bundle.fs.exists(a)).toBe(false)

    await undoRedo.undo(EXPLORER_UNDO_SOURCE)
    expect(await bundle.fs.exists(a)).toBe(true)
    expect(await bundle.fs.exists(moved!)).toBe(false)
  })
})
