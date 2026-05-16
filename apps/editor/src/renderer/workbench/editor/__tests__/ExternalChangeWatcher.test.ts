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
  URI,
  type UriComponents,
} from '@universe-editor/platform'
import { ExternalChangeWatcher } from '../ExternalChangeWatcher.js'
import { FileEditorInput } from '../FileEditorInput.js'
import { UntitledEditorInput } from '../UntitledEditorInput.js'

class FakeWatcher implements IFileWatcherServiceType {
  declare readonly _serviceBrand: undefined
  private readonly _emitter = new Emitter<readonly IFileChangeEvent[]>()
  readonly onDidChangeFiles = this._emitter.event
  async watch(_folder: UriComponents): Promise<void> {}
  async unwatch(): Promise<void> {}
  fire(events: readonly IFileChangeEvent[]): void {
    this._emitter.fire(events)
  }
}

function makeGroups(editors: EditorInput[]): IEditorGroupsServiceType {
  const group = { editors } as unknown as IEditorGroup
  return { groups: [group] } as unknown as IEditorGroupsServiceType
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
    new ExternalChangeWatcher(watcher, groups, makeDialog())

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
    new ExternalChangeWatcher(watcher, groups, makeDialog())

    watcher.fire([{ type: 'modified', resource: URI.file('/ws/other.txt').toJSON() }])
    await flush()
    expect(fileInput.checks).toHaveLength(0)
  })
})
