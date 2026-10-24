/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for FileSymbolQuickAccessProvider ('@' / '@:'): the picker freezes its
 *  items after the first non-empty population so a live outline (e.g. a running
 *  agent session's timeline) can't shuffle the list under the user; an empty
 *  outline stays subscribed so late-arriving symbols still populate once.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  CancellationTokenSource,
  DisposableStore,
  EditorInput,
  EditorRegistry,
  Emitter,
  Event,
  InstantiationService,
  ServiceCollection,
  URI,
  UriIdentityService,
  constObservable,
  observableValue,
  type IKeyMods,
  type IQuickInputButton,
  type IQuickPickItemButtonEvent,
  type IQuickPick,
  type IQuickPickItem,
  type IQuickAccessProvider,
  type QuickPickInput,
  type QuickPickPresentation,
} from '@universe-editor/platform'
import type { monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'
import { AcpSessionEditorInput } from '../../acp/session/acpSessionEditorInput.js'
import { IOutlineService, type OutlineModel } from '../../languageFeatures/OutlineService.js'
import { timelineToOutline } from '../../acp/session/acpTimelineOutline.js'
import type { AcpChildItem, AcpMessage, AcpToolCall } from '../../acp/session/acpSessionModel.js'
import {
  FileSymbolByCategoryQuickAccessProvider,
  FileSymbolQuickAccessProvider,
} from '../providers/FileSymbolQuickAccessProvider.js'
import { EditorGroupsService } from '../../editor/EditorGroupsService.js'
import { IAuxiliaryEditorWindowService } from '../../windows/auxiliaryEditorWindowService.js'

class PlainEditor extends EditorInput {
  get typeId() {
    return 'test.plain'
  }
  get resource() {
    return URI.file('/ws/a.ts')
  }
  getName() {
    return 'a.ts'
  }
}

function makeSessionInput(): AcpSessionEditorInput {
  const history = { entries: constObservable([]), get: () => undefined }
  const sessions = { getById: () => undefined }
  const chatWidget = { focusSession: () => true }
  const workspace = { current: null, onDidChangeWorkspace: Event.None }
  return new AcpSessionEditorInput(
    'session-1',
    undefined,
    'Agent session',
    sessions as never,
    history as never,
    chatWidget as never,
    workspace as never,
    new UriIdentityService('linux'),
  )
}

class FakeQuickPick<T extends IQuickPickItem> implements IQuickPick<T> {
  private readonly _onDidAccept = new Emitter<T[]>()
  private readonly _onDidHide = new Emitter<void>()
  private readonly _onDidChangeValue = new Emitter<string>()
  private readonly _onDidChangeActive = new Emitter<T | undefined>()
  readonly onDidAccept = this._onDidAccept.event
  readonly onDidHide = this._onDidHide.event
  readonly onDidChangeValue = this._onDidChangeValue.event
  readonly onDidChangeActive = this._onDidChangeActive.event

  private readonly _onDidTriggerButton = new Emitter<IQuickInputButton>()
  private readonly _onDidTriggerItemButton = new Emitter<IQuickPickItemButtonEvent<T>>()
  private readonly _onDidTriggerOk = new Emitter<IKeyMods>()
  readonly onDidTriggerButton = this._onDidTriggerButton.event
  readonly onDidTriggerItemButton = this._onDidTriggerItemButton.event
  readonly onDidTriggerOk = this._onDidTriggerOk.event
  valueSelection: [number, number] | undefined
  activeItems: readonly T[] = []
  selectedItems: readonly T[] = []
  canSelectMany = false
  readonly onDidChangeSelection = new Emitter<T[]>().event
  title: string | undefined
  buttons: readonly IQuickInputButton[] = []
  okLabel: string | undefined
  keepOpenOnAccept = false
  keyMods = { ctrl: false, alt: false }
  placeholder: string | undefined
  items: readonly QuickPickInput<T>[] = []
  prefix = ''
  mruIds: readonly string[] = []
  filterExternally = false
  filterMode: 'fuzzy' | 'word' = 'fuzzy'
  matchOnDescription = false
  matchOnDetail = false
  presentation: QuickPickPresentation = 'default'
  busy = false
  private _value = ''

  get value(): string {
    return this._value
  }

  set value(value: string) {
    this._value = value
  }

  hidden = false

  fireAccept(items: T[]): void {
    this._onDidAccept.fire(items)
  }

  show(): void {}
  hide(): void {
    this.hidden = true
    this._onDidHide.fire()
  }
  dispose(): void {
    this._onDidAccept.dispose()
    this._onDidHide.dispose()
    this._onDidChangeValue.dispose()
    this._onDidChangeActive.dispose()
    this._onDidTriggerButton.dispose()
    this._onDidTriggerItemButton.dispose()
    this._onDidTriggerOk.dispose()
  }
}

function sym(
  name: string,
  children: monaco.languages.DocumentSymbol[] = [],
): monaco.languages.DocumentSymbol {
  const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 }
  return {
    name,
    detail: '',
    kind: 12,
    tags: [],
    range,
    selectionRange: range,
    children,
  } as monaco.languages.DocumentSymbol
}

