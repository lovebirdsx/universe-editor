import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IEditorGroupsService,
  IEditorResolverService,
  IProgressService,
  InstantiationService,
  MenuId,
  REMOTE_SCHEME,
  ServiceCollection,
  URI,
  runWithInvocationModifiers,
} from '@universe-editor/platform'
import { IExtensionHostClientService } from '../../services/extensions/ExtensionHostClientService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FindTypeScriptFileReferencesAction } from '../typescriptFileReferencesActions.js'

const showReferences = vi.fn(async () => undefined)
vi.mock('../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    get: () => ({ Uri: { parse: (s: string) => s } }),
    getCommandService: async () => ({ executeCommand: showReferences }),
  },
}))
vi.mock('../../services/languageFeatures/typescript/lspMonacoConvert.js', () => ({
  locationToMonaco: (l: unknown) => l,
}))

const openWithTargetMocks = vi.hoisted(() => ({
  openUriEditor: vi.fn(async (..._args: unknown[]) => true),
  openTargetServicesFrom: vi.fn(() => ({ marker: 'services' })),
}))
vi.mock('../../services/editor/openWithTarget.js', () => openWithTargetMocks)

interface RunOptions {
  locations?: unknown
  activeEditor?: unknown
  modifiers?: { ctrlKey?: boolean; altKey?: boolean }
  rejectCommand?: unknown
}

interface HostMock {
  activateByEvent: ReturnType<typeof vi.fn>
  executeContributedCommand: ReturnType<typeof vi.fn>
}

async function runAction(
  arg: unknown,
  options: RunOptions = {},
): Promise<{ openEditor: ReturnType<typeof vi.fn>; host: HostMock }> {
  const openEditor = vi.fn(async () => undefined)
  const host: HostMock = {
    activateByEvent: vi.fn(async () => undefined),
    executeContributedCommand: vi.fn(async () => {
      if (options.rejectCommand !== undefined) throw options.rejectCommand
      return options.locations ?? [{ uri: 'file:///repo/use.ts', range: { start: {}, end: {} } }]
    }),
  }
  const progress = {
    withProgress: <R>(_options: unknown, task: () => Promise<R>) => task(),
  }
  const groups = { activeGroup: { activeEditor: options.activeEditor } }

  const services = new ServiceCollection(
    [IExtensionHostClientService, host as never],
    [IEditorResolverService, { openEditor } as never],
    [IProgressService, progress as never],
    [IEditorGroupsService, groups as never],
  )
  const inst = new InstantiationService(services)
  const invoke = (): Promise<void> =>
    inst.invokeFunction((accessor) => new FindTypeScriptFileReferencesAction().run(accessor, arg))
  await (options.modifiers ? runWithInvocationModifiers(options.modifiers, invoke) : invoke())
  return { openEditor, host }
}

beforeEach(() => {
  showReferences.mockClear()
  openWithTargetMocks.openUriEditor.mockClear()
  openWithTargetMocks.openTargetServicesFrom.mockClear()
  openWithTargetMocks.openUriEditor.mockResolvedValue(true)
})

