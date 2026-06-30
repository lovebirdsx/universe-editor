/*---------------------------------------------------------------------------------------------
 *  Tests for renderer-side commands that back the extension API.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  ILifecycleService,
  IWorkspaceService,
  InstantiationService,
  LifecyclePhase,
  ServiceCollection,
  URI,
  registerAction2,
  type IDisposable,
  type IRecentWorkspace,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { CommandService } from '../../services/command/CommandService.js'
import { OpenFolderFromExtensionAction } from '../extensionApiActions.js'

class WorkspaceStub implements IWorkspaceServiceType {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeWorkspace = new Emitter<IWorkspace | null>()
  private readonly _onDidChangeRecent = new Emitter<readonly IRecentWorkspace[]>()

  readonly current = null
  readonly recent: readonly IRecentWorkspace[] = []
  readonly whenReady = Promise.resolve()
  readonly onDidChangeWorkspace = this._onDidChangeWorkspace.event
  readonly onDidChangeRecent = this._onDidChangeRecent.event
  readonly openFolder = vi.fn(async (_folder?: URI) => {})
  readonly closeFolder = vi.fn(async () => {})
  readonly removeRecent = vi.fn(async (_folder: URI) => {})
  readonly clearRecent = vi.fn(async () => {})
}

describe('extensionApiActions', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('opens a folder from an extension after shutdown confirmation', async () => {
    disposables.push(registerAction2(OpenFolderFromExtensionAction))

    const workspace = new WorkspaceStub()
    const services = new ServiceCollection()
    services.set(IWorkspaceService, workspace)
    services.set(ILifecycleService, {
      _serviceBrand: undefined,
      phase: LifecyclePhase.Starting,
      when: vi.fn(async () => {}),
      onBeforeShutdown: new Emitter<never>().event,
      onWillShutdown: new Emitter<never>().event,
      confirmBeforeShutdown: vi.fn(async () => false),
      shutdown: vi.fn(async () => false),
      dispose: vi.fn(),
    })

    const commandService = new CommandService(new InstantiationService(services))
    const folder = '/tmp/linked-worktree'

    await commandService.executeCommand(OpenFolderFromExtensionAction.ID, folder)

    expect(workspace.openFolder).toHaveBeenCalledOnce()
    expect(workspace.openFolder).toHaveBeenCalledWith(URI.file(folder))
  })
})