function model(
  roots: readonly monaco.languages.DocumentSymbol[],
  version: number,
  languageId = 'acp.session',
): OutlineModel {
  return { uri: 'acp-session://1', roots, languageId, version }
}

function makeOutline() {
  const outline = observableValue<OutlineModel | undefined>('outline', undefined)
  const stub = {
    outline,
    activeSymbol: constObservable(undefined),
    sourceKind: constObservable(undefined),
    revealSymbol: vi.fn(),
    captureViewState: vi.fn(() => undefined),
    previewSymbol: vi.fn(),
    restoreViewState: vi.fn(),
  }
  return { outline, stub: stub as unknown as IOutlineService }
}

function labels(picker: FakeQuickPick<IQuickPickItem>): string[] {
  return picker.items.map((i) => (i as IQuickPickItem).label)
}

/** Separator rows are marked so row-order assertions stay readable. */
function rowLabels(picker: FakeQuickPick<IQuickPickItem>): (string | undefined)[] {
  return picker.items.map((item) => ('type' in item ? `---${item.label ?? ''}` : item.label))
}

function acpMessage(id: string, role: AcpMessage['role'], text: string): AcpChildItem {
  return {
    kind: 'message',
    id,
    message: { id, role, text, blocks: [], streaming: false },
  }
}

function acpTool(
  id: string,
  title: string,
  kind: string,
  children?: readonly AcpChildItem[],
  subagent = false,
): AcpChildItem {
  const call: AcpToolCall = {
    id,
    title,
    kind,
    status: 'completed',
    text: '',
    blocks: [],
    diffs: [],
    ...(children ? { children } : {}),
    ...(subagent ? { subagent: true as const } : {}),
  }
  return { kind: 'toolCall', id, call }
}

/** Q > (Task > sub work), grep — a sub-agent card nested in a user turn. */
function acpRoots(): monaco.languages.DocumentSymbol[] {
  return timelineToOutline([
    acpMessage('m1', 'user', 'Q'),
    acpTool('t1', 'Task', 'think', [acpMessage('c1', 'agent', 'sub work')], true),
    acpTool('t2', 'grep', 'search'),
  ]).roots
}

function run(
  provider: IQuickAccessProvider,
  picker: FakeQuickPick<IQuickPickItem>,
): DisposableStore {
  const store = new DisposableStore()
  const cts = new CancellationTokenSource()
  store.add(cts)
  provider.provide(picker, { disposables: store, token: cts.token, prefix: '@' })
  return store
}

