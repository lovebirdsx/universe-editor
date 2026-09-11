import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  EditorInput,
  EditorRegistry,
  IContextKeyService,
  IDialogService,
  IEditorGroupsService,
  IFileService,
  InstantiationService,
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  URI,
  ViewContainerLocation,
  registerAction2,
  type IDisposable,
  type IViewDescriptorService,
} from '@universe-editor/platform'
import {
  buildRecentTargetPickItems,
  computeInitialSelectionIndex,
  CloseActiveEditorAction,
  CloseActivePinnedEditorAction,
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
  MoveEditorLeftInGroupAction,
  MoveEditorRightInGroupAction,
  NextEditorAction,
  PinEditorAction,
  PreviousEditorAction,
  QuickOpenRecentEditorAction,
  QuickOpenRecentEditorReverseAction,
  SplitEditorDownAction,
  SplitEditorLeftAction,
  SplitEditorRightAction,
  SplitEditorUpAction,
  UnpinEditorAction,
} from '../editorActions.js'
import { resolveTargetEditor } from '../editorActionHelpers.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { UntitledEditorInput } from '../../services/editor/UntitledEditorInput.js'
import type {
  IRecentTargetsService,
  RecentTarget,
} from '../../services/editor/RecentTargetsService.js'

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

// Shares another editor's resource but carries a namespaced id, mirroring an
// image preview vs. the text view of the same file.
class TestAliasEditor extends EditorInput {
  constructor(
    private readonly _name: string,
    private readonly _id: string,
  ) {
    super()
  }
  get typeId() {
    return 'test.alias'
  }
  get resource() {
    return URI.file(`D:/${this._name}.txt`)
  }
  override get id() {
    return this._id
  }
  getName() {
    return this._name
  }
}

class CloneableEditor extends EditorInput {
  static readonly TYPE_ID = 'cloneable-test'

