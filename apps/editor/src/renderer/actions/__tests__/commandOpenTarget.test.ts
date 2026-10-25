/*---------------------------------------------------------------------------------------------
 *  Editor-opening commands honour the invocation modifiers of the gesture that
 *  ran them (command palette Ctrl/Alt+Enter, Ctrl/Alt+click on a button or
 *  menu): Ctrl opens to the side, Alt into a new window, a plain run keeps each
 *  command's own default. Diagnostic pages are singletons (moved, never
 *  duplicated); files such as settings.json / logs are copied.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConfigurationTarget,
  IEditorGroupsService,
  IEditorService,
  IFileService,
  IInstantiationService,
  InstantiationService,
  IQuickInputService,
  IUriIdentityService,
  IUserDataFilesService,
  ServiceCollection,
  URI,
  UriIdentityService,
  UserDataFile,
  runWithInvocationModifiers,
  type EditorInput,
  type IEditorService as IEditorServiceType,
} from '@universe-editor/platform'
import { ILogFilesService } from '../../../shared/ipc/services.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { InteractionPerformanceInput } from '../../services/editor/InteractionPerformanceInput.js'
import { PerforceSyncHistoryEditorInput } from '../../services/editor/PerforceSyncHistoryEditorInput.js'
import { ProcessExplorerInput } from '../../services/editor/ProcessExplorerInput.js'
import { SettingsEditorInput } from '../../services/editor/SettingsEditorInput.js'
import { StartupPerformanceInput } from '../../services/editor/StartupPerformanceInput.js'
import { IAuxiliaryEditorWindowService } from '../../services/windows/auxiliaryEditorWindowService.js'
import { IWindowFocusService } from '../../services/windows/windowFocusService.js'
import { FakeWindowFocusService } from '../../services/windows/testing/fakeWindowFocusService.js'
import { OpenLogFileAction } from '../logActions.js'
import { ViewPerforceSyncHistoryAction } from '../perforceSyncHistoryActions.js'
import {
  ShowInteractionPerformanceAction,
  ShowStartupPerformanceAction,
} from '../performanceActions.js'
import { OpenSettingsJsonAction, OpenWorkspaceSettingsAction } from '../preferencesActions.js'
import { OpenProcessExplorerAction } from '../processExplorerActions.js'

const switchSettingsTarget = vi.hoisted(() => vi.fn())
vi.mock('../../workbench/preferences/preferencesFocus.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dispatchSettingsEditorSwitchTarget: switchSettingsTarget,
}))

const disposables: Array<{ dispose(): void }> = []
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
})

const SETTINGS_URI = URI.file('/userData/settings.json')
const LOG_PATH = '/userData/logs/main.log'

function setup(): {
  groups: EditorGroupsService
  openEditor: ReturnType<typeof vi.fn>
  openInNewWindow: ReturnType<typeof vi.fn>
  run: (action: { run(accessor: never): unknown }) => Promise<void>
} {
  const groups = new EditorGroupsService()
  const openEditor = vi.fn()
  const openInNewWindow = vi.fn(async (editor: unknown) => ({
    ok: true,
    editor,
    window: { part: { activeGroup: groups.activeGroup } },
  }))
  const descriptor = { id: 'main', name: 'Main', channelId: 'main', modifiedTime: 0, size: 0 }
  const services = new ServiceCollection(
    [IEditorGroupsService, groups],
    [IEditorService, { openEditor } as unknown as IEditorServiceType],
    [IUriIdentityService, new UriIdentityService('linux')],
    [IAuxiliaryEditorWindowService, { openEditorInNewWindow: openInNewWindow } as never],
    [IWindowFocusService, new FakeWindowFocusService()],
    [IFileService, {} as never],
    [
      IUserDataFilesService,
      {
        getFileUri: async (file: UserDataFile) =>
          file === UserDataFile.Settings ? SETTINGS_URI : null,
        read: async () => '{}',
        write: async () => undefined,
      } as never,
    ],
    [
      ILogFilesService,
      {
        listLogFiles: async () => [descriptor],
        resolveLogPath: async () => LOG_PATH,
      } as never,
    ],
    [IQuickInputService, { pick: async (items: unknown[]) => items[0] } as never],
  )
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)
  disposables.push(groups, inst)
  return {
    groups,
    openEditor,
    openInNewWindow,
    run: async (action) => {
      await inst.invokeFunction((accessor) => action.run(accessor as never))
    },
  }
}

const allEditors = (groups: EditorGroupsService): EditorInput[] =>
  groups.groups.flatMap((g) => [...g.editors])

describe.each([
  ['Startup Performance', () => new ShowStartupPerformanceAction(), StartupPerformanceInput],
  [
    'Interaction Performance',
    () => new ShowInteractionPerformanceAction(),
    InteractionPerformanceInput,
  ],
  ['Process Explorer', () => new OpenProcessExplorerAction(), ProcessExplorerInput],
  ['Workspace Settings', () => new OpenWorkspaceSettingsAction(), SettingsEditorInput],
] as const)('%s', (_name, createAction, InputClass) => {
  it('opens in the active group on a plain run', async () => {
    const { groups, run } = setup()

    await run(createAction())

    expect(groups.count).toBe(1)
    expect(groups.activeGroup.activeEditor).toBeInstanceOf(InputClass)
  })

  it('opens to the side under Ctrl', async () => {
    const { groups, run } = setup()

    await runWithInvocationModifiers({ ctrlKey: true }, () => run(createAction()))

    expect(groups.count).toBe(2)
    expect(groups.activeGroup.activeEditor).toBeInstanceOf(InputClass)
  })

  it('opens into a new window under Alt', async () => {
    const { groups, openInNewWindow, run } = setup()

    await runWithInvocationModifiers({ altKey: true }, () => run(createAction()))

    expect(groups.count).toBe(1)
    expect(openInNewWindow).toHaveBeenCalledOnce()
    expect(openInNewWindow.mock.calls[0]?.[0]).toBeInstanceOf(InputClass)
  })

  it('moves an open page to the side instead of duplicating it', async () => {
    const { groups, run } = setup()
    const source = groups.activeGroup
    const open = new InputClass()
    source.openEditor(open)

    await runWithInvocationModifiers({ ctrlKey: true }, () => run(createAction()))

    expect(source.contains(open)).toBe(false)
    expect(allEditors(groups)).toEqual([open])
  })
})

describe('Workspace Settings', () => {
  it('a targeted open still lands on the workspace tab', async () => {
    const { groups, run } = setup()

    await runWithInvocationModifiers({ ctrlKey: true }, () =>
      run(new OpenWorkspaceSettingsAction()),
    )

    const input = groups.activeGroup.activeEditor as SettingsEditorInput
    expect(input.target).toBe(ConfigurationTarget.Project)
  })

  it('moving an open Settings editor to the side switches it to the workspace tab', async () => {
    const { groups, run } = setup()
    const source = groups.activeGroup
    const open = new SettingsEditorInput()
    source.openEditor(open)
    switchSettingsTarget.mockClear()

    await runWithInvocationModifiers({ ctrlKey: true }, () =>
      run(new OpenWorkspaceSettingsAction()),
    )

    // Moved, not copied: the emptied source group collapses.
    expect(groups.activeGroup).not.toBe(source)
    expect(allEditors(groups)).toEqual([open])
    expect(switchSettingsTarget).toHaveBeenCalledWith(ConfigurationTarget.Project)
  })
})

describe('Perforce Sync History', () => {
  it('opens through the editor service on a plain run', async () => {
    const { groups, openEditor, run } = setup()

    await run(new ViewPerforceSyncHistoryAction())

    expect(openEditor).toHaveBeenCalledOnce()
    expect(openEditor.mock.calls[0]?.[0]).toBeInstanceOf(PerforceSyncHistoryEditorInput)
    expect(groups.count).toBe(1)
  })

  it('opens to the side under Ctrl', async () => {
    const { groups, openEditor, run } = setup()

    await runWithInvocationModifiers({ ctrlKey: true }, () =>
      run(new ViewPerforceSyncHistoryAction()),
    )

    expect(openEditor).not.toHaveBeenCalled()
    expect(groups.count).toBe(2)
    expect(groups.activeGroup.activeEditor).toBeInstanceOf(PerforceSyncHistoryEditorInput)
  })
})

describe('Open Settings (JSON)', () => {
  it('reveals an open settings.json on a plain run', async () => {
    const { groups, run } = setup()

    await run(new OpenSettingsJsonAction())
    await run(new OpenSettingsJsonAction())

    expect(groups.count).toBe(1)
    expect(allEditors(groups)).toHaveLength(1)
    expect((groups.activeGroup.activeEditor as FileEditorInput).resource.toString()).toBe(
      SETTINGS_URI.toString(),
    )
  })

  it('opens a copy to the side under Ctrl, keeping the original tab', async () => {
    const { groups, run } = setup()
    await run(new OpenSettingsJsonAction())
    const source = groups.activeGroup

    await runWithInvocationModifiers({ ctrlKey: true }, () => run(new OpenSettingsJsonAction()))

    expect(groups.count).toBe(2)
    expect(source.editors).toHaveLength(1)
    expect(groups.activeGroup).not.toBe(source)
    expect(groups.activeGroup.activeEditor).toBeInstanceOf(FileEditorInput)
  })

  it('opens into a new window under Alt', async () => {
    const { groups, openInNewWindow, run } = setup()

    await runWithInvocationModifiers({ altKey: true }, () => run(new OpenSettingsJsonAction()))

    expect(groups.count).toBe(1)
    expect(openInNewWindow).toHaveBeenCalledOnce()
    expect(openInNewWindow.mock.calls[0]?.[0]).toBeInstanceOf(FileEditorInput)
  })
})

describe('Open Log File', () => {
  it('reads the target before the picker and opens a read-only copy to the side', async () => {
    const { groups, run } = setup()

    // The modifier is only live during the synchronous part of the run: the
    // picker and IPC awaits that follow must not lose it.
    await runWithInvocationModifiers({ ctrlKey: true }, () => run(new OpenLogFileAction()))

    expect(groups.count).toBe(2)
    const input = groups.activeGroup.activeEditor as FileEditorInput
    expect(input.resource.path).toBe(LOG_PATH)
    expect(input.isReadonly).toBe(true)
  })
})
