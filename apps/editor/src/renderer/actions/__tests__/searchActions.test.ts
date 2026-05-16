/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/actions/searchActions.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  IEditorGroupsService,
  IFileService,
  ILayoutService,
  IInstantiationService,
  IViewsService,
  InstantiationService,
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  PartId,
  ServiceCollection,
  URI,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import {
  FindInFileAction,
  FindInFilesAction,
  FindNextAction,
  FindReplaceInFileAction,
  SEARCH_FOCUS_INPUT_EVENT,
} from '../searchActions.js'
import { FileEditorInput } from '../../workbench/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../workbench/editor/FileEditorRegistry.js'
import { MonacoModelRegistry } from '../../workbench/editor/monaco/MonacoModelRegistry.js'

describe('FindInFilesAction', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) {
      disposables.pop()?.dispose()
    }
  })

  it('registers command, keybinding, and F1 menu entry', () => {
    disposables.push(registerAction2(FindInFilesAction))
    expect(CommandsRegistry.getCommand(FindInFilesAction.ID)).toBeDefined()
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+shift+f')).toBe(FindInFilesAction.ID)
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === FindInFilesAction.ID,
      ),
    ).toBe(true)
  })

  it('run() opens the search ViewContainer and dispatches the focus event', async () => {
    const openViewContainer = vi.fn()
    const setVisible = vi.fn()
    const getVisible = vi.fn().mockReturnValue(false)
    const services = new ServiceCollection()
    services.set(ILayoutService, {
      _serviceBrand: undefined,
      getVisible,
      setVisible,
      toggleVisible: vi.fn(),
    } as never)
    services.set(IViewsService, {
      _serviceBrand: undefined,
      openViewContainer,
    } as never)
    const inst = new InstantiationService(services)
    disposables.push(registerAction2(FindInFilesAction))

    let fired: string | null | undefined
    const listener = (e: Event) => {
      fired = (e as CustomEvent<string | null>).detail
    }
    document.addEventListener(SEARCH_FOCUS_INPUT_EVENT, listener)

    await inst.invokeFunction((accessor) => {
      const cmd = CommandsRegistry.getCommand(FindInFilesAction.ID)!
      cmd.handler(accessor, { query: 'foo' })
    })

    document.removeEventListener(SEARCH_FOCUS_INPUT_EVENT, listener)
    expect(openViewContainer).toHaveBeenCalledWith('workbench.view.search')
    expect(setVisible).toHaveBeenCalledWith(PartId.SideBar, true)
    expect(fired).toBe('foo')
  })

  it('run() with no query dispatches null detail', async () => {
    const openViewContainer = vi.fn()
    const services = new ServiceCollection()
    services.set(ILayoutService, {
      _serviceBrand: undefined,
      getVisible: () => true,
      setVisible: vi.fn(),
      toggleVisible: vi.fn(),
    } as never)
    services.set(IViewsService, {
      _serviceBrand: undefined,
      openViewContainer,
    } as never)
    const inst = new InstantiationService(services)
    disposables.push(registerAction2(FindInFilesAction))

    let fired: string | null | undefined = 'unset'
    const listener = (e: Event) => {
      fired = (e as CustomEvent<string | null>).detail
    }
    document.addEventListener(SEARCH_FOCUS_INPUT_EVENT, listener)

    await inst.invokeFunction((accessor) => {
      const cmd = CommandsRegistry.getCommand(FindInFilesAction.ID)!
      cmd.handler(accessor)
    })

    document.removeEventListener(SEARCH_FOCUS_INPUT_EVENT, listener)
    expect(fired).toBeNull()
  })
})

describe('Monaco single-file find wrappers', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) {
      disposables.pop()?.dispose()
    }
    FileEditorRegistry._resetForTests()
    MonacoModelRegistry._resetForTests()
  })

  function stubFs() {
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
        return false
      },
      async stat() {
        throw new Error('not used')
      },
      async list() {
        return []
      },
      async createDirectory() {},
      async delete() {},
      async rename() {},
    }
  }

  function setup(opts: { hasActive?: boolean; actionId: string }) {
    const services = new ServiceCollection()
    services.set(IFileService, stubFs() as never)
    const inst = new InstantiationService(services)
    services.set(IInstantiationService, inst)

    const runSpy = vi.fn()
    const getActionSpy = vi.fn((id: string) => (id === opts.actionId ? { run: runSpy } : undefined))
    let input: FileEditorInput | null = null
    if (opts.hasActive !== false) {
      input = inst.createInstance(FileEditorInput, URI.file('/ws/a.ts'))
      FileEditorRegistry.register(input, { getAction: getActionSpy } as never)
      disposables.push({ dispose: () => input?.dispose() })
    }
    services.set(IEditorGroupsService, {
      _serviceBrand: undefined,
      activeGroup: { activeEditor: input },
    } as never)
    return { inst, runSpy, getActionSpy }
  }

  it('FindInFileAction triggers Monaco actions.find', async () => {
    disposables.push(registerAction2(FindInFileAction))
    const { inst, runSpy, getActionSpy } = setup({ actionId: 'actions.find' })
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+f')).toBe(FindInFileAction.ID)
    await inst.invokeFunction((accessor) => {
      CommandsRegistry.getCommand(FindInFileAction.ID)!.handler(accessor)
    })
    expect(getActionSpy).toHaveBeenCalledWith('actions.find')
    expect(runSpy).toHaveBeenCalledTimes(1)
  })

  it('FindReplaceInFileAction triggers editor.action.startFindReplaceAction', async () => {
    disposables.push(registerAction2(FindReplaceInFileAction))
    const { inst, runSpy } = setup({ actionId: 'editor.action.startFindReplaceAction' })
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+h')).toBe(FindReplaceInFileAction.ID)
    await inst.invokeFunction((accessor) => {
      CommandsRegistry.getCommand(FindReplaceInFileAction.ID)!.handler(accessor)
    })
    expect(runSpy).toHaveBeenCalledTimes(1)
  })

  it('FindNextAction (F3) triggers nextMatchFindAction; no active editor → silent', async () => {
    disposables.push(registerAction2(FindNextAction))
    expect(KeybindingsRegistry.resolveKeybinding('f3')).toBe(FindNextAction.ID)
    const { inst, runSpy } = setup({ actionId: 'editor.action.nextMatchFindAction' })
    await inst.invokeFunction((accessor) => {
      CommandsRegistry.getCommand(FindNextAction.ID)!.handler(accessor)
    })
    expect(runSpy).toHaveBeenCalledTimes(1)

    // Now with no active editor — must not throw.
    const services2 = new ServiceCollection()
    services2.set(IFileService, stubFs() as never)
    services2.set(IEditorGroupsService, {
      _serviceBrand: undefined,
      activeGroup: { activeEditor: null },
    } as never)
    const inst2 = new InstantiationService(services2)
    services2.set(IInstantiationService, inst2)
    await expect(
      Promise.resolve(
        inst2.invokeFunction((accessor) => {
          CommandsRegistry.getCommand(FindNextAction.ID)!.handler(accessor)
        }),
      ),
    ).resolves.not.toThrow()
  })
})
