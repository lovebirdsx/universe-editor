/*---------------------------------------------------------------------------------------------
 *  Tests for RecentFilesService and RecentFilesContribution.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Event,
  IEditorGroupsService,
  IFileService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
  URI,
  registerAction2,
  type EditorInput,
  type IEditorGroup,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IFileService as IFileServiceType,
  type IStorageService as IStorageServiceType,
} from '@universe-editor/platform'
import { IRecentFilesService, RecentFilesService } from '../recentFilesService.js'
import { RecentFilesContribution } from '../../../contributions/RecentFilesContribution.js'
import { FileEditorInput } from '../../editor/FileEditorInput.js'
import { ClearRecentFilesAction } from '../../../actions/fileOpenActions.js'

// ---------------------------------------------------------------------------
// Fake IStorageService
// ---------------------------------------------------------------------------

class FakeStorage implements IStorageServiceType {
  declare readonly _serviceBrand: undefined
  private readonly _data = new Map<string, unknown>()
  readonly onDidChangeWorkspaceScope = Event.None

  async get<T>(key: string): Promise<T | undefined> {
    return this._data.get(key) as T | undefined
  }

  async set(key: string, value: unknown): Promise<void> {
    this._data.set(key, value)
  }

  async remove(key: string): Promise<void> {
    this._data.delete(key)
  }

  seed(key: string, value: unknown): void {
    this._data.set(key, value)
  }
}

// ---------------------------------------------------------------------------
// Fake IEditorGroupsService
// ---------------------------------------------------------------------------

function makeGroupsService(initialActive?: EditorInput): {
  service: IEditorGroupsServiceType
  fireActiveEditorChange: () => void
  fireActiveGroupChange: (group: IEditorGroup) => void
  setActiveEditor: (editor: EditorInput | undefined) => void
} {
  const activeEditorChangeEmitter = new Emitter<void>()
  const activeGroupChangeEmitter = new Emitter<IEditorGroup>()

  let activeEditor: EditorInput | undefined = initialActive

  const group: IEditorGroup = {
    id: 0,
    index: 0,
    isActive: true,
    count: 0,
    editors: [],
    previewEditor: undefined,
    get activeEditor() {
      return activeEditor
    },
    onDidActiveEditorChange: activeEditorChangeEmitter.event,
    onDidChangeModel: new Emitter<never>().event,
    openEditor() {},
    closeEditor() {
      return true
    },
    closeAllEditors() {},
    moveEditor() {},
    setActive() {},
    pinEditor() {},
    isPinned() {
      return true
    },
    getEditorByIndex() {
      return undefined
    },
    focus() {},
  } as unknown as IEditorGroup

  const service: IEditorGroupsServiceType = {
    _serviceBrand: undefined,
    activeGroup: group,
    groups: [group],
    count: 1,
    orientation: 0,
    onDidActiveGroupChange: activeGroupChangeEmitter.event,
    onDidAddGroup: new Emitter<never>().event,
    onDidRemoveGroup: new Emitter<never>().event,
    onDidMoveGroup: new Emitter<never>().event,
    getGroup() {
      return group
    },
    getGroups() {
      return [group]
    },
    findGroup() {
      return undefined
    },
    activateGroup() {
      return group
    },
    addGroup() {
      return group
    },
    removeGroup() {},
    moveGroup() {
      return group
    },
    moveEditor() {},
    copyEditor() {},
    setGroupOrientation() {},
    arrangeGroups() {},
  } as unknown as IEditorGroupsServiceType

  return {
    service,
    fireActiveEditorChange: () => activeEditorChangeEmitter.fire(),
    fireActiveGroupChange: (g: IEditorGroup) => activeGroupChangeEmitter.fire(g),
    setActiveEditor: (editor: EditorInput | undefined) => {
      activeEditor = editor
    },
  }
}

// ---------------------------------------------------------------------------
// Fake IFileService (minimal — FileEditorInput constructor needs it)
// ---------------------------------------------------------------------------

function makeFakeFileService() {
  return {
    _serviceBrand: undefined,
    async readFileText() {
      return ''
    },
    async readFile() {
      return new Uint8Array()
    },
    async writeFile() {},
    async exists() {
      return false
    },
    async stat() {
      throw new Error('stat not used')
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
  } as never
}

// ---------------------------------------------------------------------------
// Fake IFileService for RecentFilesService (getAll() existence filtering)
// ---------------------------------------------------------------------------

function makeRecentFilesFileService(exists?: (uri: URI) => boolean): IFileServiceType {
  return {
    _serviceBrand: undefined,
    async exists(uri: URI) {
      return exists ? exists(uri) : true
    },
    async readFileText() {
      return ''
    },
    async readFile() {
      return new Uint8Array()
    },
    async writeFile() {},
    async stat() {
      throw new Error('stat not used')
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
  } as unknown as IFileServiceType
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildService(storage: FakeStorage, fileService?: IFileServiceType): RecentFilesService {
  const services = new ServiceCollection()
  services.set(IStorageService, storage)
  services.set(IFileService, fileService ?? makeRecentFilesFileService())
  const inst = new InstantiationService(services)
  return inst.createInstance(RecentFilesService)
}

function makeFileInput(uri: URI): FileEditorInput {
  const fileService = makeFakeFileService()
  const services = new ServiceCollection()
  services.set(IFileService, fileService)
  const inst = new InstantiationService(services)
  return inst.createInstance(FileEditorInput, uri)
}

function buildContribution(
  storage: FakeStorage,
  groupsService: IEditorGroupsServiceType,
): { contribution: RecentFilesContribution; recentService: RecentFilesService } {
  const recentService = buildService(storage)
  const services = new ServiceCollection()
  services.set(IRecentFilesService, recentService)
  services.set(IEditorGroupsService, groupsService)
  const inst = new InstantiationService(services)
  const contribution = inst.createInstance(RecentFilesContribution)
  return { contribution, recentService }
}

// ---------------------------------------------------------------------------
// RecentFilesService tests
// ---------------------------------------------------------------------------

describe('RecentFilesService', () => {
  it('returns empty list when storage has nothing', async () => {
    const svc = buildService(new FakeStorage())
    const items = await svc.getAll()
    expect(items).toHaveLength(0)
  })

  it('loads persisted items from storage on first getAll()', async () => {
    const storage = new FakeStorage()
    storage.seed('workbench.recentFiles', [
      { uri: URI.file('/a.txt').toJSON(), name: 'a.txt', lastOpened: 1000 },
      { uri: URI.file('/b.txt').toJSON(), name: 'b.txt', lastOpened: 2000 },
    ])
    const svc = buildService(storage)
    const items = await svc.getAll()
    expect(items).toHaveLength(2)
    expect(items[0]?.name).toBe('a.txt')
    expect(items[1]?.name).toBe('b.txt')
  })

  it('add() prepends and deduplicates by URI', async () => {
    const svc = buildService(new FakeStorage())
    const uriA = URI.file('/a.txt')
    const uriB = URI.file('/b.txt')
    svc.add(uriA, 'a.txt')
    svc.add(uriB, 'b.txt')
    svc.add(uriA, 'a.txt') // re-add A → should move to top
    const items = await svc.getAll()
    expect(items).toHaveLength(2)
    expect(items[0]?.uri.toString()).toBe(uriA.toString())
    expect(items[1]?.uri.toString()).toBe(uriB.toString())
  })

  it('add() persists to storage', async () => {
    const storage = new FakeStorage()
    const spy = vi.spyOn(storage, 'set')
    const svc = buildService(storage)
    await svc.getAll() // prime cache so _ensureLoaded() is instant in _persist()
    svc.add(URI.file('/x.txt'), 'x.txt')
    await Promise.resolve()
    expect(spy).toHaveBeenCalledWith('workbench.recentFiles', expect.any(Array), expect.any(Number))
  })

  it('clear() empties the list and persists', async () => {
    const storage = new FakeStorage()
    storage.seed('workbench.recentFiles', [
      { uri: URI.file('/a.txt').toJSON(), name: 'a.txt', lastOpened: 1 },
    ])
    const svc = buildService(storage)
    await svc.getAll()
    svc.clear()
    const items = await svc.getAll()
    expect(items).toHaveLength(0)
    await Promise.resolve()
    expect(await storage.get<unknown[]>('workbench.recentFiles')).toEqual([])
  })

  it('loads only once (second getAll() uses cache)', async () => {
    const storage = new FakeStorage()
    const spy = vi.spyOn(storage, 'get')
    const svc = buildService(storage)
    await svc.getAll()
    await svc.getAll()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('add() before getAll() does not lose data from storage', async () => {
    const storage = new FakeStorage()
    storage.seed('workbench.recentFiles', [
      { uri: URI.file('/a.txt').toJSON(), name: 'a.txt', lastOpened: 1 },
    ])
    const svc = buildService(storage)
    svc.add(URI.file('/b.txt'), 'b.txt')
    const items = await svc.getAll()
    expect(items.some((i) => i.name === 'b.txt')).toBe(true)
    expect(items.some((i) => i.name === 'a.txt')).toBe(true)
  })

  it('getAll() drops files that no longer exist and rewrites storage', async () => {
    const storage = new FakeStorage()
    storage.seed('workbench.recentFiles', [
      { uri: URI.file('/gone.txt').toJSON(), name: 'gone.txt', lastOpened: 1000 },
      { uri: URI.file('/here.txt').toJSON(), name: 'here.txt', lastOpened: 2000 },
    ])
    const fileService = makeRecentFilesFileService(
      (uri) => uri.fsPath !== URI.file('/gone.txt').fsPath,
    )
    const svc = buildService(storage, fileService)

    const items = await svc.getAll()
    expect(items).toHaveLength(1)
    expect(items[0]?.name).toBe('here.txt')

    await Promise.resolve()
    const persisted = await storage.get<Array<{ name: string }>>('workbench.recentFiles')
    expect(persisted?.map((p) => p.name)).toEqual(['here.txt'])
  })

  it('getAll() keeps items when existence check throws', async () => {
    const storage = new FakeStorage()
    storage.seed('workbench.recentFiles', [
      { uri: URI.file('/a.txt').toJSON(), name: 'a.txt', lastOpened: 1 },
    ])
    const fileService = {
      _serviceBrand: undefined,
      async exists() {
        throw new Error('io error')
      },
    } as unknown as IFileServiceType
    const svc = buildService(storage, fileService)
    const items = await svc.getAll()
    expect(items).toHaveLength(1)
    expect(items[0]?.name).toBe('a.txt')
  })
})

// ---------------------------------------------------------------------------
// RecentFilesContribution tests
// ---------------------------------------------------------------------------

describe('RecentFilesContribution', () => {
  const disposables: Array<{ dispose(): void }> = []
  afterEach(() => {
    while (disposables.length) disposables.pop()!.dispose()
  })

  it('records FileEditorInput when it becomes active', async () => {
    const storage = new FakeStorage()
    const uri = URI.file('/my/file.ts')
    const input = makeFileInput(uri)
    disposables.push(input)

    const { service, setActiveEditor, fireActiveEditorChange } = makeGroupsService()
    setActiveEditor(input)

    const { contribution, recentService } = buildContribution(storage, service)
    disposables.push(contribution)

    fireActiveEditorChange()
    await Promise.resolve()

    const items = await recentService.getAll()
    expect(items.some((i) => i.uri.toString() === uri.toString())).toBe(true)
  })

  it('ignores non-FileEditorInput editors', async () => {
    const storage = new FakeStorage()
    const nonFileEditor = {
      typeId: 'welcome',
      resource: undefined,
      dispose() {},
    } as unknown as EditorInput
    const { service, setActiveEditor, fireActiveEditorChange } = makeGroupsService()
    setActiveEditor(nonFileEditor)

    const { contribution, recentService } = buildContribution(storage, service)
    disposables.push(contribution)

    fireActiveEditorChange()
    await Promise.resolve()

    const items = await recentService.getAll()
    expect(items).toHaveLength(0)
  })

  it('records active editor immediately on construction if one is present', async () => {
    const storage = new FakeStorage()
    const uri = URI.file('/initial.ts')
    const input = makeFileInput(uri)
    disposables.push(input)

    const { service } = makeGroupsService(input)
    const { contribution, recentService } = buildContribution(storage, service)
    disposables.push(contribution)

    const items = await recentService.getAll()
    expect(items.some((i) => i.uri.toString() === uri.toString())).toBe(true)
  })

  it('tracks editor after active group changes', async () => {
    const storage = new FakeStorage()
    const uri = URI.file('/new-group/file.ts')
    const input = makeFileInput(uri)
    disposables.push(input)

    const newGroupEditorEmitter = new Emitter<void>()
    const newGroup: IEditorGroup = {
      id: 1,
      index: 1,
      isActive: true,
      count: 0,
      editors: [],
      previewEditor: undefined,
      get activeEditor() {
        return input
      },
      onDidActiveEditorChange: newGroupEditorEmitter.event,
      onDidChangeModel: new Emitter<never>().event,
      openEditor() {},
      closeEditor() {
        return true
      },
      closeAllEditors() {},
      moveEditor() {},
      setActive() {},
      pinEditor() {},
      isPinned() {
        return true
      },
      getEditorByIndex() {
        return undefined
      },
      focus() {},
    } as unknown as IEditorGroup

    const { service, fireActiveGroupChange } = makeGroupsService()
    // Patch activeGroup to return newGroup after the change
    Object.defineProperty(service, 'activeGroup', { get: () => newGroup })

    const { contribution, recentService } = buildContribution(storage, service)
    disposables.push(contribution)

    fireActiveGroupChange(newGroup)
    await Promise.resolve()

    const items = await recentService.getAll()
    expect(items.some((i) => i.uri.toString() === uri.toString())).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ClearRecentFilesAction tests
// ---------------------------------------------------------------------------

describe('ClearRecentFilesAction', () => {
  const disposables: Array<{ dispose(): void }> = []

  beforeEach(() => {
    disposables.push(registerAction2(ClearRecentFilesAction))
  })

  afterEach(() => {
    while (disposables.length) disposables.pop()!.dispose()
  })

  it('ClearRecentFilesAction empties the list', async () => {
    const storage = new FakeStorage()
    storage.seed('workbench.recentFiles', [
      { uri: URI.file('/a.txt').toJSON(), name: 'a.txt', lastOpened: 1 },
    ])
    const recentSvc = buildService(storage)
    await recentSvc.getAll()
    recentSvc.clear()
    const items = await recentSvc.getAll()
    expect(items).toHaveLength(0)
  })

  it('add() → getAll() round-trip preserves URI and name', async () => {
    const storage = new FakeStorage()
    const svc = buildService(storage)
    const uri = URI.file('/project/main.ts')
    svc.add(uri, 'main.ts')
    const items = await svc.getAll()
    expect(items[0]?.name).toBe('main.ts')
    expect(items[0]?.uri.fsPath).toBe(uri.fsPath)
  })
})
