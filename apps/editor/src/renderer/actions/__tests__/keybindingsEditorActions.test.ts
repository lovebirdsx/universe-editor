import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  InstantiationService,
  KeybindingsRegistry,
  KeybindingWeight,
  ServiceCollection,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import {
  AddKeybindingAction,
  ClearKeybindingsSearchResultsAction,
  CopyCommandIdAction,
  CopyCommandTitleAction,
  CopyKeybindingEntryAction,
  DefineKeybindingAction,
  DefineWhenExpressionAction,
  FocusKeybindingsAction,
  RecordSearchKeysAction,
  RemoveKeybindingAction,
  ResetKeybindingAction,
  SearchKeybindingsAction,
  ShowSameKeybindingsAction,
  ToggleSortByPrecedenceAction,
  keybindingsEditorActions,
} from '../keybindingsEditorActions.js'
import {
  registerKeybindingsEditor,
  type IKeybindingsEditorHandle,
} from '../../services/keybindings/keybindingsEditorRuntime.js'

const EXPECTED_WEIGHT = KeybindingWeight.WorkbenchContrib + 50

const EXPECTED_KEYBINDINGS: ReadonlyArray<{
  readonly id: string
  readonly key?: string
  readonly chords?: readonly [string, string]
  readonly when?: string
}> = [
  {
    id: DefineKeybindingAction.ID,
    key: 'enter',
    when: 'inKeybindings && keybindingFocus && !whenFocus',
  },
  {
    id: AddKeybindingAction.ID,
    chords: ['ctrl+k', 'ctrl+a'],
    when: 'inKeybindings && keybindingFocus && !whenFocus',
  },
  {
    id: DefineWhenExpressionAction.ID,
    chords: ['ctrl+k', 'ctrl+e'],
    when: 'inKeybindings && keybindingFocus && !whenFocus',
  },
  {
    id: RemoveKeybindingAction.ID,
    key: 'delete',
    when: 'inKeybindings && keybindingFocus && !inKeybindingsSearch && !whenFocus',
  },
  {
    id: CopyKeybindingEntryAction.ID,
    key: 'ctrl+c',
    when: 'inKeybindings && keybindingFocus && !inKeybindingsSearch && !whenFocus',
  },
  {
    id: RecordSearchKeysAction.ID,
    key: 'alt+k',
    when: 'inKeybindings && inKeybindingsSearch',
  },
  {
    id: ToggleSortByPrecedenceAction.ID,
    key: 'alt+p',
    when: 'inKeybindings',
  },
  {
    id: ClearKeybindingsSearchResultsAction.ID,
    key: 'escape',
    when: 'inKeybindings && inKeybindingsSearch && keybindingsSearchHasValue',
  },
  {
    id: FocusKeybindingsAction.ID,
    key: 'ctrl+down',
    when: 'inKeybindings && inKeybindingsSearch',
  },
  {
    id: SearchKeybindingsAction.ID,
    key: 'ctrl+f',
    when: 'inKeybindings',
  },
]

function createHandleMock(): IKeybindingsEditorHandle & {
  [K in keyof IKeybindingsEditorHandle]: ReturnType<typeof vi.fn>
} {
  return {
    getSelectedRow: vi.fn(() => undefined),
    defineKeybinding: vi.fn(),
    defineWhenExpression: vi.fn(),
    toggleRecordKeys: vi.fn(),
    removeSelectedKeybinding: vi.fn(),
    resetSelectedKeybinding: vi.fn(),
    copyEntry: vi.fn(),
    showSameKeybindings: vi.fn(),
    toggleSortByPrecedence: vi.fn(),
    clearSearch: vi.fn(),
    focusSearch: vi.fn(),
    focusTable: vi.fn(),
    setQuery: vi.fn(),
  }
}

function runCommand(id: string): void {
  const inst = new InstantiationService(new ServiceCollection())
  inst.invokeFunction((accessor) => {
    CommandsRegistry.getCommand(id)!.handler(accessor)
  })
}

