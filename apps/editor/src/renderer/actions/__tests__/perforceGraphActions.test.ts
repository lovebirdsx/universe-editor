import { describe, expect, it, vi } from 'vitest'
import {
  IEditorService,
  InstantiationService,
  IWorkspaceService,
  REMOTE_SCHEME,
  ServiceCollection,
  URI,
  observableValue,
  type IEditorInput,
  type IEditorService as IEditorServiceType,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { PerforceGraphEditorInput } from '../../services/editor/PerforceGraphEditorInput.js'
import {
  resolveGraphScopeArg,
  resolveGraphScopeTargets,
  ViewPerforceFileHistoryAction,
} from '../perforceGraphActions.js'

describe('resolveGraphScopeArg', () => {
  it('resolves the Explorer shape (live URI + isDirectory)', () => {
    const result = resolveGraphScopeArg({
      target: URI.file('D:/repo/src'),
      resource: URI.file('D:/repo/src'),
      parent: URI.file('D:/repo'),
      isDirectory: true,
    })
    expect(result?.uri.toString()).toBe(URI.file('D:/repo/src').toString())
    expect(result?.isDirectory).toBe(true)
  })

  it('defaults isDirectory to false when absent', () => {
    const result = resolveGraphScopeArg({ resource: URI.file('D:/repo/a.ts') })
    expect(result?.uri.toString()).toBe(URI.file('D:/repo/a.ts').toString())
    expect(result?.isDirectory).toBe(false)
  })

  it('resolves the SCM file-row shape (bare fs-path string)', () => {
    const result = resolveGraphScopeArg({
      resourceUri: 'D:/repo/a.ts',
      contextValue: 'E',
      scmResourceGroupId: 'default',
    })
    expect(result?.uri.toString()).toBe(URI.file('D:/repo/a.ts').toString())
    expect(result?.isDirectory).toBe(false)
  })

  it('revives a degraded UriComponents resource', () => {
    const result = resolveGraphScopeArg({
      resource: { scheme: 'file', path: '/D:/repo/a.ts' },
      isDirectory: false,
    })
    expect(result?.uri.toString()).toBe('file:///D:/repo/a.ts')
    expect(result?.isDirectory).toBe(false)
  })

  it('returns undefined for undefined / null / primitives / arrays', () => {
    expect(resolveGraphScopeArg(undefined)).toBeUndefined()
    expect(resolveGraphScopeArg(null)).toBeUndefined()
    expect(resolveGraphScopeArg('D:/repo/a.ts')).toBeUndefined()
    expect(resolveGraphScopeArg(42)).toBeUndefined()
    expect(resolveGraphScopeArg([{ resource: URI.file('D:/repo/a.ts') }])).toBeUndefined()
    expect(resolveGraphScopeArg({})).toBeUndefined()
    expect(resolveGraphScopeArg({ isDirectory: true })).toBeUndefined()
    expect(resolveGraphScopeArg({ resource: undefined })).toBeUndefined()
    expect(resolveGraphScopeArg({ resource: { not: 'a uri' } })).toBeUndefined()
  })
})

describe('resolveGraphScopeTargets', () => {
  const A = { resource: URI.file('D:/repo/a.ts'), isDirectory: false }
  const DIR = { resource: URI.file('D:/repo/lib'), isDirectory: true }

  it('prefers the selection array when it has entries', () => {
    const out = resolveGraphScopeTargets(A, [A, DIR])
    expect(out.map((t) => [t.uri.toString(), t.isDirectory])).toEqual([
      [A.resource.toString(), false],
      [DIR.resource.toString(), true],
    ])
  })

  it('falls back to the primary arg for an absent or empty selection', () => {
    for (const selection of [undefined, null, [], 'nope']) {
      const out = resolveGraphScopeTargets(A, selection)
      expect(out).toHaveLength(1)
      expect(out[0]?.uri.toString()).toBe(A.resource.toString())
    }
  })

  it('drops unresolvable entries instead of failing the whole selection', () => {
    expect(resolveGraphScopeTargets(undefined, [A, {}, 'x', null])).toHaveLength(1)
  })

  it('returns an empty list when nothing resolves', () => {
    expect(resolveGraphScopeTargets(undefined, undefined)).toEqual([])
  })
})

const workspaceOf = (folder: URI | null): IWorkspaceServiceType =>
  ({ current: folder ? { folder } : null }) as unknown as IWorkspaceServiceType

const editorServiceOf = (active?: IEditorInput): IEditorServiceType => {
  const openEditor = vi.fn()
  return {
    _serviceBrand: undefined,
    openEditor,
    activeEditor: observableValue<IEditorInput | undefined>('t.activeEditor', active),
  } as unknown as IEditorServiceType
}

async function runAction(
  services: ServiceCollection,
  arg?: unknown,
  selection?: unknown,
): Promise<void> {
  const inst = new InstantiationService(services)
  try {
    await inst.invokeFunction((accessor) =>
      new ViewPerforceFileHistoryAction().run(accessor, arg, selection),
    )
  } finally {
    inst.dispose()
  }
}

const openedScope = (editorService: IEditorServiceType): PerforceGraphEditorInput | undefined =>
  (editorService.openEditor as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]

describe('ViewPerforceFileHistoryAction', () => {
  it('opens a scoped tab for the Explorer arg on a local workspace', async () => {
    const editor = editorServiceOf()
    await runAction(
      new ServiceCollection(
        [IEditorService, editor],
        [IWorkspaceService, workspaceOf(URI.file('D:/repo'))],
      ),
      { resource: URI.file('D:/repo/src/a.ts'), isDirectory: false },
    )

    const input = openedScope(editor)
    expect(input).toBeInstanceOf(PerforceGraphEditorInput)
    expect(input?.scope).toEqual({
      paths: [{ path: 'D:/repo/src/a.ts', isDirectory: false }],
      label: 'a.ts',
    })
  })

  it('merges a multi-select into one tab, ordered independently of click order', async () => {
    const services = () =>
      new ServiceCollection(
        [IEditorService, editorServiceOf()],
        [IWorkspaceService, workspaceOf(URI.file('D:/repo'))],
      )

    const first = services()
    const firstEditor = first.get(IEditorService) as IEditorServiceType
    await runAction(first, { resource: URI.file('D:/repo/src/b.ts'), isDirectory: false }, [
      { resource: URI.file('D:/repo/src/b.ts'), isDirectory: false },
      { resource: URI.file('D:/repo/lib'), isDirectory: true },
      { resource: URI.file('D:/repo/src/a.ts'), isDirectory: false },
    ])

    const input = openedScope(firstEditor)
    expect(input?.scope).toEqual({
      paths: [
        { path: 'D:/repo/lib', isDirectory: true },
        { path: 'D:/repo/src/a.ts', isDirectory: false },
        { path: 'D:/repo/src/b.ts', isDirectory: false },
      ],
      label: 'lib +2',
    })

    // Same set, different click order → the very same tab id.
    const second = services()
    const secondEditor = second.get(IEditorService) as IEditorServiceType
    await runAction(second, { resource: URI.file('D:/repo/lib'), isDirectory: true }, [
      { resource: URI.file('D:/repo/src/a.ts'), isDirectory: false },
      { resource: URI.file('D:/repo/lib'), isDirectory: true },
      { resource: URI.file('D:/repo/src/b.ts'), isDirectory: false },
    ])
    expect(openedScope(secondEditor)?.id).toBe(input?.id)
  })

  it('drops off-host selection entries but still opens the rest', async () => {
    const editor = editorServiceOf()
    await runAction(
      new ServiceCollection(
        [IEditorService, editor],
        [
          IWorkspaceService,
          workspaceOf(
            URI.from({ scheme: REMOTE_SCHEME, authority: 'myhost', path: '/home/u/repo' }),
          ),
        ],
      ),
      undefined,
      [
        { resource: URI.file('D:/local/a.ts'), isDirectory: false },
        {
          resource: URI.from({
            scheme: REMOTE_SCHEME,
            authority: 'myhost',
            path: '/home/u/repo/a.ts',
          }),
          isDirectory: false,
        },
      ],
    )

    expect(openedScope(editor)?.scope).toEqual({
      paths: [{ path: '/home/u/repo/a.ts', isDirectory: false }],
      label: 'a.ts',
    })
  })

  it('an empty selection array falls back to the primary arg', async () => {
    const editor = editorServiceOf()
    await runAction(
      new ServiceCollection(
        [IEditorService, editor],
        [IWorkspaceService, workspaceOf(URI.file('D:/repo'))],
      ),
      { resource: URI.file('D:/repo/a.ts'), isDirectory: false },
      [],
    )
    expect(openedScope(editor)?.scope?.paths).toEqual([
      { path: 'D:/repo/a.ts', isDirectory: false },
    ])
  })

  it('falls back to the active file editor when no arg is passed', async () => {
    const editor = editorServiceOf(new FileEditorInput(URI.file('D:/repo/b.ts'), {} as never))
    await runAction(
      new ServiceCollection(
        [IEditorService, editor],
        [IWorkspaceService, workspaceOf(URI.file('D:/repo'))],
      ),
    )

    const input = openedScope(editor)
    expect(input?.scope).toEqual({
      paths: [{ path: 'D:/repo/b.ts', isDirectory: false }],
      label: 'b.ts',
    })
  })

  it('does nothing for a client-local file in a remote window', async () => {
    const editor = editorServiceOf()
    await runAction(
      new ServiceCollection(
        [IEditorService, editor],
        [
          IWorkspaceService,
          workspaceOf(
            URI.from({ scheme: REMOTE_SCHEME, authority: 'myhost', path: '/home/u/repo' }),
          ),
        ],
      ),
      { resource: URI.file('D:/repo/a.ts'), isDirectory: false },
    )

    expect(editor.openEditor).not.toHaveBeenCalled()
  })

  it('does nothing when there is neither an arg nor an active file editor', async () => {
    const editor = editorServiceOf()
    await runAction(
      new ServiceCollection(
        [IEditorService, editor],
        [IWorkspaceService, workspaceOf(URI.file('D:/repo'))],
      ),
    )

    expect(editor.openEditor).not.toHaveBeenCalled()
  })
})
