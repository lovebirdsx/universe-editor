import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  IDialogService,
  IEditorResolverService,
  IEditorService,
  IFileService,
  InstantiationService,
  ServiceCollection,
  URI,
  registerAction2,
} from '@universe-editor/platform'
import {
  CompareSelectedAction,
  CompareWithSelectedAction,
  SelectForCompareAction,
} from '../fileCompareActions.js'
import { IExplorerTreeService } from '../../services/explorer/ExplorerTreeService.js'
import { ICompareService } from '../../services/explorer/CompareService.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { WebviewDiffInput } from '../../services/editor/WebviewDiffInput.js'

type Explorer = import('../../services/explorer/ExplorerTreeService.js').ExplorerTreeService

function fakeExplorer(selection: readonly URI[] = []): Explorer {
  return {
    selection,
    isRoot: () => false,
    isDirectory: () => false,
  } as unknown as Explorer
}

function fakeCompareService(initial: URI | null = null): ICompareService {
  let selected = initial
  return {
    _serviceBrand: undefined,
    onDidChange: new Emitter<void>().event,
    get selectedResource() {
      return selected
    },
    selectForCompare(resource: URI) {
      selected = resource
    },
    clear() {
      selected = null
    },
  }
}

function fakeFileService(texts: Record<string, string>): IFileService {
  return {
    readFileText: vi.fn(async (uri: URI) => texts[uri.toString()] ?? ''),
    readFile: vi.fn(async (uri: URI) => new TextEncoder().encode(texts[uri.toString()] ?? '')),
    stat: vi.fn(async () => ({ isFile: true, size: 10 })),
  } as unknown as IFileService
}

/**
 * A resolver that reports no custom editor for any resource (the default), so
 * comparisons fall back to the Monaco text diff. Pass `custom` to make it report
 * a diff-capable custom editor for every resource.
 */
function fakeEditorResolver(custom?: {
  viewType: string
  supportsDiff: boolean
}): IEditorResolverService {
  return {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose() {} }),
    resolveEditors: (_uri: URI) =>
      custom
        ? [
            {
              glob: '**/*',
              info: {
                typeId: 'customEditor',
                displayName: 'Fake',
                priority: 100,
                viewType: custom.viewType,
                supportsDiff: custom.supportsDiff,
              },
              factory: () => {
                throw new Error('not used')
              },
            },
          ]
        : [],
    openEditor: async () => {},
  } as unknown as IEditorResolverService
}

function fakeDialogService(): IDialogService {
  return {
    confirm: vi.fn(async () => ({ confirmed: true })),
  } as unknown as IDialogService
}

interface Captured {
  input: DiffEditorInput | WebviewDiffInput | null
}

function fakeEditorService(captured: Captured): IEditorService {
  return {
    openEditor: vi.fn((input: unknown) => {
      captured.input = input as DiffEditorInput | WebviewDiffInput
    }),
  } as unknown as IEditorService
}

function buildServices(opts: {
  explorer: Explorer
  compare: ICompareService
  files?: IFileService
  captured?: Captured
  resolver?: IEditorResolverService
}): InstantiationService {
  const services = new ServiceCollection()
  services.set(IExplorerTreeService, opts.explorer)
  services.set(ICompareService, opts.compare)
  services.set(IFileService, opts.files ?? fakeFileService({}))
  services.set(IDialogService, fakeDialogService())
  services.set(IEditorService, fakeEditorService(opts.captured ?? { input: null }))
  services.set(IEditorResolverService, opts.resolver ?? fakeEditorResolver())
  return new InstantiationService(services)
}

