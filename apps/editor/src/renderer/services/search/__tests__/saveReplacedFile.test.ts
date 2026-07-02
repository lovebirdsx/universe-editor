/*---------------------------------------------------------------------------------------------
 *  Tests for saveReplacedFile.
 *
 *  Covers two bugs in the original inline implementation:
 *    1. Windows URI case mismatch: search results use uppercase drive letter (C:)
 *       while the FileEditorInput was opened with lowercase (c:). Plain
 *       toString() comparison fails; isEqualResource() is required.
 *    2. Non-active editor group: editorService.openEditors only exposes the
 *       active group. A file open in another group would never be saved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  EditorInput,
  IFileService,
  InstantiationService,
  ServiceCollection,
  URI,
  UriIdentityService,
  type IEditorGroupsService,
} from '@universe-editor/platform'
import { FileEditorInput } from '../../editor/FileEditorInput.js'
import { MonacoModelRegistry } from '../../../workbench/editor/monaco/MonacoModelRegistry.js'
import { saveReplacedFile } from '../saveReplacedFile.js'

// The C:/c: drive-letter case in this suite requires the case-insensitive policy.
const uriIdentity = new UriIdentityService('win32')

function makeFs(initial: Record<string, string> = {}): IFileService & {
  store: Record<string, string>
  writes: Array<{ path: string; content: string }>
} {
  const store = { ...initial }
  const writes: Array<{ path: string; content: string }> = []
  return {
    _serviceBrand: undefined,
    store,
    writes,
    async readFile() {
      throw new Error('not implemented')
    },
    async readFileText(resource: URI) {
      const v = store[resource.toString()]
      if (v === undefined) throw new Error('ENOENT: ' + resource.toString())
      return v
    },
    async writeFile(resource: URI, content: Uint8Array | string) {
      const text = typeof content === 'string' ? content : new TextDecoder().decode(content)
      store[resource.toString()] = text
      writes.push({ path: resource.toString(), content: text })
    },
    async exists() {
      return false
    },
    async stat() {
      throw new Error('stat not implemented')
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
    async copy() {},
    async listRecursive() {
      return []
    },
  } as IFileService & {
    store: Record<string, string>
    writes: Array<{ path: string; content: string }>
  }
}

function makeInstantiation(fs: IFileService): InstantiationService {
  const services = new ServiceCollection()
  services.set(IFileService, fs)
  return new InstantiationService(services)
}

function makeGroups(inputs: EditorInput[][]): Pick<IEditorGroupsService, 'groups'> {
  return {
    groups: inputs.map((editors) => ({ editors }) as never),
  } as never
}

describe('saveReplacedFile', () => {
  afterEach(() => {
    MonacoModelRegistry._resetForTests()
  })

  it('saves the file and clears dirty when found in the active group', async () => {
    const uri = URI.file('/tmp/foo.ts')
    const fs = makeFs({ [uri.toString()]: 'hello' })
    const inst = makeInstantiation(fs)
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    const model = MonacoModelRegistry.acquire(uri, 'hello')
    model.setValue('world')
    input.setDirty(true)

    await saveReplacedFile(uri, makeGroups([[input]]) as IEditorGroupsService, uriIdentity)

    expect(fs.writes).toEqual([{ path: uri.toString(), content: 'world' }])
    expect(input.isDirty).toBe(false)

    MonacoModelRegistry.release(uri)
    input.dispose()
  })

  it('bug: Windows URI case mismatch — C: vs c: prevents save with toString() comparison', async () => {
    // Simulate the scenario: FileEditorInput was created with lowercase URI
    // (as Electron/Node returns on Windows), but search result URI uses uppercase
    // drive letter (as the search service returns from the raw path).
    const lowercaseUri = URI.parse('file:///c:/workspace/foo.ts')
    const uppercaseUri = URI.parse('file:///C:/workspace/foo.ts')

    const fs = makeFs({ [lowercaseUri.toString()]: 'hello' })
    const inst = makeInstantiation(fs)
    const input = inst.createInstance(FileEditorInput, lowercaseUri)
    await input.resolve()
    const model = MonacoModelRegistry.acquire(lowercaseUri, 'hello')
    model.setValue('world')
    input.setDirty(true)

    // saveReplacedFile must save even when the caller passes uppercaseUri.
    await saveReplacedFile(uppercaseUri, makeGroups([[input]]) as IEditorGroupsService, uriIdentity)

    expect(input.isDirty).toBe(false)
    expect(fs.writes).toHaveLength(1)

    MonacoModelRegistry.release(lowercaseUri)
    input.dispose()
  })

  it('bug: file in non-active group is invisible to editorService.openEditors', async () => {
    // editorService.openEditors only surfaces the active group.  If the file is
    // in group[1] (not group[0]), the original openEditors.get().find() returns
    // undefined and save() is never called.
    const uri = URI.file('/tmp/bar.ts')
    const fs = makeFs({ [uri.toString()]: 'old' })
    const inst = makeInstantiation(fs)
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    const model = MonacoModelRegistry.acquire(uri, 'old')
    model.setValue('new')
    input.setDirty(true)

    // Group 0 (active) is empty; group 1 holds the file.
    await saveReplacedFile(uri, makeGroups([[], [input]]) as IEditorGroupsService, uriIdentity)

    expect(input.isDirty).toBe(false)
    expect(fs.writes).toHaveLength(1)

    MonacoModelRegistry.release(uri)
    input.dispose()
  })

  it('does nothing when no editor group contains a matching FileEditorInput', async () => {
    const uri = URI.file('/tmp/unknown.ts')
    const otherUri = URI.file('/tmp/other.ts')
    const fs = makeFs({ [otherUri.toString()]: 'content' })
    const inst = makeInstantiation(fs)
    const input = inst.createInstance(FileEditorInput, otherUri)

    // uri does not match otherUri — save must not be called.
    await saveReplacedFile(uri, makeGroups([[input]]) as IEditorGroupsService, uriIdentity)

    expect(fs.writes).toHaveLength(0)

    input.dispose()
  })
})
