import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ICommandService,
  IEditorGroupsService,
  InstantiationService,
  IWorkspaceService,
  REMOTE_SCHEME,
  ServiceCollection,
  URI,
  type ICommandService as ICommandServiceType,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { dirtyDiffCommandId } from '@universe-editor/extensions-common'
import { OpenActiveFileChangesAction } from '../dirtyDiffActions.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { scmViewState } from '../../workbench/scm/scmViewState.js'
import {
  IScmDecorationsService,
  type IScmDecorationsService as IScmDecorationsServiceType,
} from '../../services/scm/ScmDecorationsService.js'
import {
  IScmService,
  type IScmService as IScmServiceType,
} from '../../services/extensions/ScmService.js'

const GET_HEAD = dirtyDiffCommandId('git', 'getHeadContent')

const scmDecorations = (hasChanges: boolean): IScmDecorationsServiceType => ({
  _serviceBrand: undefined,
  decorations: {
    get: () => ({ files: new Map(), folders: new Map() }),
    read: () => ({ files: new Map(), folders: new Map() }),
  } as never,
  getFile: () => (hasChanges ? { color: '#e2c08d', letter: 'M' } : undefined),
  getFolder: () => undefined,
})

/** A minimal IScmService exposing one `git` provider rooted at `D:/repo`. */
const scmService = (): IScmServiceType =>
  ({
    _serviceBrand: undefined,
    sourceControls: {
      get: () => [{ id: 'git', rootUri: 'D:/repo' }],
      read: () => [{ id: 'git', rootUri: 'D:/repo' }],
    },
  }) as never

/** Workspace stub; a `remote-ssh` folder makes the window a remote one. */
const workspaceOf = (folder: URI): IWorkspaceServiceType =>
  ({ current: { folder } }) as unknown as IWorkspaceServiceType

const localWorkspace = (): IWorkspaceServiceType => workspaceOf(URI.file('D:/repo'))

async function runActionWithServices(services: ServiceCollection): Promise<void> {
  const instantiationService = new InstantiationService(services)
  try {
    await instantiationService.invokeFunction((accessor) =>
      new OpenActiveFileChangesAction().run(accessor),
    )
  } finally {
    instantiationService.dispose()
  }
}

afterEach(() => {
  FileEditorRegistry._resetForTests()
  scmViewState.setSelectedRepo(undefined)
})

