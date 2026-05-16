/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/explorer/ExplorerTreeService.ts
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  IFileService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IDirectoryEntry,
  type IFileService as IFileServiceType,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
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
  } as FakeFs
}

class FakeWorkspaceService implements IWorkspaceServiceType {
  declare readonly _serviceBrand: undefined
  private readonly _changed = new Emitter<IWorkspace | null>()
  readonly onDidChangeWorkspace = this._changed.event
  readonly onDidChangeRecent = new Emitter<readonly never[]>().event
  current: IWorkspace | null
  readonly recent = [] as never[]

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

function makeInst(fs: IFileServiceType, ws: IWorkspaceServiceType): InstantiationService {
  const services = new ServiceCollection()
  services.set(IFileService, fs)
  services.set(IWorkspaceService, ws)
  return new InstantiationService(services)
}

const root = URI.file('/ws')

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('ExplorerTreeService', () => {
  let fs: FakeFs
  let ws: FakeWorkspaceService
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
    inst = makeInst(fs, ws)
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
    const tree = inst.createInstance(ExplorerTreeService)
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
  })

  it('fires onDidChange when state mutates', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    let count = 0
    tree.onDidChange(() => count++)
    const src = URI.joinPath(root, 'src')
    await tree.expand(src)
    expect(count).toBeGreaterThan(0)
  })
})
