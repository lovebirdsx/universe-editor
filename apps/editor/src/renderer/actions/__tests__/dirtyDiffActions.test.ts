import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ICommandService,
  IEditorGroupsService,
  InstantiationService,
  ServiceCollection,
  URI,
  type ICommandService as ICommandServiceType,
} from '@universe-editor/platform'
import { DirtyDiffCommands } from '@universe-editor/extensions-common'
import { OpenActiveFileChangesAction } from '../dirtyDiffActions.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import {
  IScmDecorationsService,
  type IScmDecorationsService as IScmDecorationsServiceType,
} from '../../services/scm/ScmDecorationsService.js'

const scmDecorations = (hasChanges: boolean): IScmDecorationsServiceType => ({
  _serviceBrand: undefined,
  decorations: {
    get: () => ({ files: new Map(), folders: new Map() }),
    read: () => ({ files: new Map(), folders: new Map() }),
  } as never,
  getFile: () => (hasChanges ? { color: '#e2c08d', letter: 'M' } : undefined),
  getFolder: () => undefined,
})

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
})

describe('OpenActiveFileChangesAction', () => {
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
        if (id === DirtyDiffCommands.getHeadContent) return 'head content\n'
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
      ),
    )

    expect(commandService.executeCommand).toHaveBeenCalledWith(
      DirtyDiffCommands.getHeadContent,
      input.resource.fsPath,
    )
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
        id === DirtyDiffCommands.getHeadContent ? null : undefined,
      ) as ICommandServiceType['executeCommand'],
    }

    await runActionWithServices(
      new ServiceCollection(
        [IEditorGroupsService, groups],
        [ICommandService, commandService],
        [IScmDecorationsService, scmDecorations(false)],
      ),
    )

    expect(commandService.executeCommand).toHaveBeenCalledTimes(1)
  })
})