describe('FileSymbolQuickAccessProvider', () => {
  it('freezes the list once populated so live outline updates do not shuffle it', () => {
    const { outline, stub } = makeOutline()
    outline.set(model([sym('turn one')], 1), undefined)
    const provider = new FileSymbolQuickAccessProvider(stub)
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)

    const frozen = picker.items
    expect(labels(picker)).toEqual(['turn one'])

    // A running session keeps pushing timeline updates → fresh outline trees.
    outline.set(model([sym('turn one'), sym('turn two')], 2), undefined)
    expect(picker.items).toBe(frozen)
    expect(labels(picker)).toEqual(['turn one'])
  })

  it('stays subscribed while empty so late-arriving symbols populate once, then freezes', () => {
    const { outline, stub } = makeOutline()
    const provider = new FileSymbolQuickAccessProvider(stub)
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    expect(picker.items).toEqual([])

    outline.set(model([sym('late')], 1), undefined)
    expect(labels(picker)).toEqual(['late'])

    const frozen = picker.items
    outline.set(model([sym('late'), sym('later')], 2), undefined)
    expect(picker.items).toBe(frozen)
    expect(labels(picker)).toEqual(['late'])
  })

  it('reveals the frozen snapshot symbol on accept, not a post-freeze tree', () => {
    const s1 = sym('one')
    const s2 = sym('two')
    const { outline, stub } = makeOutline()
    outline.set(model([s1, s2], 1), undefined)
    const provider = new FileSymbolQuickAccessProvider(stub)
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)

    outline.set(model([s1, s2, sym('three')], 2), undefined)
    const second = picker.items[1] as IQuickPickItem
    picker.fireAccept([second])

    expect(stub.revealSymbol).toHaveBeenCalledWith(s2)
    expect(picker.hidden).toBe(true)
  })

  it('surfaces a symbol detail as description + keyword (graph commits search by hash/author)', () => {
    const withDetail = { ...sym('fix the crash'), detail: 'aaa111 · alice · 2026-08-01' }
    const { outline, stub } = makeOutline()
    outline.set(model([withDetail, sym('plain')], 1), undefined)
    const provider = new FileSymbolQuickAccessProvider(stub)
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)

    const [detailed, plain] = picker.items as IQuickPickItem[]
    expect(detailed!.description).toBe('aaa111 · alice · 2026-08-01')
    expect(detailed!.keywords).toEqual(['aaa111 · alice · 2026-08-01'])
    // An empty detail stays off the item entirely (no stray description rendering).
    expect(plain!.description).toBeUndefined()
    expect(plain!.keywords).toBeUndefined()
  })
})

// The agent-session outline encodes sub-agent cards with a sentinel symbol kind;
// both pickers lift those rows above the document list without changing the
// output for ordinary files (no sentinel → no separator).
describe('FileSymbolQuickAccessProvider sub-agent section', () => {
  it("pins sub-agent cards above the '@' document list", () => {
    const roots = acpRoots()
    const { outline, stub } = makeOutline()
    outline.set(model(roots, 1), undefined)
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(new FileSymbolQuickAccessProvider(stub), picker)

    expect(rowLabels(picker)).toEqual([
      '---Sub Agents',
      'Task',
      '---Other symbols',
      'Q',
      '    sub work',
      '  grep',
    ])
    const task = picker.items[1] as IQuickPickItem
    expect(task.iconId).toBe('symbol-subagent')
  })

  it("reveals a pinned sub-agent card on accept ('@')", () => {
    const roots = acpRoots()
    const { outline, stub } = makeOutline()
    outline.set(model(roots, 1), undefined)
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(new FileSymbolQuickAccessProvider(stub), picker)

    picker.fireAccept([picker.items[1] as IQuickPickItem])
    expect(stub.revealSymbol).toHaveBeenCalledWith(roots[0]!.children![0])
  })

  it("pins sub-agent cards in '@:' without leaking them into a kind group", () => {
    const roots = acpRoots()
    const { outline, stub } = makeOutline()
    outline.set(model(roots, 1), undefined)
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(new FileSymbolByCategoryQuickAccessProvider(stub), picker)

    expect(rowLabels(picker)).toEqual([
      '---Sub Agents',
      'Task',
      '---files',
      'Q',
      '---modules',
      'sub work',
      '---other',
      'grep',
    ])
  })

  it("leaves the '@' output unchanged when there are no sub-agent cards", () => {
    const { outline, stub } = makeOutline()
    outline.set(model([sym('Q', [sym('grep')])], 1), undefined)
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(new FileSymbolQuickAccessProvider(stub), picker)

    expect(rowLabels(picker)).toEqual(['Q', '  grep'])
  })

  it("leaves the '@:' output unchanged when there are no sub-agent cards", () => {
    const { outline, stub } = makeOutline()
    outline.set(model([sym('Q', [sym('grep')])], 1), undefined)
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(new FileSymbolByCategoryQuickAccessProvider(stub), picker)

    expect(rowLabels(picker)).toEqual(['---variables', 'Q', 'grep'])
  })

  it('does not pin kind 110 outside the agent-session outline', () => {
    const { outline, stub } = makeOutline()
    const weird = { ...sym('weird'), kind: 110 as monaco.languages.SymbolKind }
    outline.set(model([weird], 1, 'typescript'), undefined)
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(new FileSymbolQuickAccessProvider(stub), picker)

    expect(rowLabels(picker)).toEqual(['weird'])
    expect((picker.items[0] as IQuickPickItem).iconId).toBe('symbol-kind-110')
  })
})

