/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/editor/FileEditorInput.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IFileService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import { FileEditorInput } from '../FileEditorInput.js'
import { MonacoModelRegistry } from '../../../workbench/editor/monaco/MonacoModelRegistry.js'

function makeFs(initial: Record<string, string> = {}): IFileServiceType & {
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
      if (v === undefined) throw new Error('ENOENT')
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
      throw new Error('not implemented')
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
  } as IFileServiceType & {
    store: Record<string, string>
    writes: Array<{ path: string; content: string }>
  }
}

function makeInstantiation(fs: IFileServiceType): InstantiationService {
  const services = new ServiceCollection()
  services.set(IFileService, fs)
  return new InstantiationService(services)
}

describe('FileEditorInput', () => {
  let fs: ReturnType<typeof makeFs>
  let inst: InstantiationService
  const uri = URI.file('/tmp/example.json')

  beforeEach(() => {
    fs = makeFs({ [uri.toString()]: '{"a":1}' })
    inst = makeInstantiation(fs)
  })

  afterEach(() => {
    MonacoModelRegistry._resetForTests()
  })

  it('typeId is "file" and resource is the constructor URI', () => {
    const input = inst.createInstance(FileEditorInput, uri)
    expect(input.typeId).toBe('file')
    expect(input.resource.toString()).toBe(uri.toString())
    input.dispose()
  })

  it('getName returns basename', () => {
    const input = inst.createInstance(FileEditorInput, uri)
    expect(input.getName()).toBe('example.json')
    input.dispose()
  })

  it('resolve reads from IFileService and captures backupContent', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    const text = await input.resolve()
    expect(text).toBe('{"a":1}')
    expect(input.backupContent).toBe('{"a":1}')
    expect(input.isResolved).toBe(true)
    input.dispose()
  })

  it('serialize emits UriComponents under "resource"', () => {
    const input = inst.createInstance(FileEditorInput, uri)
    const data = input.serialize() as { resource: { scheme: string } }
    expect(data.resource.scheme).toBe('file')
    input.dispose()
  })

  it('deserialize round-trip via accessor yields a new FileEditorInput on the same URI', () => {
    const original = inst.createInstance(FileEditorInput, uri)
    const data = original.serialize()
    const restored = inst.invokeFunction((accessor) => FileEditorInput.deserialize(data, accessor))
    expect(restored).toBeInstanceOf(FileEditorInput)
    expect(restored!.resource.toString()).toBe(uri.toString())
    original.dispose()
    restored?.dispose()
  })

  it('deserialize without an accessor returns null', () => {
    const input = inst.createInstance(FileEditorInput, uri)
    const data = input.serialize()
    expect(FileEditorInput.deserialize(data)).toBeNull()
    input.dispose()
  })

  it('save writes the current model value through IFileService and clears dirty', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    // Mimic the FileEditor by acquiring a model; subsequent edits set dirty.
    const model = MonacoModelRegistry.acquire(input.resource, input.backupContent)
    model.setValue('{"a":2}')
    input.setDirty(true)
    const ok = await input.save()
    expect(ok).toBe(true)
    expect(fs.writes).toEqual([{ path: uri.toString(), content: '{"a":2}' }])
    expect(input.isDirty).toBe(false)
    expect(input.backupContent).toBe('{"a":2}')
    MonacoModelRegistry.release(input.resource)
    input.dispose()
  })

  it('revert restores backupContent into the model and clears dirty', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    const model = MonacoModelRegistry.acquire(input.resource, input.backupContent)
    model.setValue('LOCAL EDITS')
    input.setDirty(true)
    await input.revert()
    expect(model.getValue()).toBe('{"a":1}')
    expect(input.isDirty).toBe(false)
    MonacoModelRegistry.release(input.resource)
    input.dispose()
  })

  it('save with no acquired model resolves true and is a no-op', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    const ok = await input.save()
    expect(ok).toBe(true)
    expect(fs.writes).toEqual([])
    input.dispose()
  })

  // unused import guard — vi is used by test framework hooks elsewhere
  void vi
})