  constructor(private readonly _name: string) {
    super()
  }
  get typeId() {
    return CloneableEditor.TYPE_ID
  }
  get resource() {
    return URI.file(`D:/${this._name}.txt`)
  }
  getName() {
    return this._name
  }
  override serialize(): { name: string } {
    return { name: this._name }
  }
  static deserialize(data: unknown): CloneableEditor | null {
    const d = data as { name?: string } | null
    return d?.name ? new CloneableEditor(d.name) : null
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

  it('CloseUnmodifiedEditors keeps dirty editors and closes the rest', async () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    const c = new TestEditor('c')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    svc.activeGroup.openEditor(c)
    b.isDirty = true
    await exec(CloseUnmodifiedEditorsAction, svc)
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

  it('resolveTargetEditor picks the exact tab by editorId when two share a URI', () => {
    const svc = new EditorGroupsService()
    const text = new TestEditor('shared')
    const alias = new TestAliasEditor('shared', 'alias:shared')
    svc.activeGroup.openEditor(text)
    svc.activeGroup.openEditor(alias)
    // Both editors report the same resource; only editorId disambiguates them.
    expect(text.resource.toString()).toBe(alias.resource.toString())
    const inst = makeAccessor(svc)
    const result = inst.invokeFunction((accessor) =>
      resolveTargetEditor(accessor, {
        groupId: svc.activeGroup.id,
        editorId: alias.id,
        resource: text.resource.toJSON(),
      }),
    )
    expect(result?.editor).toBe(alias)
  })

  it('resolveTargetEditor falls back to resource when editorId is absent', () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('only')
    svc.activeGroup.openEditor(a)
    const inst = makeAccessor(svc)
    const result = inst.invokeFunction((accessor) =>
      resolveTargetEditor(accessor, { resource: a.resource.toJSON() }),
    )
    expect(result?.editor).toBe(a)
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

  it('MoveEditorLeftInGroup moves the active editor one tab left and keeps it active', () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    const c = new TestEditor('c')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    svc.activeGroup.openEditor(c)
    svc.activeGroup.setActive(b)
    exec(MoveEditorLeftInGroupAction, svc)
    expect(svc.activeGroup.editors.map((e) => (e as TestEditor).getName())).toEqual(['b', 'a', 'c'])
    expect(svc.activeGroup.activeEditor).toBe(b)
  })

  it('MoveEditorRightInGroup moves the active editor one tab right and keeps it active', () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    const c = new TestEditor('c')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    svc.activeGroup.openEditor(c)
    svc.activeGroup.setActive(b)
    exec(MoveEditorRightInGroupAction, svc)
    expect(svc.activeGroup.editors.map((e) => (e as TestEditor).getName())).toEqual(['a', 'c', 'b'])
    expect(svc.activeGroup.activeEditor).toBe(b)
  })

  it('MoveEditorLeftInGroup / MoveEditorRightInGroup no-op at group edges', () => {
    const svc = new EditorGroupsService()
    const a = new TestEditor('a')
    const b = new TestEditor('b')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)

    svc.activeGroup.setActive(a)
    exec(MoveEditorLeftInGroupAction, svc)
    expect(svc.activeGroup.editors.map((e) => (e as TestEditor).getName())).toEqual(['a', 'b'])
    expect(svc.activeGroup.activeEditor).toBe(a)

    svc.activeGroup.setActive(b)
    exec(MoveEditorRightInGroupAction, svc)
    expect(svc.activeGroup.editors.map((e) => (e as TestEditor).getName())).toEqual(['a', 'b'])
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

  it('SplitEditorRight clones serializable editor inputs for the new group', () => {
    const reg = EditorRegistry.registerEditorProvider({
      typeId: CloneableEditor.TYPE_ID,
      componentKey: 'file',
      deserialize: (data) => CloneableEditor.deserialize(data),
    })
    try {
      const svc = new EditorGroupsService()
      const a = new CloneableEditor('a')
      const first = svc.activeGroup
      first.openEditor(a)
      exec(SplitEditorRightAction, svc)
      expect(svc.groups).toHaveLength(2)
      expect(first.activeEditor).toBe(a)
      expect(svc.activeGroup.activeEditor).not.toBe(a)
      expect(svc.activeGroup.activeEditor?.matches(a)).toBe(true)
    } finally {
      reg.dispose()
    }
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

  it('FocusNextGroup calls focus() on a self-focusing input that is not in FileEditorRegistry', () => {
    const svc = new EditorGroupsService()
    const g1 = svc.activeGroup
    const g2 = svc.addGroup(g1, 3 /* Right */)
    // Mirrors AcpSessionEditorInput: self-handles focus(), never registers Monaco.
    const session = new TestEditor('session')
    const focus = vi.fn(() => true)
    session.focus = focus
    g2.openEditor(session)
    svc.activateGroup(g1)
    exec(FocusNextGroupAction, svc)
    expect(svc.activeGroup).toBe(g2)
    expect(focus).toHaveBeenCalledOnce()
  })

  it('FocusNextGroup focuses the registered file editor of the target group', () => {
    const svc = new EditorGroupsService()
    const g1 = svc.activeGroup
    const g2 = svc.addGroup(g1, 3 /* Right */)
    const input = Object.create(FileEditorInput.prototype) as FileEditorInput
    g2.openEditor(input)
    svc.activateGroup(g1)
    const focus = vi.fn()
    FileEditorRegistry.register(input, { focus } as never, g2.id)
    try {
      exec(FocusNextGroupAction, svc)
      expect(svc.activeGroup).toBe(g2)
      expect(focus).toHaveBeenCalledOnce()
    } finally {
      FileEditorRegistry._resetForTests()
    }
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

  it('MoveEditorLeftInGroup + MoveEditorRightInGroup are registered with the expected keybindings', () => {
    disposables.push(registerAction2(MoveEditorLeftInGroupAction))
    disposables.push(registerAction2(MoveEditorRightInGroupAction))
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+shift+pageup')).toBe(
      MoveEditorLeftInGroupAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+shift+pagedown')).toBe(
      MoveEditorRightInGroupAction.ID,
    )
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === MoveEditorLeftInGroupAction.ID,
      ),
    ).toBe(true)
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === MoveEditorRightInGroupAction.ID,
      ),
    ).toBe(true)
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

  describe('sticky (pinned) tab protection', () => {
    it('PinEditor / UnpinEditor share the Ctrl+K Shift+Enter chord', () => {
      disposables.push(registerAction2(PinEditorAction))
      disposables.push(registerAction2(UnpinEditorAction))
      // The first stroke enters chord mode; the second resolves to one of the
      // two actions (the when-clauses make them mutually exclusive at runtime).
      const first = KeybindingsRegistry.resolveKeystroke('ctrl+k')
      expect(first).toMatchObject({ kind: 'enter-chord', pending: ['ctrl+k'] })
      const second = KeybindingsRegistry.resolveKeystroke('shift+enter', undefined, ['ctrl+k'])
      expect(second.kind).toBe('execute')
      expect(
        second.kind === 'execute' &&
          [PinEditorAction.ID, UnpinEditorAction.ID].includes(second.command),
      ).toBe(true)
    })

    it('keyboard CloseActiveEditor skips a sticky tab and activates the next non-sticky editor', async () => {
      const svc = new EditorGroupsService()
      const s = new TestEditor('s')
      const a = new TestEditor('a')
      svc.activeGroup.openEditor(a)
      svc.activeGroup.openEditor(s)
      svc.activeGroup.stickEditor(s)
      svc.activeGroup.setActive(s)

      await exec(CloseActiveEditorAction, svc)

      expect(svc.activeGroup.editors).toHaveLength(2)
      expect(svc.activeGroup.activeEditor).toBe(a)
    })

    it('a menu close (arg present) force-closes a sticky tab', async () => {
      const svc = new EditorGroupsService()
      const s = new TestEditor('s')
      svc.activeGroup.openEditor(s)
      svc.activeGroup.stickEditor(s)

      await execWithArg(CloseActiveEditorAction, svc, {
        groupId: svc.activeGroup.id,
        resource: s.resource.toJSON(),
      })

      expect(svc.activeGroup.editors).toHaveLength(0)
    })

    it('CloseActivePinnedEditor closes the sticky active editor and sits in the palette', async () => {
      const svc = new EditorGroupsService()
      const s = new TestEditor('s')
      const a = new TestEditor('a')
      svc.activeGroup.openEditor(s)
      svc.activeGroup.openEditor(a)
      svc.activeGroup.stickEditor(s)
      svc.activeGroup.setActive(s)

      disposables.push(registerAction2(CloseActivePinnedEditorAction))
      expect(
        MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
          (i) => 'command' in i && i.command === CloseActivePinnedEditorAction.ID,
        ),
      ).toBe(true)

      const inst = makeAccessor(svc)
      await inst.invokeFunction(async (accessor) => {
        await CommandsRegistry.getCommand(CloseActivePinnedEditorAction.ID)!.handler(accessor)
      })

      expect(svc.activeGroup.editors).toHaveLength(1)
      expect(svc.activeGroup.editors[0]).toBe(a)
    })
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
    const input = new FileEditorInput(URI.file('D:/x.txt'), {} as IFileService)
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

// ---------------------------------------------------------------------------
// Ctrl+Tab picker: editors and views in one recency list
// ---------------------------------------------------------------------------

describe('quick-open recent targets', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length) disposables.pop()!.dispose()
  })

  const explorerContainer = {
    id: 'workbench.view.explorer',
    label: 'Explorer',
    icon: 'files',
    order: 0,
    location: ViewContainerLocation.SideBar,
  }

  function makeViewDescriptors(
    containerByView: Record<string, typeof explorerContainer | undefined>,
  ): IViewDescriptorService {
    return {
      getViewContainerByViewId: (viewId: string) => containerByView[viewId],
    } as unknown as IViewDescriptorService
  }

  function makeRecentTargets(targets: readonly RecentTarget[]): IRecentTargetsService {
    return { getRecentTargets: () => targets } as IRecentTargetsService
  }

  function viewTarget(id: string, icon?: string): RecentTarget {
    return {
      kind: 'view',
      descriptor: {
        id,
        name: id,
        containerId: explorerContainer.id,
        componentKey: id,
        order: 0,
        ...(icon ? { icon } : {}),
      },
    }
  }

  it('view rows opt out of removal and carry their container label', () => {
    const items = buildRecentTargetPickItems(
      makeRecentTargets([viewTarget('tree', 'files')]),
      makeViewDescriptors({ tree: explorerContainer }),
    )
    expect(items).toHaveLength(1)
    expect(items[0]!.removable).toBe(false)
    expect(items[0]!.description).toBe('Explorer')
    expect(items[0]!.iconId).toBe('files')
  })

  it('a view without its own icon falls back to the container icon', () => {
    const items = buildRecentTargetPickItems(
      makeRecentTargets([viewTarget('tree')]),
      makeViewDescriptors({ tree: explorerContainer }),
    )
    expect(items[0]!.iconId).toBe('files')
  })

  it('a view with no resolvable container omits the description', () => {
    const items = buildRecentTargetPickItems(
      makeRecentTargets([viewTarget('orphan')]),
      makeViewDescriptors({}),
    )
    expect(items[0]!.description).toBeUndefined()
    expect(items[0]!.removable).toBe(false)
  })

  it('editor rows stay removable', () => {
    const svc = new EditorGroupsService()
    const editor = new TestEditor('a')
    svc.activeGroup.openEditor(editor)
    const items = buildRecentTargetPickItems(
      makeRecentTargets([{ kind: 'editor', editor, group: svc.activeGroup }]),
      makeViewDescriptors({}),
    )
    expect(items[0]!.removable).toBeUndefined()
  })

  it('closed-editor slots produce no row, leaving the order intact', () => {
    // The recency list reserves a slot for a just-closed editor so Ctrl+P can
    // place it; Ctrl+Tab switches between open targets only.
    const svc = new EditorGroupsService()
    const editor = new TestEditor('a')
    svc.activeGroup.openEditor(editor)
    const items = buildRecentTargetPickItems(
      makeRecentTargets([
        { kind: 'closedEditor', editorId: 'file:///ws/gone.ts' },
        { kind: 'editor', editor, group: svc.activeGroup },
        { kind: 'closedEditor', editorId: 'file:///ws/also-gone.ts' },
      ]),
      makeViewDescriptors({}),
    )
    expect(items).toHaveLength(1)
    expect(items[0]!.label).toBe(editor.label)
  })

  it('highlights the entry after the current one', () => {
    const items = [
      { id: 'a', label: 'a' },
      { id: 'b', label: 'b' },
      { id: 'c', label: 'c' },
    ]
    expect(computeInitialSelectionIndex(items, 'a', false)).toBe(1)
    expect(computeInitialSelectionIndex(items, 'b', false)).toBe(2)
  })

  it('reverse direction highlights the entry before the current one, wrapping', () => {
    const items = [
      { id: 'a', label: 'a' },
      { id: 'b', label: 'b' },
      { id: 'c', label: 'c' },
    ]
    expect(computeInitialSelectionIndex(items, 'b', true)).toBe(0)
    expect(computeInitialSelectionIndex(items, 'a', true)).toBe(2)
  })

  it('falls back to "index 0 is here" when the current target is not listed', () => {
    // Focus parked on the activity bar / status bar: nothing in the list matches.
    const items = [
      { id: 'a', label: 'a' },
      { id: 'b', label: 'b' },
      { id: 'c', label: 'c' },
    ]
    expect(computeInitialSelectionIndex(items, undefined, false)).toBe(1)
    expect(computeInitialSelectionIndex(items, 'missing', false)).toBe(1)
    expect(computeInitialSelectionIndex(items, undefined, true)).toBe(2)
  })

  it('does not divide by zero on an empty list', () => {
    expect(computeInitialSelectionIndex([], undefined, false)).toBe(0)
  })

  it('both directions are registered and usable without an editor open', () => {
    disposables.push(registerAction2(QuickOpenRecentEditorAction))
    disposables.push(registerAction2(QuickOpenRecentEditorReverseAction))
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+tab')).toBe(QuickOpenRecentEditorAction.ID)
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+shift+tab')).toBe(
      QuickOpenRecentEditorReverseAction.ID,
    )
    // The picker also lists views, so it must not be gated on `editorIsOpen`.
    // A precondition would be ANDed into the command palette entry's when-clause.
    for (const id of [QuickOpenRecentEditorAction.ID, QuickOpenRecentEditorReverseAction.ID]) {
      const entry = MenuRegistry.getMenuItems(MenuId.CommandPalette).find(
        (i) => 'command' in i && i.command === id,
      )
      expect(entry).toBeDefined()
      expect((entry as { when?: unknown }).when).toBeUndefined()
    }
  })
})