describe('FileSymbolQuickAccessProvider — targeted opens', () => {
  it('moves the active editor to a new side group on Ctrl+Enter', () => {
    vi.useFakeTimers()
    try {
      const { outline, stub } = makeOutline()
      outline.set(model([sym('target')], 1), undefined)
      const groups = new EditorGroupsService()
      const active = new PlainEditor()
      groups.activeGroup.openEditor(active)
      const provider = new FileSymbolQuickAccessProvider(
        stub,
        groups,
        new InstantiationService(new ServiceCollection()),
        new UriIdentityService('linux'),
        {} as unknown as IAuxiliaryEditorWindowService,
      )
      const picker = new FakeQuickPick<IQuickPickItem>()
      run(provider, picker)
      picker.keyMods = { ctrl: true, alt: false }

      picker.fireAccept([picker.items[0] as IQuickPickItem])

      expect(groups.groups).toHaveLength(2)
      expect(groups.groups[1]?.contains(active)).toBe(true)
      expect(stub.revealSymbol).not.toHaveBeenCalled()
      groups.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('moves an ACP session into the side group instead of cloning it', () => {
    vi.useFakeTimers()
    try {
      const { outline, stub } = makeOutline()
      outline.set(model([sym('target')], 1), undefined)
      const groups = new EditorGroupsService()
      const session = makeSessionInput()
      groups.activeGroup.openEditor(session)
      // A session is cloneable in principle; register a provider so the clone
      // path is reachable and would be caught if the provider stopped marking
      // sessions as singletons.
      let cloneCalls = 0
      const registration = EditorRegistry.registerEditorProvider({
        typeId: AcpSessionEditorInput.TYPE_ID,
        componentKey: 'file',
        deserialize: () => {
          cloneCalls++
          return new PlainEditor()
        },
      })
      try {
        const provider = new FileSymbolQuickAccessProvider(
          stub,
          groups,
          new InstantiationService(new ServiceCollection()),
          new UriIdentityService('linux'),
          {} as unknown as IAuxiliaryEditorWindowService,
        )
        const picker = new FakeQuickPick<IQuickPickItem>()
        run(provider, picker)
        picker.keyMods = { ctrl: true, alt: false }

        picker.fireAccept([picker.items[0] as IQuickPickItem])

        expect(cloneCalls).toBe(0)
        expect(groups.groups).toHaveLength(2)
        expect(groups.groups[0]?.contains(session)).toBe(false)
        expect(groups.groups[1]?.contains(session)).toBe(true)
        expect(stub.revealSymbol).not.toHaveBeenCalled()
      } finally {
        registration.dispose()
        groups.dispose()
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