describe('OpenActiveFileChangesAction', () => {
  it('registers the public command id with the shift+alt+y keybinding', () => {
    const action = new OpenActiveFileChangesAction()
    expect(OpenActiveFileChangesAction.ID).toBe('workbench.action.editor.openActiveFileChanges')
    expect(action.desc).toMatchObject({
      id: 'workbench.action.editor.openActiveFileChanges',
      keybinding: { primary: 'shift+alt+y', when: '!isInDiffEditor' },
      f1: true,
    })
  })

  it('opens a diff using the active Monaco model content', async () => {
    const groups = new EditorGroupsService()
    const input = new FileEditorInput(URI.file('D:/repo/file.ts'), {} as never)
    groups.activeGroup.openEditor(input)

    FileEditorRegistry.register(
      input,
      { getModel: () => ({ getValue: () => 'unsaved buffer\n' }) } as never,
      groups.activeGroup.id,
    )

    let payload: unknown
    const commandService: ICommandServiceType = {
      _serviceBrand: undefined,
      executeCommand: vi.fn(async (id: string, ...args: unknown[]) => {
        if (id === GET_HEAD) return 'head content\n'
        if (id === '_workbench.openDiff') {
          payload = args[0]
          return undefined
        }
        return undefined
      }) as ICommandServiceType['executeCommand'],
    }

    await runActionWithServices(
      new ServiceCollection(
        [IEditorGroupsService, groups],
        [ICommandService, commandService],
        [IScmDecorationsService, scmDecorations(true)],
        [IScmService, scmService()],
        [IWorkspaceService, localWorkspace()],
      ),
    )

    expect(commandService.executeCommand).toHaveBeenCalledWith(GET_HEAD, input.resource.fsPath)
    expect(payload).toMatchObject({
      original: 'head content\n',
      modified: 'unsaved buffer\n',
      originalUri: input.resource.toString(),
    })
  })

  it('does nothing when the file has no HEAD content and no SCM change', async () => {
    const groups = new EditorGroupsService()
    const input = new FileEditorInput(URI.file('D:/repo/clean.ts'), {} as never)
    groups.activeGroup.openEditor(input)

    const commandService: ICommandServiceType = {
      _serviceBrand: undefined,
      executeCommand: vi.fn(async (id: string) =>
        id === GET_HEAD ? null : undefined,
      ) as ICommandServiceType['executeCommand'],
    }

    await runActionWithServices(
      new ServiceCollection(
        [IEditorGroupsService, groups],
        [ICommandService, commandService],
        [IScmDecorationsService, scmDecorations(false)],
        [IScmService, scmService()],
        [IWorkspaceService, localWorkspace()],
      ),
    )

    expect(commandService.executeCommand).toHaveBeenCalledTimes(1)
  })

  it('routes getHeadContent to the provider the SCM view has selected', async () => {
    const groups = new EditorGroupsService()
    const input = new FileEditorInput(URI.file('D:/repo/git/file.ts'), {} as never)
    groups.activeGroup.openEditor(input)

    const scm = {
      _serviceBrand: undefined,
      sourceControls: {
        get: () => [
          { id: 'perforce', rootUri: 'D:/repo' },
          { id: 'git', rootUri: 'D:/repo/git' },
        ],
        read: () => [
          { id: 'perforce', rootUri: 'D:/repo' },
          { id: 'git', rootUri: 'D:/repo/git' },
        ],
      },
    } as never

    const commandService: ICommandServiceType = {
      _serviceBrand: undefined,
      executeCommand: vi.fn(async () => null) as ICommandServiceType['executeCommand'],
    }

    const services = () =>
      new ServiceCollection(
        [IEditorGroupsService, groups],
        [ICommandService, commandService],
        [IScmDecorationsService, scmDecorations(false)],
        [IScmService, scm],
        [IWorkspaceService, localWorkspace()],
      )

    // No selection → longest prefix wins (the nested git repo).
    scmViewState.setSelectedRepo(undefined)
    await runActionWithServices(services())
    expect(commandService.executeCommand).toHaveBeenCalledWith(
      dirtyDiffCommandId('git', 'getHeadContent'),
      input.resource.fsPath,
    )

    // Outer p4 workspace selected → the selection wins over the prefix heuristic.
    scmViewState.setSelectedRepo('D:/repo')
    await runActionWithServices(services())
    expect(commandService.executeCommand).toHaveBeenCalledWith(
      dirtyDiffCommandId('perforce', 'getHeadContent'),
      input.resource.fsPath,
    )
  })

  it('never fetches HEAD for a client-local file opened in a remote window', async () => {
    // The remote git would read the client's path as one of its own, diffing
    // against an unrelated file that happens to share the path.
    const groups = new EditorGroupsService()
    const input = new FileEditorInput(URI.file('D:/repo/file.ts'), {} as never)
    groups.activeGroup.openEditor(input)

    const commandService: ICommandServiceType = {
      _serviceBrand: undefined,
      executeCommand: vi.fn(async () => null) as ICommandServiceType['executeCommand'],
    }

    await runActionWithServices(
      new ServiceCollection(
        [IEditorGroupsService, groups],
        [ICommandService, commandService],
        [IScmDecorationsService, scmDecorations(false)],
        [IScmService, scmService()],
        [
          IWorkspaceService,
          workspaceOf(
            URI.from({ scheme: REMOTE_SCHEME, authority: 'myhost', path: '/home/u/repo' }),
          ),
        ],
      ),
    )

    expect(commandService.executeCommand).not.toHaveBeenCalled()
  })
})
