import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  EditorInput,
  IEditorGroupsService,
  InstantiationService,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  URI,
  registerAction2,
  type IDisposable,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  MoveEditorGroupToMainWindowAction,
  MoveEditorToMainWindowAction,
} from '../auxiliaryEditorActions.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { IAuxiliaryEditorWindowService } from '../../services/windows/auxiliaryEditorWindowService.js'

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
  }
}

function invoke(
  actionId: string,
  groups: EditorGroupsService,
  aux: ReturnType<typeof makeAux>,
  arg?: unknown,
): void {
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groups)
  services.set(IAuxiliaryEditorWindowService, aux as never)
  const inst = new InstantiationService(services)
  inst.invokeFunction((accessor: ServicesAccessor) => {
    CommandsRegistry.getCommand(actionId)!.handler(accessor, arg)
  })
  inst.dispose()
}

function menuCommandsFor(menuId: MenuId, overrides: Record<string, unknown>): string[] {
  const ctx = new ContextKeyService().createScoped(overrides)
  disposables.push(ctx)
  return MenuRegistry.getMenuItems(menuId, ctx)
    .filter((entry): entry is { command: string } => 'command' in entry)
    .map((entry) => entry.command)
}

function registerActions(): void {
  disposables.push(
    registerAction2(MoveEditorToMainWindowAction),
    registerAction2(MoveEditorGroupToMainWindowAction),
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

  it('moves the tab targeted by explicit menu arguments', () => {
    registerActions()
    const groups = new EditorGroupsService()
    disposables.push(groups)
    const input = new TestInput('/explicit')
    const group = groups.mainPart.activeGroup
    group.openEditor(input)
    const aux = makeAux()

    invoke(MoveEditorToMainWindowAction.ID, groups, aux, {
      groupId: group.id,
      editorId: input.id,
    })
    expect(aux.moveEditorToMainWindow).toHaveBeenCalledWith(input, group)
  })

  it('falls back to the active editor for command-palette invocations', () => {
    registerActions()
    const groups = new EditorGroupsService()
    disposables.push(groups)
    const input = new TestInput('/active')
    groups.mainPart.activeGroup.openEditor(input)
    const aux = makeAux()

    invoke(MoveEditorToMainWindowAction.ID, groups, aux)
    expect(aux.moveEditorToMainWindow).toHaveBeenCalledWith(input, groups.mainPart.activeGroup)
  })

  it('does nothing for stale tab arguments', () => {
    registerActions()
    const groups = new EditorGroupsService()
    disposables.push(groups)
    const input = new TestInput('/closed')
    groups.mainPart.activeGroup.openEditor(input)
    const aux = makeAux()

    invoke(MoveEditorToMainWindowAction.ID, groups, aux, {
      groupId: groups.mainPart.activeGroup.id,
      editorId: 'missing',
    })
    expect(aux.moveEditorToMainWindow).not.toHaveBeenCalled()
  })

  it('moves the group targeted by the tab-bar menu', () => {
    registerActions()
    const groups = new EditorGroupsService()
    disposables.push(groups)
    groups.mainPart.activeGroup.openEditor(new TestInput('/group'))
    const aux = makeAux()

    invoke(MoveEditorGroupToMainWindowAction.ID, groups, aux, {
      groupId: groups.mainPart.activeGroup.id,
    })
    expect(aux.moveGroupToMainWindow).toHaveBeenCalledWith(groups.mainPart.activeGroup)
  })
})
