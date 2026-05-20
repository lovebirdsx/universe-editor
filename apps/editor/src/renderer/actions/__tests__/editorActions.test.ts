import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  EditorInput,
  IEditorGroupsService,
  InstantiationService,
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  URI,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import {
  CloseActiveEditorAction,
  CloseAllEditorsAction,
  CloseEditorsToTheRightAction,
  CloseOtherEditorsAction,
  FirstEditorInGroupAction,
  FocusActiveEditorGroupAction,
  FocusFirstGroupAction,
  FocusLastGroupAction,
  FocusNextGroupAction,
  FocusPreviousGroupAction,
  LastEditorInGroupAction,
  NextEditorAction,
  PreviousEditorAction,
  SplitEditorDownAction,
  SplitEditorLeftAction,
  SplitEditorRightAction,
  SplitEditorUpAction,
} from '../editorActions.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'

class TestEditor extends EditorInput {
  constructor(private readonly _name: string) {
    super()
  }
  get typeId() {
    return 'test'
  }
  get resource() {
    return URI.file(`D:/${this._name}.txt`)
  }
  getName() {
    return this._name
  }
}

function makeAccessor(groups: EditorGroupsService) {
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groups)
  return new InstantiationService(services)
}

function exec(actionCtor: new () => unknown, groups: EditorGroupsService): unknown {
  const disposables: IDisposable[] = []
  disposables.push(registerAction2(actionCtor as never))
  const inst = makeAccessor(groups)
  let result: unknown
  inst.invokeFunction((accessor) => {
    const id = (actionCtor as unknown as { ID: string }).ID
    const cmd = CommandsRegistry.getCommand(id)!
    result = cmd.handler(accessor)
  })
  for (const d of disposables) d.dispose()
  return result
}

