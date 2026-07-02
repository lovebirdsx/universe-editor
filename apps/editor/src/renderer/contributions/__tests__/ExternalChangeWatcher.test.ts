/*---------------------------------------------------------------------------------------------
 *  Tests for ExternalChangeWatcher contribution — verifies that watcher events
 *  reach matching FileEditorInputs and that mismatches / non-file inputs are
 *  ignored.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  type EditorInput,
  type IDialogService,
  type IEditorGroup,
  type IEditorGroupModelChangeEvent,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IFileChangeEvent,
  type IFileService as IFileServiceType,
  type IFileWatcherService as IFileWatcherServiceType,
  type ILoggerService as ILoggerServiceType,
  type IUserDataFileChange,
  type IUserDataFilesService,
  LogLevel,
  NullLogger,
  URI,
  type UriComponents,
  type UserDataFile,
} from '@universe-editor/platform'

// Stub the model registry so a test can inject a live editor buffer for a URI.
// Default: no live model (peek → undefined), so diff refresh reads disk as before.
const liveModels = new Map<string, { getValue: () => string; isDisposed: () => boolean }>()
vi.mock('../../workbench/editor/monaco/MonacoModelRegistry.js', () => ({
  MonacoModelRegistry: {
    peek: (uri: { toString: () => string }) => liveModels.get(uri.toString()),
  },
}))

import { ExternalChangeWatcher } from '../ExternalChangeWatcher.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { UntitledEditorInput } from '../../services/editor/UntitledEditorInput.js'

class FakeWatcher implements IFileWatcherServiceType {
  declare readonly _serviceBrand: undefined
  private readonly _emitter = new Emitter<readonly IFileChangeEvent[]>()
  readonly onDidChangeFiles = this._emitter.event
  readonly outOfWorkspaceCalls: UriComponents[][] = []
  async watch(_folder: UriComponents): Promise<void> {}
  async setExcludes(): Promise<void> {}
  async unwatch(): Promise<void> {}
  async watchOutOfWorkspace(uris: readonly UriComponents[]): Promise<void> {
    this.outOfWorkspaceCalls.push([...uris])
  }
  fire(events: readonly IFileChangeEvent[]): void {
    this._emitter.fire(events)
  }
}

/**
 * Fake user-data service. `uris` maps a UserDataFile to its backing URI so the
 * watcher can resolve change events to an open editor's resource.
 */
class FakeUserData implements IUserDataFilesService {
  declare readonly _serviceBrand: undefined
  private readonly _emitter = new Emitter<IUserDataFileChange>()
  readonly onDidChangeFile = this._emitter.event
  private readonly _uris = new Map<UserDataFile, URI>()
  constructor(uris?: Iterable<[UserDataFile, URI]>) {
    for (const [f, u] of uris ?? []) this._uris.set(f, u)
  }
  async read(): Promise<string> {
    return ''
  }
  async write(): Promise<void> {}
  async setValue(): Promise<boolean> {
    return true
  }
  async getFileUri(file: UserDataFile): Promise<UriComponents | null> {
    return this._uris.get(file)?.toJSON() ?? null
  }
  fire(file: UserDataFile, source: 'self' | 'external' = 'external'): void {
    this._emitter.fire({ file, source })
  }
}

function makeGroups(editors: EditorInput[]): IEditorGroupsServiceType & {
  closed: EditorInput[]
  group: IEditorGroup
  openEditor(editor: EditorInput): void
  closeEditorInGroup(editor: EditorInput): void
} {
  const closed: EditorInput[] = []
  const modelEmitter = new Emitter<IEditorGroupModelChangeEvent>()
  const addGroupEmitter = new Emitter<IEditorGroup>()
  const removeGroupEmitter = new Emitter<IEditorGroup>()
  const group = {
    id: 1,
    editors,
    onDidChangeModel: modelEmitter.event,
    closeEditor(editor: EditorInput) {
      closed.push(editor)
      const index = editors.indexOf(editor)
      if (index >= 0) editors.splice(index, 1)
      return true
    },
  } as unknown as IEditorGroup
  return {
    groups: [group],
    closed,
    group,
    onDidAddGroup: addGroupEmitter.event,
    onDidRemoveGroup: removeGroupEmitter.event,
    openEditor(editor: EditorInput) {
      editors.push(editor)
      modelEmitter.fire({ kind: 'open', editor })
    },
    closeEditorInGroup(editor: EditorInput) {
      const index = editors.indexOf(editor)
      if (index >= 0) editors.splice(index, 1)
      modelEmitter.fire({ kind: 'close', editor })
    },
  } as unknown as IEditorGroupsServiceType & {
    closed: EditorInput[]
    group: IEditorGroup
    openEditor(editor: EditorInput): void
    closeEditorInGroup(editor: EditorInput): void
  }
}

