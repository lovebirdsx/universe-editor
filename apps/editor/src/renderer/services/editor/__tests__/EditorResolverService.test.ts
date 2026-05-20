/*---------------------------------------------------------------------------------------------
 *  Tests for EditorResolverService
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  EditorInput,
  IEditorService,
  IFileService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IEditorService as IEditorServiceType,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import { EditorResolverService } from '../EditorResolverService.js'
import { FileEditorInput } from '../FileEditorInput.js'

function makeEditorService(): IEditorServiceType {
  return {
    _serviceBrand: undefined,
    openEditor: vi.fn(),
    closeEditor: vi.fn(),
    closeAllEditors: vi.fn(),
    openEditors: { read: () => [] } as unknown as IEditorServiceType['openEditors'],
    activeEditorId: { read: () => undefined } as unknown as IEditorServiceType['activeEditorId'],
    activeEditor: { read: () => undefined } as unknown as IEditorServiceType['activeEditor'],
  }
}

function makeFs(): IFileServiceType {
  return {
    _serviceBrand: undefined,
    async readFile() {
      return new Uint8Array()
    },
    async readFileText() {
      return ''
    },
    async writeFile() {},
    async exists() {
      return true
    },
    async stat() {
      return { mtime: 1 } as Awaited<ReturnType<IFileServiceType['stat']>>
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
  } as unknown as IFileServiceType
}

function makeEnv() {
  const editorService = makeEditorService()
  const services = new ServiceCollection()
  services.set(IEditorService, editorService)
  services.set(IFileService, makeFs())
  const inst = new InstantiationService(services)
  const resolver = inst.createInstance(EditorResolverService)
  return { resolver, editorService, inst }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('EditorResolverService', () => {
  it('register + resolve: resolveEditors returns the registration for a matching URI', () => {
    const { resolver } = makeEnv()
    const uri = URI.file('/project/src/app.ts')
    const factory = () => ({}) as unknown as EditorInput

    resolver.registerEditor('**/*.ts', { typeId: 'myEditor', displayName: 'My Editor' }, factory)

    const results = resolver.resolveEditors(uri)
    expect(results).toHaveLength(1)
    expect(results[0]?.info.typeId).toBe('myEditor')
    expect(results[0]?.factory).toBe(factory)
  })

  it('glob matching: **/*.ts matches .ts files but not .json files', () => {
    const { resolver } = makeEnv()
    const tsUri = URI.file('/project/src/index.ts')
    const jsonUri = URI.file('/project/src/package.json')
    const factory = () => ({}) as unknown as EditorInput

    resolver.registerEditor('**/*.ts', { typeId: 'tsEditor', displayName: 'TS Editor' }, factory)

    expect(resolver.resolveEditors(tsUri)).toHaveLength(1)
    expect(resolver.resolveEditors(jsonUri)).toHaveLength(0)
  })

  it('priority sorting: higher priority registration appears first in resolveEditors', () => {
    const { resolver } = makeEnv()
    const uri = URI.file('/project/src/app.ts')

    resolver.registerEditor(
      '**/*.ts',
      { typeId: 'low', displayName: 'Low', priority: 1 },
      () => ({}) as unknown as EditorInput,
    )
    resolver.registerEditor(
      '**/*.ts',
      { typeId: 'high', displayName: 'High', priority: 100 },
      () => ({}) as unknown as EditorInput,
    )

    const results = resolver.resolveEditors(uri)
    expect(results[0]?.info.typeId).toBe('high')
    expect(results[1]?.info.typeId).toBe('low')
  })

  it('factory called with correct URI on openEditor', async () => {
    const { resolver, editorService } = makeEnv()
    const uri = URI.file('/project/src/diagram.tree')
    const fakeInput = { typeId: 'tree', resource: uri } as unknown as EditorInput
    const factory = vi.fn(() => fakeInput)

    resolver.registerEditor('**/*.tree', { typeId: 'tree', displayName: 'Tree' }, factory)
    await resolver.openEditor(uri)

    expect(factory).toHaveBeenCalledOnce()
    expect(factory).toHaveBeenCalledWith(uri)
    expect(editorService.openEditor).toHaveBeenCalledWith(fakeInput, { pinned: true })
  })

  it('no match: falls back to FileEditorInput when no registration matches', async () => {
    const { resolver, editorService } = makeEnv()
    const uri = URI.file('/project/src/image.png')

    // No registration for .png
    await resolver.openEditor(uri)

    expect(editorService.openEditor).toHaveBeenCalledOnce()
    const [input] = (editorService.openEditor as ReturnType<typeof vi.fn>).mock.calls[0] as [
      EditorInput,
    ]
    expect(input).toBeInstanceOf(FileEditorInput)
  })

  it('duplicate registration: same (typeId, glob) is skipped with a warning', () => {
    const { resolver } = makeEnv()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const factory = () => ({}) as unknown as EditorInput

    const d1 = resolver.registerEditor('**/*.ts', { typeId: 'dup', displayName: 'Dup' }, factory)
    const d2 = resolver.registerEditor('**/*.ts', { typeId: 'dup', displayName: 'Dup' }, factory)

    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0]?.[0]).toContain('duplicate registration')

    // Only one registration actually exists
    const uri = URI.file('/a.ts')
    expect(resolver.resolveEditors(uri)).toHaveLength(1)

    d1.dispose()
    d2.dispose() // no-op disposable — should not throw
  })

  it('disposable removal: disposed registration no longer appears in resolveEditors', () => {
    const { resolver } = makeEnv()
    const uri = URI.file('/project/src/main.ts')
    const factory = () => ({}) as unknown as EditorInput

    const disposable = resolver.registerEditor(
      '**/*.ts',
      { typeId: 'temp', displayName: 'Temp' },
      factory,
    )

    expect(resolver.resolveEditors(uri)).toHaveLength(1)
    disposable.dispose()
    expect(resolver.resolveEditors(uri)).toHaveLength(0)
  })

  it('preferredTypeId: openEditor selects the factory matching the preferred typeId', async () => {
    const { resolver, editorService } = makeEnv()
    const uri = URI.file('/project/src/chart.ts')
    const chartInput = { typeId: 'chart', resource: uri } as unknown as EditorInput
    const fileInput = { typeId: 'file', resource: uri } as unknown as EditorInput

    resolver.registerEditor(
      '**/*.ts',
      { typeId: 'file', displayName: 'File Editor', priority: 1 },
      () => fileInput,
    )
    resolver.registerEditor(
      '**/*.ts',
      { typeId: 'chart', displayName: 'Chart Editor', priority: 100 },
      () => chartInput,
    )

    // Without preference: highest priority wins (chart)
    await resolver.openEditor(uri)
    expect(editorService.openEditor).toHaveBeenLastCalledWith(chartInput, { pinned: true })

    // With preferredTypeId: use 'file' even though 'chart' has higher priority
    await resolver.openEditor(uri, { preferredTypeId: 'file' })
    expect(editorService.openEditor).toHaveBeenLastCalledWith(fileInput, { pinned: true })
  })
})
