/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/explorer/ExplorerTreeService.ts
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Event,
  IFileService,
  IFileWatcherService,
  ILoggerService,
  IWorkspaceService,
  InstantiationService,
  LogLevel,
  ServiceCollection,
  URI,
  type IDirectoryEntry,
  type IFileChangeEvent,
  type IFileService as IFileServiceType,
  type IFileWatcherService as IFileWatcherServiceType,
  type ILogger,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
  type UriComponents,
} from '@universe-editor/platform'
import { ExplorerTreeService } from '../ExplorerTreeService.js'

interface FakeFs extends IFileServiceType {
  dirs: Map<string, IDirectoryEntry[]>
  files: Set<string>
  calls: {
    list: string[]
    writeFile: string[]
    createDirectory: string[]
    rename: string[]
    delete: string[]
  }
}

function makeFs(initial: Record<string, IDirectoryEntry[]> = {}): FakeFs {
  const dirs = new Map<string, IDirectoryEntry[]>()
  for (const [k, v] of Object.entries(initial)) dirs.set(k, v)
  const files = new Set<string>()
  const calls = {
    list: [] as string[],
    writeFile: [] as string[],
    createDirectory: [] as string[],
    rename: [] as string[],
    delete: [] as string[],
  }
  return {
    _serviceBrand: undefined,
    dirs,
    files,
    calls,
    async readFile() {
      throw new Error('not used')
    },
    async readFileText() {
      throw new Error('not used')
    },
    async writeFile(resource: URI) {
      calls.writeFile.push(resource.toString())
      files.add(resource.toString())
    },
    async exists(resource: URI) {
      return files.has(resource.toString()) || dirs.has(resource.toString())
    },
    async stat() {
      throw new Error('not used')
    },
    async list(resource: URI) {
      calls.list.push(resource.toString())
      return dirs.get(resource.toString()) ?? []
    },
    async createDirectory(resource: URI) {
      calls.createDirectory.push(resource.toString())
      dirs.set(resource.toString(), [])
    },
    async delete(resource: URI) {
      calls.delete.push(resource.toString())
      files.delete(resource.toString())
      dirs.delete(resource.toString())
    },
    async rename(source: URI, target: URI) {
      calls.rename.push(`${source.toString()}→${target.toString()}`)
      if (files.delete(source.toString())) files.add(target.toString())
      const d = dirs.get(source.toString())
      if (d !== undefined) {
        dirs.delete(source.toString())
        dirs.set(target.toString(), d)
      }
    },
    async listRecursive() {
      return []
    },
  } as FakeFs
}

class FakeWorkspaceService implements IWorkspaceServiceType {
  declare readonly _serviceBrand: undefined
  private readonly _changed = new Emitter<IWorkspace | null>()
  readonly onDidChangeWorkspace = this._changed.event
  readonly onDidChangeRecent = new Emitter<readonly never[]>().event
  current: IWorkspace | null
  readonly recent = [] as never[]
  readonly whenReady: Promise<void> = Promise.resolve()

  constructor(initial: URI | null) {
    this.current = initial ? { folder: initial, name: 'ws' } : null
  }

  async openFolder() {}
  async closeFolder() {}
  async clearRecent() {}

  setRoot(folder: URI | null) {
    this.current = folder ? { folder, name: 'ws' } : null
    this._changed.fire(this.current)
  }
}

class FakeWatcher implements IFileWatcherServiceType {
  declare readonly _serviceBrand: undefined
  private readonly _emitter = new Emitter<readonly IFileChangeEvent[]>()
  readonly onDidChangeFiles = this._emitter.event
  readonly watched: UriComponents[] = []
  unwatchCalls = 0
  async watch(folder: UriComponents): Promise<void> {
    this.watched.push(folder)
  }
  async unwatch(): Promise<void> {
    this.unwatchCalls++
  }
  fire(events: readonly IFileChangeEvent[]): void {
    this._emitter.fire(events)
  }
}

