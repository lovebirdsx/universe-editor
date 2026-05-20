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
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { MonacoModelRegistry } from '../../workbench/editor/monaco/MonacoModelRegistry.js'

describe('FindInFilesAction', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) {
      disposables.pop()?.dispose()
    }
  })

  function makeLayoutService(visible: boolean, focused: boolean) {
    const part = { focus: vi.fn(), isFocused: vi.fn().mockReturnValue(focused) }
    const setVisible = vi.fn()
    const mock = {
      _serviceBrand: undefined,
      getVisible: vi.fn().mockReturnValue(visible),
      setVisible,
      toggleVisible: vi.fn(),
      getPart: vi.fn().mockReturnValue(part),
    } as never
    return { mock, setVisible, part }
  }

  function makeViewsService(activeId: string | undefined) {
    const openViewContainer = vi.fn()
    const mock = {
      _serviceBrand: undefined,
      openViewContainer,
      getActiveViewContainerId: vi.fn().mockReturnValue(activeId),
    } as never
    return { mock, openViewContainer }
  }

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

  it('run() shows SideBar and dispatches focus event when hidden', async () => {
    const layout = makeLayoutService(false, false)
    const views = makeViewsService(undefined)
    const services = new ServiceCollection()
    services.set(ILayoutService, layout.mock)
    services.set(IViewsService, views.mock)
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
    expect(views.openViewContainer).toHaveBeenCalledWith('workbench.view.search')
    expect(layout.setVisible).toHaveBeenCalledWith(PartId.SideBar, true)
    expect(fired).toBe('foo')
  })

  it('run() dispatches focus event when search is visible but SideBar not focused', async () => {
    const layout = makeLayoutService(true, false)
    const views = makeViewsService('workbench.view.search')
    const services = new ServiceCollection()
    services.set(ILayoutService, layout.mock)
    services.set(IViewsService, views.mock)
    const inst = new InstantiationService(services)
    disposables.push(registerAction2(FindInFilesAction))

    let fired: string | null | undefined = 'unset'
    const listener = (e: Event) => {
      fired = (e as CustomEvent<string | null>).detail
    }
    document.addEventListener(SEARCH_FOCUS_INPUT_EVENT, listener)

    await inst.invokeFunction((accessor) => {
      CommandsRegistry.getCommand(FindInFilesAction.ID)!.handler(accessor)
    })

    document.removeEventListener(SEARCH_FOCUS_INPUT_EVENT, listener)
    expect(fired).toBeNull()
    expect(layout.setVisible).not.toHaveBeenCalled()
    expect(views.openViewContainer).not.toHaveBeenCalled()
  })

  it('run() hides SideBar when search is active and SideBar is focused', async () => {
    const layout = makeLayoutService(true, true)
    const views = makeViewsService('workbench.view.search')
    const services = new ServiceCollection()
    services.set(ILayoutService, layout.mock)
    services.set(IViewsService, views.mock)
    const inst = new InstantiationService(services)
    disposables.push(registerAction2(FindInFilesAction))

    let fired: string | null | undefined = 'unset'
    const listener = (e: Event) => {
      fired = (e as CustomEvent<string | null>).detail
    }
    document.addEventListener(SEARCH_FOCUS_INPUT_EVENT, listener)
    await inst.invokeFunction((accessor) => {
      CommandsRegistry.getCommand(FindInFilesAction.ID)!.handler(accessor)
    })
    document.removeEventListener(SEARCH_FOCUS_INPUT_EVENT, listener)

    expect(layout.setVisible).toHaveBeenCalledWith(PartId.SideBar, false)
    expect(views.openViewContainer).not.toHaveBeenCalled()
    expect(fired).toBe('unset')
  })

  it('run() switches to search and dispatches focus event when a different container is active', async () => {
    const layout = makeLayoutService(true, false)
    const views = makeViewsService('workbench.view.explorer')
    const services = new ServiceCollection()
    services.set(ILayoutService, layout.mock)
    services.set(IViewsService, views.mock)
    const inst = new InstantiationService(services)
    disposables.push(registerAction2(FindInFilesAction))

    let fired: string | null | undefined = 'unset'
    const listener = (e: Event) => {
      fired = (e as CustomEvent<string | null>).detail
    }
    document.addEventListener(SEARCH_FOCUS_INPUT_EVENT, listener)
    await inst.invokeFunction((accessor) => {
      CommandsRegistry.getCommand(FindInFilesAction.ID)!.handler(accessor)
    })
    document.removeEventListener(SEARCH_FOCUS_INPUT_EVENT, listener)

    expect(views.openViewContainer).toHaveBeenCalledWith('workbench.view.search')
    expect(layout.setVisible).not.toHaveBeenCalled()
    expect(fired).not.toBe('unset')
  })

  it('run() with no query dispatches null detail', async () => {
    const layout = makeLayoutService(false, false)
    const views = makeViewsService(undefined)
    const services = new ServiceCollection()
    services.set(ILayoutService, layout.mock)
    services.set(IViewsService, views.mock)
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