function makeDialog(): IDialogService {
  return {
    _serviceBrand: undefined,
    async confirm() {
      return { confirmed: false }
    },
    async prompt() {
      return null
    },
    async showMessageBox() {
      return { response: 0 }
    },
  } as unknown as IDialogService
}

function makeLoggerService(): ILoggerServiceType {
  return {
    _serviceBrand: undefined,
    createLogger: () => new NullLogger(),
    setLevel: () => {},
    getLevel: () => LogLevel.Info,
  }
}

/**
 * Fake file service. `existing` lists URIs whose `stat` succeeds (file present);
 * any other path throws (file gone). `contents` backs `readFileText`.
 */
function makeFileService(opts?: {
  existing?: Iterable<URI>
  contents?: Iterable<[URI, string]>
}): IFileServiceType {
  const existing = new Set<string>()
  for (const u of opts?.existing ?? []) existing.add(u.toString())
  const contents = new Map<string, string>()
  for (const [u, text] of opts?.contents ?? []) contents.set(u.toString(), text)
  return {
    _serviceBrand: undefined,
    async stat(resource: URI) {
      if (!existing.has(resource.toString())) throw new Error('ENOENT')
      return { resource, isFile: true, isDirectory: false, size: 0, mtime: 1 }
    },
    async readFileText(resource: URI) {
      return contents.get(resource.toString()) ?? ''
    },
  } as unknown as IFileServiceType
}

