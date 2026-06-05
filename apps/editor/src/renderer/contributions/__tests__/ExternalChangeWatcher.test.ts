/*---------------------------------------------------------------------------------------------
 *  Tests for ExternalChangeWatcher contribution — verifies that watcher events
 *  reach matching FileEditorInputs and that mismatches / non-file inputs are
 *  ignored.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  Emitter,
  type EditorInput,
  type IDialogService,
  type IEditorGroup,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IFileChangeEvent,
  type IFileService as IFileServiceType,
  type IFileWatcherService as IFileWatcherServiceType,
  type ILoggerService as ILoggerServiceType,
  LogLevel,
  NullLogger,
  URI,
  type UriComponents,
} from '@universe-editor/platform'
import { ExternalChangeWatcher } from '../ExternalChangeWatcher.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { UntitledEditorInput } from '../../services/editor/UntitledEditorInput.js'

class FakeWatcher implements IFileWatcherServiceType {
  declare readonly _serviceBrand: undefined
  private readonly _emitter = new Emitter<readonly IFileChangeEvent[]>()
  readonly onDidChangeFiles = this._emitter.event
  async watch(_folder: UriComponents): Promise<void> {}
  async setExcludes(): Promise<void> {}
  async unwatch(): Promise<void> {}
  fire(events: readonly IFileChangeEvent[]): void {
    this._emitter.fire(events)
  }
}

function makeGroups(editors: EditorInput[]): IEditorGroupsServiceType & {
  closed: EditorInput[]
  group: IEditorGroup
} {
  const closed: EditorInput[] = []
  const group = {
    editors,
    closeEditor(editor: EditorInput) {
      closed.push(editor)
      const index = editors.indexOf(editor)
      if (index >= 0) editors.splice(index, 1)
      return true
    },
  } as unknown as IEditorGroup
  return { groups: [group], closed, group } as unknown as IEditorGroupsServiceType & {
    closed: EditorInput[]
    group: IEditorGroup
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
  ;(fake as { checkExternalChange: (d: IDialogService) => Promise<string> }).checkExternalChange =
    async () => {
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
    new ExternalChangeWatcher(watcher, groups, makeDialog(), makeFileService(), makeLoggerService())

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
    new ExternalChangeWatcher(watcher, groups, makeDialog(), makeFileService(), makeLoggerService())

    watcher.fire([{ type: 'modified', resource: URI.file('/ws/other.txt').toJSON() }])
    await flush()
    expect(fileInput.checks).toHaveLength(0)
  })

  it('closes matching FileEditorInputs when a file is deleted', async () => {
    const uri = URI.file('/ws/a.txt')
    const fileInput = makeFileInput(uri) as FileEditorInput & { checks: number[] }
    const groups = makeGroups([fileInput])
    const watcher = new FakeWatcher()
    new ExternalChangeWatcher(watcher, groups, makeDialog(), makeFileService(), makeLoggerService())

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
    new ExternalChangeWatcher(watcher, groups, makeDialog(), makeFileService(), makeLoggerService())

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
    )

    watcher.fire([{ type: 'modified', resource: uri.toJSON() }])
    await flush()
    // Discard reverts working tree to HEAD → modified side now equals original.
    expect(diff.modifiedContent).toBe('head')
    expect(diff.originalContent).toBe('head')
  })
})