describe('FindTypeScriptFileReferencesAction', () => {
  it('resolves an Explorer target, opens it, and shows the references peek', async () => {
    const target = URI.file('/repo/lib.ts')

    const { openEditor, host } = await runAction({ target })

    expect(host.executeContributedCommand).toHaveBeenCalledWith('typescript.getFileReferences', [
      'file:///repo/lib.ts',
    ])
    expect(openEditor).toHaveBeenCalledWith(target, { pinned: true })
    expect(showReferences).toHaveBeenCalledOnce()
  })

  it('revives a tab-context resource arg', async () => {
    const target = URI.file('/repo/lib.ts')

    const { host } = await runAction({
      groupId: 1,
      editorId: 'editor-1',
      resource: target.toJSON(),
    })

    expect(host.executeContributedCommand).toHaveBeenCalledWith('typescript.getFileReferences', [
      'file:///repo/lib.ts',
    ])
    expect(showReferences).toHaveBeenCalledOnce()
  })

  it('falls back to the active file editor when invoked without a target', async () => {
    const input = new FileEditorInput(URI.file('/repo/active.ts'), {} as never)

    const { openEditor, host } = await runAction(undefined, { activeEditor: input })

    expect(host.executeContributedCommand).toHaveBeenCalledWith('typescript.getFileReferences', [
      'file:///repo/active.ts',
    ])
    expect(openEditor).toHaveBeenCalledWith(input.resource, { pinned: true })
  })

  it('translates a remote target into the extension host file: space', async () => {
    const target = URI.from({
      scheme: REMOTE_SCHEME,
      authority: 'wsl+ubuntu',
      path: '/home/dev/lib.ts',
    })

    const { host } = await runAction({ target })

    expect(host.executeContributedCommand).toHaveBeenCalledWith('typescript.getFileReferences', [
      'file:///home/dev/lib.ts',
    ])
  })

  it('does nothing when the server returns no locations', async () => {
    const { openEditor } = await runAction({ target: URI.file('/repo/lib.ts') }, { locations: [] })

    expect(openEditor).not.toHaveBeenCalled()
    expect(showReferences).not.toHaveBeenCalled()
  })

  it('opens the target to the side under Ctrl and still shows the peek', async () => {
    const target = URI.file('/repo/lib.ts')

    const { openEditor } = await runAction({ target }, { modifiers: { ctrlKey: true } })

    expect(openEditor).not.toHaveBeenCalled()
    expect(openWithTargetMocks.openTargetServicesFrom).toHaveBeenCalledOnce()
    const [services, openTarget, resource, , options] =
      openWithTargetMocks.openUriEditor.mock.calls[0]!
    expect(services).toEqual({ marker: 'services', resolver: expect.anything() })
    expect(openTarget).toBe('side')
    expect((resource as URI).toString()).toBe(target.toString())
    expect(options).toEqual({ pinned: true })
    expect(showReferences).toHaveBeenCalledOnce()
  })

  it('skips the peek when the target opens into a new window', async () => {
    const { openEditor } = await runAction(
      { target: URI.file('/repo/lib.ts') },
      { modifiers: { altKey: true } },
    )

    expect(openEditor).not.toHaveBeenCalled()
    expect(openWithTargetMocks.openUriEditor).toHaveBeenCalledOnce()
    expect(showReferences).not.toHaveBeenCalled()
  })

  it('ignores non-TypeScript targets before touching the extension host', async () => {
    const { host } = await runAction({ target: URI.file('/repo/README.md') })

    expect(host.executeContributedCommand).not.toHaveBeenCalled()
    expect(showReferences).not.toHaveBeenCalled()
  })

  it('swallows extension-host failures', async () => {
    const { openEditor } = await runAction(
      { target: URI.file('/repo/lib.ts') },
      { rejectCommand: new Error('host is down') },
    )

    expect(openEditor).not.toHaveBeenCalled()
    expect(showReferences).not.toHaveBeenCalled()
  })

  it('gates the palette by language while keeping the context menus enabled', () => {
    const action = new FindTypeScriptFileReferencesAction()
    expect(action.desc.f1).toBe(false)
    expect(action.desc.keybinding).toEqual({ primary: ['ctrl+k', 'ctrl+r'] })

    const menus = action.desc.menu as readonly { id: string; when?: string }[]
    expect(menus.map((menu) => menu.id)).toEqual([
      MenuId.CommandPalette,
      MenuId.EditorTabContext,
      MenuId.ExplorerContext,
    ])
    expect(menus[0]!.when).toContain('editorLangId == typescript')
    expect(menus[1]!.when).toContain('activeEditorLanguageId == typescript')
    expect(menus[1]!.when).toContain('resourceScheme == file')
    expect(menus[2]!.when).toContain('resourceExtname == .ts')
    expect(menus[2]!.when).toContain('!explorerResourceIsFolder')
  })
})
