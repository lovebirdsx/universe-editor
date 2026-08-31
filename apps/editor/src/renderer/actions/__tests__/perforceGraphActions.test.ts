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
import { resolveGraphScopeArg, ViewPerforceFileHistoryAction } from '../perforceGraphActions.js'

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

async function runAction(services: ServiceCollection, arg?: unknown): Promise<void> {
  const inst = new InstantiationService(services)
  try {
    await inst.invokeFunction((accessor) => new ViewPerforceFileHistoryAction().run(accessor, arg))
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
      path: 'D:/repo/src/a.ts',
      isDirectory: false,
      label: 'a.ts',
    })
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
    expect(input?.scope).toEqual({ path: 'D:/repo/b.ts', isDirectory: false, label: 'b.ts' })
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