describe('keybindingsEditorActions', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function registerAll(): void {
    for (const action of keybindingsEditorActions) disposables.push(registerAction2(action))
  }

  it('registers every command', () => {
    registerAll()
    for (const action of keybindingsEditorActions) {
      expect(CommandsRegistry.getCommand(action.ID)).toBeDefined()
    }
  })

  it('registers the expected default keys, when-clauses and weight', () => {
    registerAll()
    const all = KeybindingsRegistry.getAllKeybindings()
    for (const expected of EXPECTED_KEYBINDINGS) {
      const item = all.find((i) => i.command === expected.id)
      expect(item, expected.id).toBeDefined()
      expect(item?.key, expected.id).toBe(expected.key)
      expect(item?.chords, expected.id).toEqual(expected.chords)
      expect(item?.weight, expected.id).toBe(EXPECTED_WEIGHT)
      expect(
        item?.when && typeof item.when !== 'string' ? item.when.serialize() : item?.when,
        expected.id,
      ).toBe(expected.when)
    }
  })

  it('gives commands without a default key no keybinding', () => {
    registerAll()
    const all = KeybindingsRegistry.getAllKeybindings()
    for (const id of [
      ResetKeybindingAction.ID,
      CopyCommandIdAction.ID,
      CopyCommandTitleAction.ID,
      ShowSameKeybindingsAction.ID,
    ]) {
      expect(
        all.some((i) => i.command === id),
        id,
      ).toBe(false)
    }
  })

  it('keeps every command out of the command palette', () => {
    registerAll()
    for (const action of keybindingsEditorActions) {
      const instance = new action()
      expect(instance.desc.f1).toBe(false)
    }
  })

  it.each([
    [DefineKeybindingAction.ID, 'defineKeybinding', false],
    [AddKeybindingAction.ID, 'defineKeybinding', true],
  ] as const)('%s calls defineKeybinding(%s)', (id, method, arg) => {
    registerAll()
    const handle = createHandleMock()
    disposables.push(registerKeybindingsEditor(handle))
    runCommand(id)
    expect(handle[method]).toHaveBeenCalledWith(arg)
  })

  it.each([
    [DefineWhenExpressionAction.ID, 'defineWhenExpression'],
    [RemoveKeybindingAction.ID, 'removeSelectedKeybinding'],
    [ResetKeybindingAction.ID, 'resetSelectedKeybinding'],
    [ShowSameKeybindingsAction.ID, 'showSameKeybindings'],
    [RecordSearchKeysAction.ID, 'toggleRecordKeys'],
    [ToggleSortByPrecedenceAction.ID, 'toggleSortByPrecedence'],
    [ClearKeybindingsSearchResultsAction.ID, 'clearSearch'],
    [FocusKeybindingsAction.ID, 'focusTable'],
    [SearchKeybindingsAction.ID, 'focusSearch'],
  ] as const)('%s calls handle.%s()', (id, method) => {
    registerAll()
    const handle = createHandleMock()
    disposables.push(registerKeybindingsEditor(handle))
    runCommand(id)
    expect(handle[method]).toHaveBeenCalledOnce()
  })

  it.each([
    [CopyKeybindingEntryAction.ID, 'json'],
    [CopyCommandIdAction.ID, 'commandId'],
    [CopyCommandTitleAction.ID, 'commandTitle'],
  ] as const)('%s calls copyEntry(%s)', (id, kind) => {
    registerAll()
    const handle = createHandleMock()
    disposables.push(registerKeybindingsEditor(handle))
    runCommand(id)
    expect(handle.copyEntry).toHaveBeenCalledWith(kind)
  })

  it('no-ops when no keybindings editor is active', () => {
    registerAll()
    for (const action of keybindingsEditorActions) {
      expect(() => runCommand(action.ID)).not.toThrow()
    }
  })
})
