import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  EditorInput,
  IEditorGroupsService,
  InstantiationService,
  IQuickInputService,
  IWorkspaceService,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  URI,
  registerAction2,
  type IEditorPart,
  type IDisposable,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  CopyEditorGroupToWindowAction,
  CopyEditorToWindowAction,
  MoveEditorGroupToMainWindowAction,
  MoveEditorGroupToWindowAction,
  MoveEditorToMainWindowAction,
  MoveEditorToWindowAction,
} from '../auxiliaryEditorActions.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { IAuxiliaryEditorWindowService } from '../../services/windows/auxiliaryEditorWindowService.js'
import {
  IWorkbenchWindowService,
  type IWorkbenchWindow,
} from '../../services/windows/workbenchWindowService.js'

class TestInput extends EditorInput {
  constructor(private readonly _path: string) {
    super()
  }
  get typeId(): string {
    return 'aux.test'
  }
  get resource(): URI {
    return URI.from({ scheme: 'aux-test', path: this._path })
  }
  getName(): string {
    return this._path
  }
  override serialize(): unknown {
    return { path: this._path }
  }
}

const disposables: IDisposable[] = []
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
})

function makeAux() {
  return {
    moveEditorToMainWindow: vi.fn(() => true),
    moveGroupToMainWindow: vi.fn(() => true),
    openEditorInWindow: vi.fn(() => true),
    openGroupInWindow: vi.fn(() => true),
  }
}

interface InvokeOptions {
  readonly windows?: readonly IWorkbenchWindow[]
  readonly picked?: IWorkbenchWindow
  readonly quickInput?: { pick: ReturnType<typeof vi.fn> }
}

async function invoke(
  actionId: string,
  groups: EditorGroupsService,
  aux: ReturnType<typeof makeAux>,
  arg?: unknown,
  options: InvokeOptions = {},
): Promise<void> {
  const pick =
    options.quickInput?.pick ??
    vi.fn(async (items: Array<{ target: IWorkbenchWindow }>) =>
      options.picked ? items.find((item) => item.target === options.picked) : undefined,
    )
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groups)
  services.set(IAuxiliaryEditorWindowService, aux as never)
  services.set(IWorkbenchWindowService, { windows: options.windows ?? [] } as never)
  services.set(IQuickInputService, { pick } as never)
  services.set(IWorkspaceService, { current: null } as never)
  const inst = new InstantiationService(services)
  await inst.invokeFunction((accessor: ServicesAccessor) =>
    CommandsRegistry.getCommand(actionId)!.handler(accessor, arg),
  )
  inst.dispose()
}

function makeWindow(part: IEditorPart, title = ''): IWorkbenchWindow {
  return {
    id: part.id,
    isMain: part.isMain,
    part,
    document: { title } as Document,
    window: {} as Window,
    token: part.isMain ? undefined : `token-${part.id}`,
  }
}

function menuCommandsFor(menuId: MenuId, overrides: Record<string, unknown>): string[] {
  const ctx = new ContextKeyService().createScoped(overrides)
  disposables.push(ctx)
  return MenuRegistry.getMenuItems(menuId, ctx)
    .filter((entry): entry is { command: string } => 'command' in entry)
    .map((entry) => entry.command)
}

/** All entries regardless of `when`, for static placement assertions. */
function menuEntriesFor(menuId: MenuId): Array<[string, string | undefined]> {
  return MenuRegistry.getMenuItems(menuId)
    .filter((entry): entry is { command: string; group?: string } => 'command' in entry)
    .map((entry) => [entry.command, entry.group])
}

function registerActions(): void {
  disposables.push(
    registerAction2(MoveEditorToMainWindowAction),
    registerAction2(MoveEditorGroupToMainWindowAction),
    registerAction2(MoveEditorToWindowAction),
    registerAction2(CopyEditorToWindowAction),
    registerAction2(MoveEditorGroupToWindowAction),
    registerAction2(CopyEditorGroupToWindowAction),
  )
}

