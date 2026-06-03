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
  type IFileWatcherService as IFileWatcherServiceType,
  type ILoggerService as ILoggerServiceType,
  LogLevel,
  NullLogger,
  URI,
  type UriComponents,
} from '@universe-editor/platform'
import { ExternalChangeWatcher } from '../ExternalChangeWatcher.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
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
    new ExternalChangeWatcher(watcher, groups, makeDialog(), makeLoggerService())

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
    new ExternalChangeWatcher(watcher, groups, makeDialog(), makeLoggerService())

    watcher.fire([{ type: 'modified', resource: URI.file('/ws/other.txt').toJSON() }])
    await flush()
    expect(fileInput.checks).toHaveLength(0)
  })

  it('closes matching FileEditorInputs when a file is deleted', async () => {
    const uri = URI.file('/ws/a.txt')
    const fileInput = makeFileInput(uri) as FileEditorInput & { checks: number[] }
    const groups = makeGroups([fileInput])
    const watcher = new FakeWatcher()
    new ExternalChangeWatcher(watcher, groups, makeDialog(), makeLoggerService())

    watcher.fire([{ type: 'deleted', resource: uri.toJSON() }])
    await flush()
    expect(groups.closed).toEqual([fileInput])
    expect(fileInput.checks).toHaveLength(0)
  })

  it('closes descendant file tabs when a directory is deleted', async () => {
    const inside = URI.file('/ws/folder/a.txt')
    const outside = URI.file('/ws/other.txt')
    const inputInside = makeFileInput(inside) as FileEditorInput & { checks: number[] }
    const inputOutside = makeFileInput(outside) as FileEditorInput & { checks: number[] }
    const groups = makeGroups([inputInside, inputOutside])
    const watcher = new FakeWatcher()
    new ExternalChangeWatcher(watcher, groups, makeDialog(), makeLoggerService())

    watcher.fire([{ type: 'deleted', resource: URI.file('/ws/folder').toJSON() }])
    await flush()
    expect(groups.closed).toEqual([inputInside])
    expect(groups.group.editors).toEqual([inputOutside])
  })
})