function makeInst(
  fs: IFileServiceType,
  ws: IWorkspaceServiceType,
  watcher: IFileWatcherServiceType,
  logger?: ILogger,
): InstantiationService {
  const services = new ServiceCollection()
  services.set(IFileService, fs)
  services.set(IWorkspaceService, ws)
  services.set(IFileWatcherService, watcher)
  if (logger) {
    services.set(ILoggerService, {
      _serviceBrand: undefined,
      createLogger: () => logger,
      setLevel: () => {},
      getLevel: () => LogLevel.Info,
    })
  }
  return new InstantiationService(services)
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

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('ExplorerTreeService', () => {
  let fs: FakeFs
  let ws: FakeWorkspaceService
  let watcher: FakeWatcher
  let inst: InstantiationService

  beforeEach(() => {
    fs = makeFs({
      [root.toString()]: [
        { name: 'src', isFile: false, isDirectory: true },
        { name: 'README.md', isFile: true, isDirectory: false },
      ],
      [URI.joinPath(root, 'src').toString()]: [
        { name: 'index.ts', isFile: true, isDirectory: false },
      ],
    })
    ws = new FakeWorkspaceService(root)
    watcher = new FakeWatcher()
    inst = makeInst(fs, ws, watcher)
  })

  it('seeds root expansion and lists children on construction', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    expect(tree.root?.toString()).toBe(root.toString())
    expect(tree.isExpanded(root)).toBe(true)
    expect(tree.getChildren(root)).toHaveLength(2)
    // directories before files
    expect(tree.getChildren(root)?.[0]?.name).toBe('src')
  })

  it('expand calls fs.list once and caches children', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const src = URI.joinPath(root, 'src')
    await tree.expand(src)
    await tree.expand(src)
    expect(fs.calls.list.filter((p) => p === src.toString())).toHaveLength(1)
    expect(tree.getChildren(src)).toHaveLength(1)
  })

  it('collapse flips expanded flag without re-fetching', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const src = URI.joinPath(root, 'src')
    await tree.expand(src)
    tree.collapse(src)
    expect(tree.isExpanded(src)).toBe(false)
    await tree.expand(src)
    expect(fs.calls.list.filter((p) => p === src.toString())).toHaveLength(1)
  })

  it('createFile writes through fs and refreshes the parent', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    fs.dirs.set(root.toString(), [
      ...(fs.dirs.get(root.toString()) ?? []),
      { name: 'a.txt', isFile: true, isDirectory: false },
    ])
    const created = await tree.createFile(root, 'a.txt')
    expect(created.toString()).toBe(URI.joinPath(root, 'a.txt').toString())
    expect(fs.calls.writeFile).toContain(created.toString())
    expect(tree.getChildren(root)?.some((c) => c.name === 'a.txt')).toBe(true)
  })

  it('createFile rejects when target already exists', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    fs.files.add(URI.joinPath(root, 'dup.txt').toString())
    await expect(tree.createFile(root, 'dup.txt')).rejects.toThrow(/already exists/)
    expect(fs.calls.writeFile).not.toContain(URI.joinPath(root, 'dup.txt').toString())
  })

  it('createFolder makes the directory and refreshes the parent', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    fs.dirs.set(root.toString(), [
      ...(fs.dirs.get(root.toString()) ?? []),
      { name: 'new', isFile: false, isDirectory: true },
    ])
    const created = await tree.createFolder(root, 'new')
    expect(fs.calls.createDirectory).toContain(created.toString())
  })

  it('rename moves the resource and refreshes the parent', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    fs.files.add(URI.joinPath(root, 'README.md').toString())
    const target = await tree.rename(URI.joinPath(root, 'README.md'), 'README2.md')
    expect(target.toString()).toBe(URI.joinPath(root, 'README2.md').toString())
    expect(fs.calls.rename[0]).toContain('README.md→')
  })

  it('delete removes from fs and refreshes the parent', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    fs.files.add(URI.joinPath(root, 'README.md').toString())
    await tree.delete(URI.joinPath(root, 'README.md'))
    expect(fs.calls.delete).toContain(URI.joinPath(root, 'README.md').toString())
  })

  it('switching workspace folders drops the prior root', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const other = URI.file('/other')
    fs.dirs.set(other.toString(), [])
    ws.setRoot(other)
    await flush()
    expect(tree.root?.toString()).toBe(other.toString())
    expect(tree.isExpanded(root)).toBe(false)
  })

  it('fs.list errors surface on the node without crashing', async () => {
    const logger = makeLogger()
    const tree = makeInst(fs, ws, watcher, logger).createInstance(ExplorerTreeService)
    await flush()
    const bad = URI.joinPath(root, 'missing')
    fs.dirs.delete(bad.toString())
    // Override list to throw
    const origList = fs.list.bind(fs)
    fs.list = async (uri: URI) => {
      if (uri.toString() === bad.toString()) throw new Error('boom')
      return origList(uri)
    }
    await tree.expand(bad)
    expect(tree.getChildren(bad)).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(`loadChildren failed ${bad.toString()}`, 'boom')
  })

  it('fires onDidChange when state mutates', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    let count = 0
    tree.onDidChange(() => count++)
    const src = URI.joinPath(root, 'src')
    await tree.expand(src)
    expect(count).toBeGreaterThan(0)
  })

  it('watcher event with a known parent triggers refresh', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    fs.calls.list.length = 0
    fs.dirs.set(root.toString(), [
      ...(fs.dirs.get(root.toString()) ?? []),
      { name: 'new.txt', isFile: true, isDirectory: false },
    ])
    watcher.fire([{ type: 'modified', resource: URI.joinPath(root, 'new.txt').toJSON() }])
    await flush()
    expect(fs.calls.list).toContain(root.toString())
    expect(tree.getChildren(root)?.some((c) => c.name === 'new.txt')).toBe(true)
  })

  it('watcher event for an unknown parent is ignored', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    fs.calls.list.length = 0
    const stranger = URI.file('/elsewhere/x.txt')
    watcher.fire([{ type: 'modified', resource: stranger.toJSON() }])
    await flush()
    expect(fs.calls.list).toHaveLength(0)
    expect(tree).toBeDefined()
  })

  it('switching workspace re-arms the watcher on the new root', async () => {
    inst.createInstance(ExplorerTreeService)
    await flush()
    expect(watcher.watched.map((u) => URI.revive(u)?.toString())).toContain(root.toString())
    const other = URI.file('/other')
    fs.dirs.set(other.toString(), [])
    ws.setRoot(other)
    await flush()
    expect(watcher.watched.map((u) => URI.revive(u)?.toString())).toContain(other.toString())
  })

  it('reveal on a direct child of the root selects it', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const target = URI.joinPath(root, 'README.md')
    const ok = await tree.reveal(target)
    expect(ok).toBe(true)
    expect(tree.selectedResource?.toString()).toBe(target.toString())
    expect(tree.isExpanded(root)).toBe(true)
  })

  it('reveal expands every ancestor before selecting', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const src = URI.joinPath(root, 'src')
    expect(tree.isExpanded(src)).toBe(false)
    const target = URI.joinPath(src, 'index.ts')
    const ok = await tree.reveal(target)
    expect(ok).toBe(true)
    expect(tree.isExpanded(src)).toBe(true)
    expect(tree.selectedResource?.toString()).toBe(target.toString())
  })

  it('reveal returns false for a target outside the workspace', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const ok = await tree.reveal(URI.file('/elsewhere/x.txt'))
    expect(ok).toBe(false)
    expect(tree.selectedResource).toBeNull()
  })

  it('setSelection updates selectedResource and fires onDidChange', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    let fired = 0
    tree.onDidChange(() => fired++)
    const target = URI.joinPath(root, 'README.md')
    tree.setSelection(target)
    expect(tree.selectedResource?.toString()).toBe(target.toString())
    expect(fired).toBeGreaterThan(0)
    fired = 0
    tree.setSelection(target)
    expect(fired).toBe(0)
  })

  it('setSelection with an array stores every entry and sets focus to the last by default', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const a = URI.joinPath(root, 'README.md')
    const b = URI.joinPath(root, 'src')
    tree.setSelection([a, b])
    expect(tree.selection.map((u) => u.toString())).toEqual([a.toString(), b.toString()])
    expect(tree.focused?.toString()).toBe(b.toString())
  })

  it('setSelection honors an explicit focus argument', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const a = URI.joinPath(root, 'README.md')
    const b = URI.joinPath(root, 'src')
    tree.setSelection([a, b], a)
    expect(tree.focused?.toString()).toBe(a.toString())
  })

  it('setFocus updates focus alone, leaving the selection untouched', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const a = URI.joinPath(root, 'README.md')
    const b = URI.joinPath(root, 'src')
    tree.setSelection([a], a)
    tree.setFocus(b)
    expect(tree.focused?.toString()).toBe(b.toString())
    expect(tree.selection.map((u) => u.toString())).toEqual([a.toString()])
  })

  it('toggleInSelection adds when absent and removes when present', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const a = URI.joinPath(root, 'README.md')
    const b = URI.joinPath(root, 'src')
    tree.setSelection([a], a)
    tree.toggleInSelection(b)
    expect(tree.selection.map((u) => u.toString()).sort()).toEqual(
      [a.toString(), b.toString()].sort(),
    )
    expect(tree.focused?.toString()).toBe(b.toString())
    tree.toggleInSelection(b)
    expect(tree.selection.map((u) => u.toString())).toEqual([a.toString()])
    expect(tree.focused?.toString()).toBe(b.toString())
  })

  it('selectRange spans the inclusive range between anchor and target in visible order', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(URI.joinPath(root, 'src'))
    const visible = tree.getVisibleEntries()
    // [root, src, index.ts, README.md]
    const anchor = visible[1]!.resource // src
    const target = visible[3]!.resource // README.md
    tree.selectRange(anchor, target)
    expect(tree.selection.map((u) => u.toString())).toEqual([
      visible[1]!.resource.toString(),
      visible[2]!.resource.toString(),
      visible[3]!.resource.toString(),
    ])
    expect(tree.focused?.toString()).toBe(target.toString())
  })

  it('selectRange works in reverse order too', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(URI.joinPath(root, 'src'))
    const visible = tree.getVisibleEntries()
    const anchor = visible[3]!.resource
    const target = visible[1]!.resource
    tree.selectRange(anchor, target)
    expect(tree.selection.map((u) => u.toString())).toEqual([
      visible[1]!.resource.toString(),
      visible[2]!.resource.toString(),
      visible[3]!.resource.toString(),
    ])
    expect(tree.focused?.toString()).toBe(target.toString())
  })

  it('setActiveEditorResource fires onDidChange and exposes the value', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    let fired = 0
    tree.onDidChange(() => fired++)
    const target = URI.joinPath(root, 'README.md')
    tree.setActiveEditorResource(target)
    expect(tree.activeEditorResource?.toString()).toBe(target.toString())
    expect(fired).toBeGreaterThan(0)
    fired = 0
    tree.setActiveEditorResource(target)
    expect(fired).toBe(0)
  })

  it('reveal sets focus and replaces the selection with the single target', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const a = URI.joinPath(root, 'README.md')
    const b = URI.joinPath(URI.joinPath(root, 'src'), 'index.ts')
    tree.setSelection([a, URI.joinPath(root, 'src')])
    await tree.reveal(b)
    expect(tree.focused?.toString()).toBe(b.toString())
    expect(tree.selection.map((u) => u.toString())).toEqual([b.toString()])
  })

  it('switching workspace folders resets every selection-related state', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    tree.setSelection([URI.joinPath(root, 'README.md')])
    tree.setActiveEditorResource(URI.joinPath(root, 'README.md'))
    const other = URI.file('/other')
    fs.dirs.set(other.toString(), [])
    ws.setRoot(other)
    await flush()
    expect(tree.selection).toEqual([])
    expect(tree.focused).toBeNull()
    expect(tree.activeEditorResource).toBeNull()
  })
})
