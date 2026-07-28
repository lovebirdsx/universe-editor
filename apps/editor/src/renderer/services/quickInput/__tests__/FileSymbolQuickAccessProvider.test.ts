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
  Emitter,
  constObservable,
  observableValue,
  type IQuickInputButton,
  type IQuickPick,
  type IQuickPickItem,
  type QuickPickInput,
  type QuickPickPresentation,
} from '@universe-editor/platform'
import type { monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'
import { IOutlineService, type OutlineModel } from '../../languageFeatures/OutlineService.js'
import { FileSymbolQuickAccessProvider } from '../providers/FileSymbolQuickAccessProvider.js'

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
  private readonly _onDidTriggerOk = new Emitter<void>()
  readonly onDidTriggerButton = this._onDidTriggerButton.event
  readonly onDidTriggerOk = this._onDidTriggerOk.event
  valueSelection: [number, number] | undefined
  activeItems: readonly T[] = []
  title: string | undefined
  buttons: readonly IQuickInputButton[] = []
  okLabel: string | undefined
  keepOpenOnAccept = false
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

function model(roots: readonly monaco.languages.DocumentSymbol[], version: number): OutlineModel {
  return { uri: 'acp-session://1', roots, languageId: 'acp.session', version }
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

function run(
  provider: FileSymbolQuickAccessProvider,
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
})
