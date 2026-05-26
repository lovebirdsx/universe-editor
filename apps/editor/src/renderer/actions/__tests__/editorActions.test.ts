import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  EditorInput,
  IContextKeyService,
  IDialogService,
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
  CloseEditorsInGroupAction,
  CloseEditorsToTheLeftAction,
  CloseEditorsToTheRightAction,
  CloseOtherEditorsAction,
  CloseUnmodifiedEditorsAction,
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
import { resolveTargetEditor } from '../editorActionHelpers.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { UntitledEditorInput } from '../../services/editor/UntitledEditorInput.js'

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

interface FakeDialog {
  confirm: ReturnType<typeof vi.fn>
}

function makeFakeDialog(choice: 'primary' | 'secondary' | 'cancel' = 'secondary'): FakeDialog {
  return { confirm: vi.fn().mockResolvedValue({ choice }) }
}

function makeAccessor(groups: EditorGroupsService, dialog?: FakeDialog) {
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groups)
  services.set(IContextKeyService, new ContextKeyService())
  if (dialog) services.set(IDialogService, dialog as unknown as IDialogService)
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

async function execWithArg(
  actionCtor: new () => unknown,
  groups: EditorGroupsService,
  arg: unknown,
  dialog?: FakeDialog,
): Promise<void> {
  const disposables: IDisposable[] = []
  disposables.push(registerAction2(actionCtor as never))
  const inst = makeAccessor(groups, dialog)
  let promise: unknown
  inst.invokeFunction((accessor) => {
    const id = (actionCtor as unknown as { ID: string }).ID
    const cmd = CommandsRegistry.getCommand(id)!
    promise = cmd.handler(accessor, arg)
  })
  await promise
  for (const d of disposables) d.dispose()
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

  it('CloseActiveEditor closes the active editor in the active group', async () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    await exec(CloseActiveEditorAction, svc)
    expect(svc.activeGroup.editors).toHaveLength(1)
    expect(svc.activeGroup.activeEditor).toBe(a)
  })

  it('CloseAllEditors closes all groups', async () => {
    const svc = new EditorGroupsService()
    svc.activeGroup.openEditor(new TestEditor('a'))
    svc.activeGroup.openEditor(new TestEditor('b'))
    await exec(CloseAllEditorsAction, svc)
    expect(svc.activeGroup.editors).toHaveLength(0)
  })

  it('CloseOtherEditors keeps only the active editor', async () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    const c = new TestEditor('c')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    svc.activeGroup.openEditor(c)
    svc.activeGroup.setActive(b)
    await exec(CloseOtherEditorsAction, svc)
    expect(svc.activeGroup.editors).toHaveLength(1)
    expect(svc.activeGroup.activeEditor).toBe(b)
  })

  it('CloseEditorsToTheRight closes only editors to the right', async () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    const c = new TestEditor('c')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    svc.activeGroup.openEditor(c)
    svc.activeGroup.setActive(b)
    await exec(CloseEditorsToTheRightAction, svc)
    expect(svc.activeGroup.editors.map((e) => (e as TestEditor).getName())).toEqual(['a', 'b'])
  })

  it('CloseEditorsToTheLeft closes only editors to the left', async () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    const c = new TestEditor('c')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    svc.activeGroup.openEditor(c)
    svc.activeGroup.setActive(b)
    await exec(CloseEditorsToTheLeftAction, svc)
    expect(svc.activeGroup.editors.map((e) => (e as TestEditor).getName())).toEqual(['b', 'c'])
  })

  it('CloseUnmodifiedEditors keeps dirty editors and closes the rest', () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    const c = new TestEditor('c')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    svc.activeGroup.openEditor(c)
    b.isDirty = true
    exec(CloseUnmodifiedEditorsAction, svc)
    expect(svc.activeGroup.editors.map((e) => (e as TestEditor).getName())).toEqual(['b'])
  })

  it('CloseEditorsInGroup closes the editors of the target group only', async () => {
    const svc = new EditorGroupsService()
    const g1 = svc.activeGroup
    const g2 = svc.addGroup(g1, 3 /* Right */)
    g1.openEditor(new TestEditor('a'))
    g1.openEditor(new TestEditor('b'))
    g2.openEditor(new TestEditor('c'))
    svc.activateGroup(g1)
    await exec(CloseEditorsInGroupAction, svc)
    expect(g1.editors).toHaveLength(0)
    expect(g2.editors).toHaveLength(1)
  })

  it('CloseEditorsInGroup with a groupId arg targets that group regardless of active group', async () => {
    const svc = new EditorGroupsService()
    const g1 = svc.activeGroup
    const g2 = svc.addGroup(g1, 3)
    const cEditor = new TestEditor('c')
    g1.openEditor(new TestEditor('a'))
    g1.openEditor(new TestEditor('b'))
    g2.openEditor(cEditor)
    svc.activateGroup(g1)
    await execWithArg(CloseEditorsInGroupAction, svc, {
      groupId: g2.id,
      resource: cEditor.resource.toJSON(),
    })
    expect(g1.editors).toHaveLength(2)
    expect(g2.editors).toHaveLength(0)
  })

  it('CloseOtherEditors with a resource arg pivots on the right-clicked tab, not the active one', async () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    const c = new TestEditor('c')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    svc.activeGroup.openEditor(c)
    svc.activeGroup.setActive(b) // active is b
    await execWithArg(CloseOtherEditorsAction, svc, {
      groupId: svc.activeGroup.id,
      resource: c.resource.toJSON(),
    })
    // Should keep `c` (the right-clicked tab), not `b`.
    expect(svc.activeGroup.editors).toHaveLength(1)
    expect((svc.activeGroup.editors[0] as TestEditor).getName()).toBe('c')
  })

  it('CloseEditorsInGroup stops at user Cancel on a dirty editor', async () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a') // clean
    const b = new TestEditor('b')
    const c = new TestEditor('c') // clean
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    svc.activeGroup.openEditor(c)
    b.isDirty = true
    const dialog = makeFakeDialog('cancel')
    await execWithArg(CloseEditorsInGroupAction, svc, { groupId: svc.activeGroup.id }, dialog)
    // a closed; b prompted + cancelled → loop breaks; c untouched.
    expect(svc.activeGroup.editors.map((e) => (e as TestEditor).getName())).toEqual(['b', 'c'])
    expect(dialog.confirm).toHaveBeenCalledTimes(1)
  })

  it('resolveTargetEditor falls back to active editor when no arg given', () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    svc.activeGroup.openEditor(a)
    const inst = makeAccessor(svc)
    const result = inst.invokeFunction((accessor) => resolveTargetEditor(accessor, undefined))
    expect(result?.editor).toBe(a)
    expect(result?.group).toBe(svc.activeGroup)
  })

  it('resolveTargetEditor honors groupId + resource across groups', () => {
    const svc = new EditorGroupsService()
    const g1 = svc.activeGroup
    const g2 = svc.addGroup(g1, 3)
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    g1.openEditor(a)
    g2.openEditor(b)
    const inst = makeAccessor(svc)
    const result = inst.invokeFunction((accessor) =>
      resolveTargetEditor(accessor, { groupId: g2.id, resource: b.resource.toJSON() }),
    )
    expect(result?.editor).toBe(b)
    expect(result?.group).toBe(g2)
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
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+pagedown')).toBe(NextEditorAction.ID)
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+pageup')).toBe(PreviousEditorAction.ID)
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

  it('run() focuses the surviving split editor after the other group closes', () => {
    const svc = new EditorGroupsService()
    const first = svc.activeGroup
    const second = svc.addGroup(first, 3 /* Right */)
    const input = Object.create(FileEditorInput.prototype) as FileEditorInput
    first.openEditor(input)
    second.openEditor(input)
    svc.activateGroup(second)

    const firstFocus = vi.fn()
    const secondFocus = vi.fn()
    const firstEditor = { focus: firstFocus } as never
    const secondEditor = { focus: secondFocus } as never
    FileEditorRegistry.register(input, firstEditor)
    FileEditorRegistry.register(input, secondEditor)

    svc.removeGroup(second)
    FileEditorRegistry.unregister(input, secondEditor)
    exec(FocusActiveEditorGroupAction, svc)

    expect(svc.activeGroup).toBe(first)
    expect(firstFocus).toHaveBeenCalledOnce()
    expect(secondFocus).not.toHaveBeenCalled()
  })

  it('run() focuses an untitled editor after a newly split group is immediately closed', async () => {
    const svc = new EditorGroupsService()
    const input = new UntitledEditorInput()
    svc.activeGroup.openEditor(input)

    const focus = vi.fn()
    FileEditorRegistry.register(input, { focus } as never)
    exec(SplitEditorRightAction, svc)
    exec(CloseActiveEditorAction, svc)
    await Promise.resolve()

    expect(svc.groups).toHaveLength(1)
    expect(svc.activeGroup.activeEditor).toBe(input)

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