function makeFileInput(uri: URI): FileEditorInput {
  const checks: number[] = []
  const fake = Object.create(FileEditorInput.prototype) as FileEditorInput & {
    checks: number[]
  }
  Object.defineProperty(fake, 'resource', { get: () => uri })
  Object.defineProperty(fake, 'typeId', { get: () => 'file' })
  fake.checks = checks
  ;(
    fake as { checkExternalChange: (d: IDialogService, force?: boolean) => Promise<string> }
  ).checkExternalChange = async () => {
    checks.push(Date.now())
    return 'unchanged'
  }
  return fake
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('ExternalChangeWatcher', () => {
  it('invokes checkExternalChange on matching FileEditorInputs only', async () => {
    const uriA = URI.file('/ws/a.txt')
    const uriB = URI.file('/ws/b.txt')
    const inputA = makeFileInput(uriA) as FileEditorInput & { checks: number[] }
    const inputB = makeFileInput(uriB) as FileEditorInput & { checks: number[] }
    const groups = makeGroups([inputA, inputB])
    const watcher = new FakeWatcher()
    new ExternalChangeWatcher(
      watcher,
      groups,
      makeDialog(),
      makeFileService(),
      makeLoggerService(),
      new FakeUserData(),
    )

    watcher.fire([{ type: 'modified', resource: uriA.toJSON() }])
    await flush()
    expect(inputA.checks).toHaveLength(1)
    expect(inputB.checks).toHaveLength(0)
  })

  it('ignores untitled inputs and unrelated URIs', async () => {
    const uriFile = URI.file('/ws/file.txt')
    const fileInput = makeFileInput(uriFile) as FileEditorInput & { checks: number[] }
    const untitled = new UntitledEditorInput()
    const groups = makeGroups([fileInput, untitled])
    const watcher = new FakeWatcher()
    new ExternalChangeWatcher(
      watcher,
      groups,
      makeDialog(),
      makeFileService(),
      makeLoggerService(),
      new FakeUserData(),
    )

    watcher.fire([{ type: 'modified', resource: URI.file('/ws/other.txt').toJSON() }])
    await flush()
    expect(fileInput.checks).toHaveLength(0)
  })

  it('closes matching FileEditorInputs when a file is deleted', async () => {
    const uri = URI.file('/ws/a.txt')
    const fileInput = makeFileInput(uri) as FileEditorInput & { checks: number[] }
    const groups = makeGroups([fileInput])
    const watcher = new FakeWatcher()
    new ExternalChangeWatcher(
      watcher,
      groups,
      makeDialog(),
      makeFileService(),
      makeLoggerService(),
      new FakeUserData(),
    )

    watcher.fire([{ type: 'deleted', resource: uri.toJSON() }])
    await flush()
    expect(groups.closed).toEqual([fileInput])
    expect(fileInput.checks).toHaveLength(0)
  })

  it('reloads instead of closing when a "deleted" event hits a file still on disk', async () => {
    // `git checkout` rewrites the file, which the watcher may report as deleted.
    const uri = URI.file('/ws/a.txt')
    const fileInput = makeFileInput(uri) as FileEditorInput & { checks: number[] }
    const groups = makeGroups([fileInput])
    const watcher = new FakeWatcher()
    new ExternalChangeWatcher(
      watcher,
      groups,
      makeDialog(),
      makeFileService({ existing: [uri] }),
      makeLoggerService(),
      new FakeUserData(),
    )

    watcher.fire([{ type: 'deleted', resource: uri.toJSON() }])
    await flush()
    expect(groups.closed).toEqual([])
    expect(fileInput.checks).toHaveLength(1)
  })

  it('closes descendant file tabs when a directory is deleted', async () => {
    const inside = URI.file('/ws/folder/a.txt')
    const outside = URI.file('/ws/other.txt')
    const inputInside = makeFileInput(inside) as FileEditorInput & { checks: number[] }
    const inputOutside = makeFileInput(outside) as FileEditorInput & { checks: number[] }
    const groups = makeGroups([inputInside, inputOutside])
    const watcher = new FakeWatcher()
    new ExternalChangeWatcher(
      watcher,
      groups,
      makeDialog(),
      makeFileService(),
      makeLoggerService(),
      new FakeUserData(),
    )

    watcher.fire([{ type: 'deleted', resource: URI.file('/ws/folder').toJSON() }])
    await flush()
    expect(groups.closed).toEqual([inputInside])
    expect(groups.group.editors).toEqual([inputOutside])
  })

  it('refreshes the working-tree side of an open diff editor on change', async () => {
    const uri = URI.file('/ws/a.txt')
    const diff = new DiffEditorInput(uri, 'head', 'old-working')
    const groups = makeGroups([diff])
    const watcher = new FakeWatcher()
    new ExternalChangeWatcher(
      watcher,
      groups,
      makeDialog(),
      makeFileService({ existing: [uri], contents: [[uri, 'head']] }),
      makeLoggerService(),
      new FakeUserData(),
    )

    watcher.fire([{ type: 'modified', resource: uri.toJSON() }])
    await flush()
    // Discard reverts working tree to HEAD → modified side now equals original.
    expect(diff.modifiedContent).toBe('head')
    expect(diff.originalContent).toBe('head')
  })

  it('pushes the live editor buffer (not stale disk) into an open diff', async () => {
    // The file is open with unsaved edits (live model = 'live-edit') AND diffed.
    // A stale/late fs event must not overwrite the diff's modified side from disk
    // — the live buffer, mirrored by DiffLiveContentSyncContribution, is truth.
    const uri = URI.file('/ws/a.txt')
    const diff = new DiffEditorInput(uri, 'head', 'live-edit')
    const groups = makeGroups([diff])
    liveModels.set(uri.toString(), { getValue: () => 'live-edit', isDisposed: () => false })
    const watcher = new FakeWatcher()
    new ExternalChangeWatcher(
      watcher,
      groups,
      makeDialog(),
      makeFileService({ existing: [uri], contents: [[uri, 'disk-stale']] }),
      makeLoggerService(),
      new FakeUserData(),
    )

    watcher.fire([{ type: 'modified', resource: uri.toJSON() }])
    await flush()
    expect(diff.modifiedContent).toBe('live-edit')
    liveModels.delete(uri.toString())
  })

  it('reloads an open editor when its user-data file changes', async () => {
    // aiSettings.json lives outside the workspace, so only the userData service
    // reports its change — the parcel watcher never sees it.
    const aiSettings = 'aiSettings' as UserDataFile
    const uri = URI.file('/config/aiSettings.json')
    const other = URI.file('/config/settings.json')
    const input = makeFileInput(uri) as FileEditorInput & { checks: number[] }
    const otherInput = makeFileInput(other) as FileEditorInput & { checks: number[] }
    const groups = makeGroups([input, otherInput])
    const userData = new FakeUserData([[aiSettings, uri]])
    new ExternalChangeWatcher(
      new FakeWatcher(),
      groups,
      makeDialog(),
      makeFileService({ existing: [uri] }),
      makeLoggerService(),
      userData,
    )

    userData.fire(aiSettings)
    await flush()
    expect(input.checks).toHaveLength(1)
    expect(otherInput.checks).toHaveLength(0)
  })

  it('refreshes on self-writes too (settings written by the app)', async () => {
    const settings = 'settings' as UserDataFile
    const uri = URI.file('/config/settings.json')
    const input = makeFileInput(uri) as FileEditorInput & { checks: number[] }
    const groups = makeGroups([input])
    const userData = new FakeUserData([[settings, uri]])
    new ExternalChangeWatcher(
      new FakeWatcher(),
      groups,
      makeDialog(),
      makeFileService({ existing: [uri] }),
      makeLoggerService(),
      userData,
    )

    userData.fire(settings, 'self')
    await flush()
    expect(input.checks).toHaveLength(1)
  })

  it('initializes watchOutOfWorkspace with URIs of all open FileEditorInputs', async () => {
    const uri = URI.file('/ws/a.txt')
    const input = makeFileInput(uri)
    const groups = makeGroups([input])
    const watcher = new FakeWatcher()
    new ExternalChangeWatcher(
      watcher,
      groups,
      makeDialog(),
      makeFileService(),
      makeLoggerService(),
      new FakeUserData(),
    )

    await flush()
    expect(watcher.outOfWorkspaceCalls.length).toBeGreaterThan(0)
    const lastCall = watcher.outOfWorkspaceCalls.at(-1)!
    const uriStrings = lastCall.map((u) =>
      URI.revive(u as Parameters<typeof URI.revive>[0])?.toString(),
    )
    expect(uriStrings).toContain(uri.toString())
  })

  it('updates watchOutOfWorkspace when an editor is opened', async () => {
    const groups = makeGroups([])
    const watcher = new FakeWatcher()
    new ExternalChangeWatcher(
      watcher,
      groups,
      makeDialog(),
      makeFileService(),
      makeLoggerService(),
      new FakeUserData(),
    )

    const uri = URI.file('/ws/new.txt')
    const input = makeFileInput(uri)
    groups.openEditor(input)
    await flush()

    const lastCall = watcher.outOfWorkspaceCalls.at(-1)!
    const uriStrings = lastCall.map((u) =>
      URI.revive(u as Parameters<typeof URI.revive>[0])?.toString(),
    )
    expect(uriStrings).toContain(uri.toString())
  })

  it('updates watchOutOfWorkspace when an editor is closed', async () => {
    const uri = URI.file('/ws/a.txt')
    const input = makeFileInput(uri)
    const groups = makeGroups([input])
    const watcher = new FakeWatcher()
    new ExternalChangeWatcher(
      watcher,
      groups,
      makeDialog(),
      makeFileService(),
      makeLoggerService(),
      new FakeUserData(),
    )

    groups.closeEditorInGroup(input)
    await flush()

    const lastCall = watcher.outOfWorkspaceCalls.at(-1)!
    const uriStrings = lastCall.map((u) =>
      URI.revive(u as Parameters<typeof URI.revive>[0])?.toString(),
    )
    expect(uriStrings).not.toContain(uri.toString())
  })
})
