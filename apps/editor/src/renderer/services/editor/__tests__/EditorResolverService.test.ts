/*---------------------------------------------------------------------------------------------
 *  Tests for EditorResolverService
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  EditorInput,
  Event,
  IEditorGroupsService,
  IEditorService,
  IFileService,
  ILoggerService,
  InstantiationService,
  LogLevel,
  ServiceCollection,
  URI,
  type EditorInput as EditorInputType,
  type IEditorGroup,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IEditorService as IEditorServiceType,
  type IFileService as IFileServiceType,
  type ILogger,
  type IOpenEditorOptions,
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

/**
 * A minimal single-group stand-in for IEditorGroupsService that supports the
 * open / close / index / active bookkeeping `_upgradeOpenEditors` relies on.
 */
function makeGroups(): {
  groupsService: IEditorGroupsServiceType
  group: {
    editors: EditorInputType[]
    activeEditor: EditorInputType | undefined
    openCalls: Array<{ input: EditorInputType; options?: IOpenEditorOptions }>
  }
} {
  const editors: EditorInputType[] = []
  const openCalls: Array<{ input: EditorInputType; options?: IOpenEditorOptions }> = []
  const group = {
    editors,
    activeEditor: undefined as EditorInputType | undefined,
    openCalls,
    indexOf: (e: EditorInputType) => editors.indexOf(e),
    closeEditor: (e: EditorInputType) => {
      const i = editors.indexOf(e)
      if (i !== -1) editors.splice(i, 1)
      if (group.activeEditor === e) group.activeEditor = undefined
      return i !== -1
    },
    openEditor: (input: EditorInputType, options?: IOpenEditorOptions) => {
      openCalls.push(options ? { input, options } : { input })
      const at = options?.index ?? editors.length
      editors.splice(at, 0, input)
      if (options?.activate !== false) group.activeEditor = input
    },
  }
  const groupsService = {
    _serviceBrand: undefined,
    groups: [group as unknown as IEditorGroup],
  } as unknown as IEditorGroupsServiceType
  return { groupsService, group }
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

function makeEnv() {
  const editorService = makeEditorService()
  const logger = makeLogger()
  const { groupsService, group } = makeGroups()
  const services = new ServiceCollection()
  services.set(IEditorService, editorService)
  services.set(IEditorGroupsService, groupsService)
  services.set(IFileService, makeFs())
  services.set(ILoggerService, {
    _serviceBrand: undefined,
    createLogger: () => logger,
    setLevel: () => {},
    getLevel: () => LogLevel.Info,
  })
  const inst = new InstantiationService(services)
  const resolver = inst.createInstance(EditorResolverService)
  return { resolver, editorService, group, inst, logger }
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
    const { resolver, logger } = makeEnv()
    const factory = () => ({}) as unknown as EditorInput

    const d1 = resolver.registerEditor('**/*.ts', { typeId: 'dup', displayName: 'Dup' }, factory)
    const d2 = resolver.registerEditor('**/*.ts', { typeId: 'dup', displayName: 'Dup' }, factory)

    expect(logger.warn).toHaveBeenCalledOnce()
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain(
      'duplicate registration',
    )

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

  it('self-heal: a later higher-priority registration upgrades an open fallback tab in place', () => {
    const { resolver, group } = makeEnv()
    const uri = URI.file('/project/doc.pdf')

    // Catch-all fallback opens the pdf as a text file (the race the bug hits).
    resolver.registerEditor(
      '**/*',
      { typeId: 'file', displayName: 'File Editor', priority: 1 },
      (u) => ({ typeId: 'file', resource: u }) as unknown as EditorInput,
    )
    const fileTab = { typeId: 'file', resource: uri } as unknown as EditorInput
    group.editors.push(fileTab)
    group.activeEditor = fileTab

    // The PDF custom editor registers late (after the extension host is ready).
    const pdfInput = { typeId: 'customEditor', resource: uri } as unknown as EditorInput
    resolver.registerEditor(
      '**/*.pdf',
      { typeId: 'customEditor', displayName: 'PDF View', priority: 100 },
      () => pdfInput,
    )

    // The open fallback tab was re-opened in place as the custom editor.
    expect(group.editors).toEqual([pdfInput])
    expect(group.openCalls.at(-1)?.input).toBe(pdfInput)
    expect(group.openCalls.at(-1)?.options).toMatchObject({ index: 0, activate: true })
  })

  it('self-heal respects "Reopen With": an explicitly chosen editor is not upgraded', async () => {
    const { resolver, group } = makeEnv()
    const uri = URI.file('/project/doc.pdf')

    resolver.registerEditor(
      '**/*',
      { typeId: 'file', displayName: 'File Editor', priority: 1 },
      (u) => ({ typeId: 'file', resource: u }) as unknown as EditorInput,
    )
    // User explicitly reopened the pdf as text via "Reopen With...".
    const fileInput = { typeId: 'file', resource: uri } as unknown as EditorInput
    resolver.registerEditor(
      '**/*.pdf',
      { typeId: 'file', displayName: 'File Editor', priority: 1 },
      () => fileInput,
    )
    await resolver.openEditor(uri, { preferredTypeId: 'file' })
    group.editors.length = 0
    group.editors.push(fileInput)
    group.activeEditor = fileInput
    group.openCalls.length = 0

    // A higher-priority PDF editor registers afterwards — must NOT steal the tab.
    resolver.registerEditor(
      '**/*.pdf',
      { typeId: 'customEditor', displayName: 'PDF View', priority: 100 },
      () => ({ typeId: 'customEditor', resource: uri }) as unknown as EditorInput,
    )

    expect(group.editors).toEqual([fileInput])
    expect(group.openCalls).toHaveLength(0)
  })

  it('self-heal does not touch a tab already at equal/higher priority', () => {
    const { resolver, group } = makeEnv()
    const uri = URI.file('/project/doc.pdf')

    // The pdf is already open in the custom editor (priority 100).
    resolver.registerEditor(
      '**/*.pdf',
      { typeId: 'customEditor', displayName: 'PDF View', priority: 100 },
      () => ({ typeId: 'customEditor', resource: uri }) as unknown as EditorInput,
    )
    const pdfTab = { typeId: 'customEditor', resource: uri } as unknown as EditorInput
    group.editors.push(pdfTab)
    group.activeEditor = pdfTab
    group.openCalls.length = 0

    // A lower-priority catch-all registers later — must not replace the tab.
    resolver.registerEditor(
      '**/*',
      { typeId: 'file', displayName: 'File Editor', priority: 1 },
      () => ({ typeId: 'file', resource: uri }) as unknown as EditorInput,
    )

    expect(group.editors).toEqual([pdfTab])
    expect(group.openCalls).toHaveLength(0)
  })

  it('self-heal ignores transient inputs not produced by the resolver (webview diff)', () => {
    const { resolver, group } = makeEnv()
    const uri = URI.file('/virtual/right.uediff')

    // A webview diff tab is open. Its resource is the right-hand URI (matches the
    // custom-editor glob) but its typeId is NOT resolver-registered — it carries
    // in-memory diff bytes and must survive a late custom-editor registration.
    const diffTab = { typeId: 'webviewDiff', resource: uri } as unknown as EditorInput
    group.editors.push(diffTab)
    group.activeEditor = diffTab
    group.openCalls.length = 0

    // The diff-capable custom editor registers late (extension host ready).
    resolver.registerEditor(
      '**/*.uediff',
      { typeId: 'customEditor', displayName: 'E2E Diff', priority: 100 },
      () => ({ typeId: 'customEditor', resource: uri }) as unknown as EditorInput,
    )

    expect(group.editors).toEqual([diffTab])
    expect(group.openCalls).toHaveLength(0)
  })
})