describe('auxiliary editor window actions', () => {
  it('registers the command ids and menu placements', () => {
    registerActions()
    expect(CommandsRegistry.getCommand(MoveEditorToMainWindowAction.ID)).toBeDefined()
    expect(CommandsRegistry.getCommand(MoveEditorGroupToMainWindowAction.ID)).toBeDefined()

    const tabMenu = MenuRegistry.getMenuItems(MenuId.EditorTabContext)
      .filter((entry): entry is { command: string; group?: string } => 'command' in entry)
      .map((entry) => [entry.command, entry.group])
    expect(tabMenu).toContainEqual([MoveEditorToMainWindowAction.ID, '2_newWindow'])

    const tabsBarMenu = MenuRegistry.getMenuItems(MenuId.EditorTabsBarContext)
      .filter((entry): entry is { command: string; group?: string } => 'command' in entry)
      .map((entry) => [entry.command, entry.group])
    expect(tabsBarMenu).toContainEqual([MoveEditorGroupToMainWindowAction.ID, '2_newWindow'])
  })

  it('shows the tab-menu entries only for auxiliary windows', () => {
    registerActions()
    const aux = { isAuxiliaryEditorWindow: true, hasActiveEditor: true }
    const main = { isAuxiliaryEditorWindow: false, hasActiveEditor: true }

    expect(menuCommandsFor(MenuId.EditorTabContext, aux)).toContain(MoveEditorToMainWindowAction.ID)
    expect(menuCommandsFor(MenuId.EditorTabContext, main)).not.toContain(
      MoveEditorToMainWindowAction.ID,
    )
    expect(menuCommandsFor(MenuId.EditorTabsBarContext, aux)).toContain(
      MoveEditorGroupToMainWindowAction.ID,
    )
    expect(menuCommandsFor(MenuId.EditorTabsBarContext, main)).not.toContain(
      MoveEditorGroupToMainWindowAction.ID,
    )
  })

  it('gates the command palette rows on the root window-kind key', () => {
    registerActions()
    const ctx = new ContextKeyService()
    disposables.push(ctx)
    const auxWindow = ctx.createKey<boolean>('isAuxiliaryEditorWindow', false)
    ctx.createKey<boolean>('hasActiveEditor', true)

    const commands = (): string[] =>
      MenuRegistry.getMenuItems(MenuId.CommandPalette, ctx)
        .filter((entry): entry is { command: string } => 'command' in entry)
        .map((entry) => entry.command)

    expect(commands()).not.toContain(MoveEditorToMainWindowAction.ID)
    expect(commands()).not.toContain(MoveEditorGroupToMainWindowAction.ID)
    auxWindow.set(true)
    expect(commands()).toContain(MoveEditorToMainWindowAction.ID)
    expect(commands()).toContain(MoveEditorGroupToMainWindowAction.ID)
  })

  it('moves the tab targeted by explicit menu arguments', async () => {
    registerActions()
    const groups = new EditorGroupsService()
    disposables.push(groups)
    const input = new TestInput('/explicit')
    const group = groups.mainPart.activeGroup
    group.openEditor(input)
    const aux = makeAux()

    await invoke(MoveEditorToMainWindowAction.ID, groups, aux, {
      groupId: group.id,
      editorId: input.id,
    })
    expect(aux.moveEditorToMainWindow).toHaveBeenCalledWith(input, group)
  })

  it('falls back to the active editor for command-palette invocations', async () => {
    registerActions()
    const groups = new EditorGroupsService()
    disposables.push(groups)
    const input = new TestInput('/active')
    groups.mainPart.activeGroup.openEditor(input)
    const aux = makeAux()

    await invoke(MoveEditorToMainWindowAction.ID, groups, aux)
    expect(aux.moveEditorToMainWindow).toHaveBeenCalledWith(input, groups.mainPart.activeGroup)
  })

  it('does nothing for stale tab arguments', async () => {
    registerActions()
    const groups = new EditorGroupsService()
    disposables.push(groups)
    const input = new TestInput('/closed')
    groups.mainPart.activeGroup.openEditor(input)
    const aux = makeAux()

    await invoke(MoveEditorToMainWindowAction.ID, groups, aux, {
      groupId: groups.mainPart.activeGroup.id,
      editorId: 'missing',
    })
    expect(aux.moveEditorToMainWindow).not.toHaveBeenCalled()
  })

  it('moves the group targeted by the tab-bar menu', async () => {
    registerActions()
    const groups = new EditorGroupsService()
    disposables.push(groups)
    groups.mainPart.activeGroup.openEditor(new TestInput('/group'))
    const aux = makeAux()

    await invoke(MoveEditorGroupToMainWindowAction.ID, groups, aux, {
      groupId: groups.mainPart.activeGroup.id,
    })
    expect(aux.moveGroupToMainWindow).toHaveBeenCalledWith(groups.mainPart.activeGroup)
  })

  it('registers the into-window commands and menu placements', () => {
    registerActions()
    for (const id of [
      MoveEditorToWindowAction.ID,
      CopyEditorToWindowAction.ID,
      MoveEditorGroupToWindowAction.ID,
      CopyEditorGroupToWindowAction.ID,
    ]) {
      expect(CommandsRegistry.getCommand(id)).toBeDefined()
    }

    const tabMenu = menuEntriesFor(MenuId.EditorTabContext)
    expect(tabMenu).toContainEqual([MoveEditorToWindowAction.ID, '2_newWindow'])
    expect(tabMenu).toContainEqual([CopyEditorToWindowAction.ID, '2_newWindow'])

    const tabsBarMenu = menuEntriesFor(MenuId.EditorTabsBarContext)
    expect(tabsBarMenu).toContainEqual([MoveEditorGroupToWindowAction.ID, '2_newWindow'])
    expect(tabsBarMenu).toContainEqual([CopyEditorGroupToWindowAction.ID, '2_newWindow'])
  })

  it('gates the into-window entries on hasOtherEditorWindows', () => {
    registerActions()
    const withOther = { hasOtherEditorWindows: true, hasActiveEditor: true }
    const without = { hasOtherEditorWindows: false, hasActiveEditor: true }

    expect(menuCommandsFor(MenuId.EditorTabContext, withOther)).toEqual(
      expect.arrayContaining([MoveEditorToWindowAction.ID, CopyEditorToWindowAction.ID]),
    )
    expect(menuCommandsFor(MenuId.EditorTabContext, without)).not.toContain(
      MoveEditorToWindowAction.ID,
    )
    expect(menuCommandsFor(MenuId.EditorTabsBarContext, withOther)).toEqual(
      expect.arrayContaining([MoveEditorGroupToWindowAction.ID, CopyEditorGroupToWindowAction.ID]),
    )
    expect(menuCommandsFor(MenuId.EditorTabsBarContext, without)).not.toContain(
      MoveEditorGroupToWindowAction.ID,
    )
    expect(menuCommandsFor(MenuId.CommandPalette, withOther)).toContain(MoveEditorToWindowAction.ID)
    expect(menuCommandsFor(MenuId.CommandPalette, without)).not.toContain(
      MoveEditorToWindowAction.ID,
    )
  })

  it('offers only other windows and moves the picked tab', async () => {
    registerActions()
    const groups = new EditorGroupsService()
    disposables.push(groups)
    const input = new TestInput('/pick-window')
    const group = groups.mainPart.activeGroup
    group.openEditor(input)
    const auxPart = groups.createAuxiliaryPart({ activate: false })
    const mainWindow = makeWindow(groups.mainPart)
    const auxWindow = makeWindow(auxPart, 'notes.md — 编辑器窗口')
    const aux = makeAux()
    const pick = vi.fn(async (items: Array<{ target: IWorkbenchWindow }>) =>
      items.find((item) => item.target === auxWindow),
    )

    await invoke(
      MoveEditorToWindowAction.ID,
      groups,
      aux,
      { groupId: group.id, editorId: input.id },
      { windows: [mainWindow, auxWindow], quickInput: { pick } },
    )

    const items = pick.mock.calls[0]?.[0] as Array<{ target: IWorkbenchWindow }>
    expect(items.map((item) => item.target)).toEqual([auxWindow])
    expect(aux.openEditorInWindow).toHaveBeenCalledWith(input, group, auxWindow, { mode: 'move' })
  })

  it('does nothing when the window picker is cancelled', async () => {
    registerActions()
    const groups = new EditorGroupsService()
    disposables.push(groups)
    const input = new TestInput('/cancel-pick')
    const group = groups.mainPart.activeGroup
    group.openEditor(input)
    const auxPart = groups.createAuxiliaryPart({ activate: false })
    const aux = makeAux()

    await invoke(
      MoveEditorToWindowAction.ID,
      groups,
      aux,
      { groupId: group.id, editorId: input.id },
      {
        windows: [makeWindow(groups.mainPart), makeWindow(auxPart)],
        quickInput: { pick: vi.fn(async () => undefined) },
      },
    )
    expect(aux.openEditorInWindow).not.toHaveBeenCalled()
  })

  it('does not open the window picker for an empty group', async () => {
    registerActions()
    const groups = new EditorGroupsService()
    disposables.push(groups)
    const group = groups.mainPart.activeGroup
    const auxPart = groups.createAuxiliaryPart({ activate: false })
    const aux = makeAux()
    const pick = vi.fn(async () => undefined)

    await invoke(
      MoveEditorGroupToWindowAction.ID,
      groups,
      aux,
      { groupId: group.id },
      { windows: [makeWindow(groups.mainPart), makeWindow(auxPart)], quickInput: { pick } },
    )

    expect(pick).not.toHaveBeenCalled()
    expect(aux.openGroupInWindow).not.toHaveBeenCalled()
  })

  it('copies the picked group into the chosen window', async () => {
    registerActions()
    const groups = new EditorGroupsService()
    disposables.push(groups)
    const group = groups.mainPart.activeGroup
    group.openEditor(new TestInput('/group-pick'))
    const auxPart = groups.createAuxiliaryPart({ activate: false })
    const auxWindow = makeWindow(auxPart)
    const aux = makeAux()

    await invoke(
      CopyEditorGroupToWindowAction.ID,
      groups,
      aux,
      { groupId: group.id },
      { windows: [makeWindow(groups.mainPart), auxWindow], picked: auxWindow },
    )
    expect(aux.openGroupInWindow).toHaveBeenCalledWith(group, auxWindow, { mode: 'copy' })
  })
})
