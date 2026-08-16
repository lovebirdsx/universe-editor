/*---------------------------------------------------------------------------------------------
 *  Tests for renderer-side commands that back the extension API.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  IEditorGroupsService,
  ILifecycleService,
  IUriIdentityService,
  IWindowsService,
  IWorkspaceService,
  InstantiationService,
  LifecyclePhase,
  REMOTE_SCHEME,
  ServiceCollection,
  URI,
  UriIdentityService,
  registerAction2,
  type IDisposable,
  type IEditorGroup,
  type IRecentWorkspace,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { CommandService } from '../../services/command/CommandService.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import {
  OpenFileAction,
  OpenFileAtAction,
  OpenFolderFromExtensionAction,
  OpenFolderInNewWindowFromExtensionAction,
} from '../extensionApiActions.js'

class WorkspaceStub implements IWorkspaceServiceType {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeWorkspace = new Emitter<IWorkspace | null>()
  private readonly _onDidChangeRecent = new Emitter<readonly IRecentWorkspace[]>()

  current: IWorkspace | null = null
  readonly recent: readonly IRecentWorkspace[] = []
  readonly whenReady = Promise.resolve()
  readonly onDidChangeWorkspace = this._onDidChangeWorkspace.event
  readonly onDidChangeRecent = this._onDidChangeRecent.event
  readonly openFolder = vi.fn(async (_folder?: URI) => {})
  readonly closeFolder = vi.fn(async () => {})
  readonly removeRecent = vi.fn(async (_folder: URI) => {})
  readonly clearRecent = vi.fn(async () => {})
}

function lifecycleStub(): ILifecycleService {
  return {
    _serviceBrand: undefined,
    phase: LifecyclePhase.Starting,
    when: vi.fn(async () => {}),
    onBeforeShutdown: new Emitter<never>().event,
    onWillShutdown: new Emitter<never>().event,
    confirmBeforeShutdown: vi.fn(async () => false),
    shutdown: vi.fn(async () => false),
    dispose: vi.fn(),
  }
}

function commandService(services: ServiceCollection): CommandService {
  return new CommandService(new InstantiationService(services))
}

function makeGroups(): { groups: IEditorGroupsService; openEditor: ReturnType<typeof vi.fn> } {
  const openEditor = vi.fn()
  const group = { openEditor } as unknown as IEditorGroup
  const groups = {
    activeGroup: group,
    activeGroupForOpen: group,
    groups: [],
  } as unknown as IEditorGroupsService
  return { groups, openEditor }
}

const REMOTE_AUTHORITY = 'wsl+Ubuntu'
const REMOTE_FOLDER = URI.from({
  scheme: REMOTE_SCHEME,
  authority: REMOTE_AUTHORITY,
  path: '/home/u/repo',
})

describe('extensionApiActions', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    vi.restoreAllMocks()
  })

  it('opens a folder from an extension after shutdown confirmation', async () => {
    disposables.push(registerAction2(OpenFolderFromExtensionAction))

    const workspace = new WorkspaceStub()
    const services = new ServiceCollection()
    services.set(IWorkspaceService, workspace)
    services.set(ILifecycleService, lifecycleStub())

    const folder = '/tmp/linked-worktree'

    await commandService(services).executeCommand(OpenFolderFromExtensionAction.ID, folder)

    expect(workspace.openFolder).toHaveBeenCalledOnce()
    expect(workspace.openFolder).toHaveBeenCalledWith(URI.file(folder))
  })

  it('opens a folder with the workspace remote authority', async () => {
    disposables.push(registerAction2(OpenFolderFromExtensionAction))

    const workspace = new WorkspaceStub()
    workspace.current = { folder: REMOTE_FOLDER, name: 'repo' }
    const services = new ServiceCollection()
    services.set(IWorkspaceService, workspace)
    services.set(ILifecycleService, lifecycleStub())

    const folder = '/home/u/repo.worktrees/x'

    await commandService(services).executeCommand(OpenFolderFromExtensionAction.ID, folder)

    expect(workspace.openFolder).toHaveBeenCalledOnce()
    const opened = workspace.openFolder.mock.calls[0]?.[0] as URI | undefined
    expect(opened?.scheme).toBe(REMOTE_SCHEME)
    expect(opened?.authority).toBe(REMOTE_AUTHORITY)
    expect(opened?.path).toBe(folder)
  })

  it('opens a folder in a new window with the workspace remote authority', async () => {
    disposables.push(registerAction2(OpenFolderInNewWindowFromExtensionAction))

    const workspace = new WorkspaceStub()
    workspace.current = { folder: REMOTE_FOLDER, name: 'repo' }
    const openWindow = vi.fn(async (_folder?: URI) => {})
    const services = new ServiceCollection()
    services.set(IWorkspaceService, workspace)
    services.set(IWindowsService, {
      _serviceBrand: undefined,
      openWindow,
    } as unknown as IWindowsService)

    const folder = '/home/u/repo.worktrees/x'

    await commandService(services).executeCommand(
      OpenFolderInNewWindowFromExtensionAction.ID,
      folder,
    )

    expect(openWindow).toHaveBeenCalledOnce()
    const opened = openWindow.mock.calls[0]?.[0] as URI | undefined
    expect(opened?.scheme).toBe(REMOTE_SCHEME)
    expect(opened?.authority).toBe(REMOTE_AUTHORITY)
    expect(opened?.path).toBe(folder)
  })

  it('opens a folder in a new window as a local file URI for a file-scheme workspace', async () => {
    disposables.push(registerAction2(OpenFolderInNewWindowFromExtensionAction))

    const workspace = new WorkspaceStub()
    workspace.current = { folder: URI.file('/home/u/repo'), name: 'repo' }
    const openWindow = vi.fn(async (_folder?: URI) => {})
    const services = new ServiceCollection()
    services.set(IWorkspaceService, workspace)
    services.set(IWindowsService, {
      _serviceBrand: undefined,
      openWindow,
    } as unknown as IWindowsService)

    const folder = '/home/u/repo.worktrees/x'

    await commandService(services).executeCommand(
      OpenFolderInNewWindowFromExtensionAction.ID,
      folder,
    )

    expect(openWindow).toHaveBeenCalledWith(URI.file(folder))
  })

  it('opens a folder as a local file URI when there is no workspace', async () => {
    disposables.push(registerAction2(OpenFolderFromExtensionAction))

    const workspace = new WorkspaceStub()
    const services = new ServiceCollection()
    services.set(IWorkspaceService, workspace)
    services.set(ILifecycleService, lifecycleStub())

    const folder = '/home/u/repo.worktrees/x'

    await commandService(services).executeCommand(OpenFolderFromExtensionAction.ID, folder)

    expect(workspace.openFolder).toHaveBeenCalledWith(URI.file(folder))
  })

  it('opens a file with the workspace remote authority', async () => {
    disposables.push(registerAction2(OpenFileAction))

    const workspace = new WorkspaceStub()
    workspace.current = { folder: REMOTE_FOLDER, name: 'repo' }
    const { groups, openEditor } = makeGroups()
    const services = new ServiceCollection()
    services.set(IWorkspaceService, workspace)
    services.set(IEditorGroupsService, groups)

    const file = '/home/u/repo.worktrees/x/src/a.ts'

    await commandService(services).executeCommand(OpenFileAction.ID, file)

    expect(openEditor).toHaveBeenCalledOnce()
    const input = openEditor.mock.calls[0]?.[0] as { resource: URI } | undefined
    expect(input?.resource.scheme).toBe(REMOTE_SCHEME)
    expect(input?.resource.authority).toBe(REMOTE_AUTHORITY)
    expect(input?.resource.path).toBe(file)
  })

  it('opens a file at position with the workspace remote authority', async () => {
    disposables.push(registerAction2(OpenFileAtAction))

    const workspace = new WorkspaceStub()
    workspace.current = { folder: REMOTE_FOLDER, name: 'repo' }
    const { groups, openEditor } = makeGroups()
    const services = new ServiceCollection()
    services.set(IWorkspaceService, workspace)
    services.set(IEditorGroupsService, groups)
    services.set(IUriIdentityService, new UriIdentityService('linux'))
    vi.spyOn(FileEditorRegistry, 'get').mockReturnValue({
      setSelection: vi.fn(),
      revealRangeInCenterIfOutsideViewport: vi.fn(),
      focus: vi.fn(),
    } as never)

    const file = '/home/u/repo.worktrees/x/src/a.ts'

    await commandService(services).executeCommand(OpenFileAtAction.ID, file, 3)

    expect(openEditor).toHaveBeenCalledOnce()
    const input = openEditor.mock.calls[0]?.[0] as { resource: URI } | undefined
    expect(input?.resource.scheme).toBe(REMOTE_SCHEME)
    expect(input?.resource.authority).toBe(REMOTE_AUTHORITY)
    expect(input?.resource.path).toBe(file)
  })
})