describe('Built-in editor Action2s', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('registerAction2(CloseActiveEditorAction) wires command + keybinding + palette', () => {
    disposables.push(registerAction2(CloseActiveEditorAction))
    expect(CommandsRegistry.getCommand(CloseActiveEditorAction.ID)).toBeDefined()
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+w')).toBe(CloseActiveEditorAction.ID)
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === CloseActiveEditorAction.ID,
      ),
    ).toBe(true)
  })

  it('CloseActiveEditor closes the active editor in the active group', () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    exec(CloseActiveEditorAction, svc)
    expect(svc.activeGroup.editors).toHaveLength(1)
    expect(svc.activeGroup.activeEditor).toBe(a)
  })

  it('CloseAllEditors closes all groups', () => {
    const svc = new EditorGroupsService()
    svc.activeGroup.openEditor(new TestEditor('a'))
    svc.activeGroup.openEditor(new TestEditor('b'))
    exec(CloseAllEditorsAction, svc)
    expect(svc.activeGroup.editors).toHaveLength(0)
  })

  it('CloseOtherEditors keeps only the active editor', () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    const c = new TestEditor('c')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    svc.activeGroup.openEditor(c)
    svc.activeGroup.setActive(b)
    exec(CloseOtherEditorsAction, svc)
    expect(svc.activeGroup.editors).toHaveLength(1)
    expect(svc.activeGroup.activeEditor).toBe(b)
  })

  it('CloseEditorsToTheRight closes only editors to the right', () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    const c = new TestEditor('c')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    svc.activeGroup.openEditor(c)
    svc.activeGroup.setActive(b)
    exec(CloseEditorsToTheRightAction, svc)
    expect(svc.activeGroup.editors.map((e) => (e as TestEditor).getName())).toEqual(['a', 'b'])
  })

  it('NextEditor wraps to first editor', () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    // active is b (last opened)
    exec(NextEditorAction, svc)
    expect(svc.activeGroup.activeEditor).toBe(a)
  })

  it('PreviousEditor wraps to last editor', () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    svc.activeGroup.setActive(a)
    exec(PreviousEditorAction, svc)
    expect(svc.activeGroup.activeEditor).toBe(b)
  })

  it('FirstEditorInGroup activates the first editor', () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    exec(FirstEditorInGroupAction, svc)
    expect(svc.activeGroup.activeEditor).toBe(a)
  })

  it('LastEditorInGroup activates the last editor', () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    svc.activeGroup.setActive(a)
    exec(LastEditorInGroupAction, svc)
    expect(svc.activeGroup.activeEditor).toBe(b)
  })

  it('SplitEditorRight adds a new group with the active editor copied', () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    svc.activeGroup.openEditor(a)
    exec(SplitEditorRightAction, svc)
    expect(svc.groups).toHaveLength(2)
    expect(svc.activeGroup.activeEditor).toBe(a)
  })

  it('SplitEditorDown / Left / Up each create a new group', () => {
    const svc = new EditorGroupsService()
    svc.activeGroup.openEditor(new TestEditor('a'))
    exec(SplitEditorDownAction, svc)
    expect(svc.groups).toHaveLength(2)
    exec(SplitEditorLeftAction, svc)
    expect(svc.groups).toHaveLength(3)
    exec(SplitEditorUpAction, svc)
    expect(svc.groups).toHaveLength(4)
  })

  it('SplitEditorRight does nothing when active group has no editors', () => {
    const svc = new EditorGroupsService()
    exec(SplitEditorRightAction, svc)
    expect(svc.groups).toHaveLength(1)
  })

  it('Split actions all do nothing when active group has no editors', () => {
    const svc = new EditorGroupsService()
    exec(SplitEditorDownAction, svc)
    expect(svc.groups).toHaveLength(1)
    exec(SplitEditorLeftAction, svc)
    expect(svc.groups).toHaveLength(1)
    exec(SplitEditorUpAction, svc)
    expect(svc.groups).toHaveLength(1)
  })

  it('FocusNextGroup activates the next group with wrap', () => {
    const svc = new EditorGroupsService()
    const g1 = svc.activeGroup
    const g2 = svc.addGroup(g1, 3 /* Right */)
    svc.activateGroup(g1)
    exec(FocusNextGroupAction, svc)
    expect(svc.activeGroup).toBe(g2)
    exec(FocusNextGroupAction, svc)
    expect(svc.activeGroup).toBe(g1) // wrap
  })

  it('FocusPreviousGroup activates the previous group with wrap', () => {
    const svc = new EditorGroupsService()
    const g1 = svc.activeGroup
    const g2 = svc.addGroup(g1, 3)
    svc.activateGroup(g1)
    exec(FocusPreviousGroupAction, svc)
    expect(svc.activeGroup).toBe(g2)
  })

  it('FocusFirstGroup activates the first group', () => {
    const svc = new EditorGroupsService()
    const g1 = svc.activeGroup
    const g2 = svc.addGroup(g1, 3)
    svc.activateGroup(g2)
    exec(FocusFirstGroupAction, svc)
    expect(svc.activeGroup).toBe(g1)
  })

  it('FocusLastGroup activates the last group', () => {
    const svc = new EditorGroupsService()
    const g1 = svc.activeGroup
    const g2 = svc.addGroup(g1, 3)
    svc.activateGroup(g1)
    exec(FocusLastGroupAction, svc)
    expect(svc.activeGroup).toBe(g2)
  })

  it('NextEditor + PreviousEditor are registered with the expected keybindings', () => {
    disposables.push(registerAction2(NextEditorAction))
    disposables.push(registerAction2(PreviousEditorAction))
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+tab')).toBe(NextEditorAction.ID)
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+shift+tab')).toBe(PreviousEditorAction.ID)
  })

  it('SplitEditorRight is bound to Ctrl+\\ and is f1', () => {
    disposables.push(registerAction2(SplitEditorRightAction))
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+\\')).toBe(SplitEditorRightAction.ID)
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === SplitEditorRightAction.ID,
      ),
    ).toBe(true)
  })
})

describe('FocusActiveEditorGroupAction', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    FileEditorRegistry._resetForTests()
  })

  it('registers escape keybinding and is f1', () => {
    disposables.push(registerAction2(FocusActiveEditorGroupAction))
    expect(KeybindingsRegistry.resolveKeybinding('escape')).toBe(FocusActiveEditorGroupAction.ID)
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === FocusActiveEditorGroupAction.ID,
      ),
    ).toBe(true)
  })

  it('run() calls focus() on the active Monaco editor when a FileEditorInput is active', () => {
    const svc = new EditorGroupsService()
    // Object.create bypasses DI constructor; instanceof check still passes.
    const input = Object.create(FileEditorInput.prototype) as FileEditorInput
    svc.activeGroup.openEditor(input)

    const focus = vi.fn()
    FileEditorRegistry.register(input, { focus } as never)

    exec(FocusActiveEditorGroupAction, svc)

    expect(focus).toHaveBeenCalledOnce()
  })

  it('run() does not throw when no Monaco editor is registered for the active input', () => {
    const svc = new EditorGroupsService()
    const input = Object.create(FileEditorInput.prototype) as FileEditorInput
    svc.activeGroup.openEditor(input)
    // FileEditorRegistry has no entry → optional-chain must not crash
    expect(() => exec(FocusActiveEditorGroupAction, svc)).not.toThrow()
  })

  it('run() is a no-op when the active editor is not a FileEditorInput', () => {
    const svc = new EditorGroupsService()
    svc.activeGroup.openEditor(new TestEditor('x'))
    expect(() => exec(FocusActiveEditorGroupAction, svc)).not.toThrow()
  })
})