describe('fileCompareActions', () => {
  const disposables: Array<{ dispose(): void }> = []

  beforeEach(() => {
    disposables.push(registerAction2(SelectForCompareAction))
    disposables.push(registerAction2(CompareWithSelectedAction))
    disposables.push(registerAction2(CompareSelectedAction))
  })

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    vi.restoreAllMocks()
  })

  it('Select for Compare remembers the target resource', async () => {
    const compare = fakeCompareService()
    const target = URI.file('/ws/a.ts')
    const inst = buildServices({ explorer: fakeExplorer(), compare })
    const cmd = CommandsRegistry.getCommand(SelectForCompareAction.ID)!
    await inst.invokeFunction((accessor) => cmd.handler(accessor, { target }))
    expect(compare.selectedResource?.toString()).toBe(target.toString())
  })

  it('Compare with Selected diffs the remembered file (left) against the target (right)', async () => {
    const left = URI.file('/ws/a.ts')
    const right = URI.file('/ws/b.ts')
    const compare = fakeCompareService(left)
    const captured: Captured = { input: null }
    const inst = buildServices({
      explorer: fakeExplorer(),
      compare,
      files: fakeFileService({ [left.toString()]: 'A', [right.toString()]: 'B' }),
      captured,
    })
    const cmd = CommandsRegistry.getCommand(CompareWithSelectedAction.ID)!
    await inst.invokeFunction((accessor) => cmd.handler(accessor, { target: right }))

    expect(captured.input).toBeInstanceOf(DiffEditorInput)
    const diff = captured.input as DiffEditorInput
    expect(diff.originalUri.toString()).toBe(left.toString())
    expect(diff.modifiedUri.toString()).toBe(right.toString())
    expect(diff.originalContent).toBe('A')
    expect(diff.modifiedContent).toBe('B')
  })

  it('Compare with Selected does nothing without a remembered file', async () => {
    const compare = fakeCompareService(null)
    const captured: Captured = { input: null }
    const inst = buildServices({ explorer: fakeExplorer(), compare, captured })
    const cmd = CommandsRegistry.getCommand(CompareWithSelectedAction.ID)!
    await inst.invokeFunction((accessor) => cmd.handler(accessor, { target: URI.file('/ws/b.ts') }))
    expect(captured.input).toBeNull()
  })

  it('Compare with Selected does nothing when both sides are the same file', async () => {
    const same = URI.file('/ws/a.ts')
    const compare = fakeCompareService(same)
    const captured: Captured = { input: null }
    const inst = buildServices({ explorer: fakeExplorer(), compare, captured })
    const cmd = CommandsRegistry.getCommand(CompareWithSelectedAction.ID)!
    await inst.invokeFunction((accessor) => cmd.handler(accessor, { target: same }))
    expect(captured.input).toBeNull()
  })

  it('Compare Selected diffs exactly the two selected files', async () => {
    const a = URI.file('/ws/a.ts')
    const b = URI.file('/ws/b.ts')
    const captured: Captured = { input: null }
    const inst = buildServices({
      explorer: fakeExplorer([a, b]),
      compare: fakeCompareService(),
      files: fakeFileService({ [a.toString()]: 'A', [b.toString()]: 'B' }),
      captured,
    })
    const cmd = CommandsRegistry.getCommand(CompareSelectedAction.ID)!
    await inst.invokeFunction((accessor) => cmd.handler(accessor))

    expect(captured.input).toBeInstanceOf(DiffEditorInput)
    const diff = captured.input as DiffEditorInput
    expect(diff.originalUri.toString()).toBe(a.toString())
    expect(diff.modifiedUri.toString()).toBe(b.toString())
  })

  it('Compare with Selected renders a webview diff when the target resolves to a diff-capable custom editor', async () => {
    const left = URI.file('/ws/a.xlsx')
    const right = URI.file('/ws/b.xlsx')
    const compare = fakeCompareService(left)
    const captured: Captured = { input: null }
    const inst = buildServices({
      explorer: fakeExplorer(),
      compare,
      files: fakeFileService({ [left.toString()]: 'A', [right.toString()]: 'B' }),
      captured,
      resolver: fakeEditorResolver({ viewType: 'universe.excel', supportsDiff: true }),
    })
    const cmd = CommandsRegistry.getCommand(CompareWithSelectedAction.ID)!
    await inst.invokeFunction((accessor) => cmd.handler(accessor, { target: right }))

    expect(captured.input).toBeInstanceOf(WebviewDiffInput)
    const diff = captured.input as WebviewDiffInput
    expect(diff.viewType).toBe('universe.excel')
    expect(diff.leftUri.toString()).toBe(left.toString())
    expect(diff.rightUri.toString()).toBe(right.toString())
    expect(new TextDecoder().decode(diff.left)).toBe('A')
    expect(new TextDecoder().decode(diff.right)).toBe('B')
  })

  it('Compare with Selected falls back to text diff when the custom editor does not support diff', async () => {
    const left = URI.file('/ws/a.xlsx')
    const right = URI.file('/ws/b.xlsx')
    const compare = fakeCompareService(left)
    const captured: Captured = { input: null }
    const inst = buildServices({
      explorer: fakeExplorer(),
      compare,
      files: fakeFileService({ [left.toString()]: 'A', [right.toString()]: 'B' }),
      captured,
      resolver: fakeEditorResolver({ viewType: 'universe.excel', supportsDiff: false }),
    })
    const cmd = CommandsRegistry.getCommand(CompareWithSelectedAction.ID)!
    await inst.invokeFunction((accessor) => cmd.handler(accessor, { target: right }))

    expect(captured.input).toBeInstanceOf(DiffEditorInput)
  })

  it('Compare Selected does nothing unless exactly two files are selected', async () => {
    const captured: Captured = { input: null }
    const inst = buildServices({
      explorer: fakeExplorer([URI.file('/ws/a.ts')]),
      compare: fakeCompareService(),
      captured,
    })
    const cmd = CommandsRegistry.getCommand(CompareSelectedAction.ID)!
    await inst.invokeFunction((accessor) => cmd.handler(accessor))
    expect(captured.input).toBeNull()
  })
})
