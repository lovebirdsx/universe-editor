/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for WorkspaceSymbolQuickAccessProvider: no search on an empty query
 *  (no provider call, no busy spinner, list cleared), debounced queries whose
 *  cancellation token reaches the language provider, superseded-query and
 *  hide cancellation, and the word-under-cursor default filter prefill.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CancellationTokenSource,
  Emitter,
  IEditorGroupsService,
  IInstantiationService,
  ILoggerService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationService,
  NullLogger,
  ServiceCollection,
  URI,
  UriIdentityService,
  type CancellationToken,
  type IDisposable,
  type IQuickInputButton,
  type IQuickPick,
  type IQuickPickItem,
  type IWorkspace,
  type QuickPickInput,
  type QuickPickPresentation,
} from '@universe-editor/platform'
import { ILanguageFeaturesService } from '../../languageFeatures/LanguageFeaturesService.js'
import type { WorkspaceSymbolEntry } from '../../languageFeatures/typescript/lspMonacoConvert.js'
import { FileEditorInput } from '../../editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../editor/FileEditorRegistry.js'

vi.mock('../../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: { ensureInitialized: () => Promise.resolve({}) },
}))
vi.mock('../../languageFeatures/typescript/lspMonacoConvert.js', () => ({
  workspaceSymbolsToEntries: (symbols: readonly WorkspaceSymbolEntry[] | null) => symbols ?? [],
}))

const { WorkspaceSymbolQuickAccessProvider } =
  await import('../providers/WorkspaceSymbolQuickAccessProvider.js')

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

  fireValue(value: string): void {
    this._value = value
    this._onDidChangeValue.fire(value)
  }

  fireAccept(items: T[]): void {
    this._onDidAccept.fire(items)
  }

  show(): void {}
  hide(): void {
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

function entry(name: string, uri = 'file:///ws/a.ts', line = 1): WorkspaceSymbolEntry {
  return {
    name,
    kind: 11,
    uri: URI.parse(uri),
    range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
  } as unknown as WorkspaceSymbolEntry
}

interface QueryCall {
  query: string
  token: CancellationToken
}

function setup(
  symbols: readonly WorkspaceSymbolEntry[] = [entry('foo')],
  options?: { pending?: boolean },
) {
  const calls: QueryCall[] = []
  const langFeatures = {
    getWorkspaceSymbolProviders: () => [
      {
        provideWorkspaceSymbols: (query: string, token: CancellationToken) => {
          calls.push({ query, token })
          // pending: never settles, simulating a slow language server so tests
          // can observe the in-flight token's cancellation.
          return options?.pending
            ? new Promise<readonly WorkspaceSymbolEntry[]>(() => {})
            : Promise.resolve(symbols)
        },
      },
    ],
  }
  const services = new ServiceCollection()
  services.set(IWorkspaceService, {
    current: { folder: URI.file('/ws'), name: 'ws' } as IWorkspace,
  } as never)
  services.set(IEditorGroupsService, { groups: [] } as never)
  services.set(ILanguageFeaturesService, langFeatures as never)
  services.set(IUriIdentityService, new UriIdentityService('linux'))
  services.set(ILoggerService, { createLogger: () => new NullLogger() } as never)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst as unknown as IInstantiationService)
  const provider = inst.createInstance(WorkspaceSymbolQuickAccessProvider)
  return { provider, calls }
}

function run(
  provider: InstanceType<typeof WorkspaceSymbolQuickAccessProvider>,
  picker: FakeQuickPick<IQuickPickItem>,
): IDisposable {
  const store: IDisposable[] = []
  const tokenSource = new CancellationTokenSource()
  const disposables = {
    add<T extends IDisposable>(d: T): T {
      store.push(d)
      return d
    },
    dispose() {
      while (store.length > 0) store.pop()?.dispose()
      tokenSource.cancel()
      tokenSource.dispose()
    },
  }
  provider.provide(picker, {
    disposables: disposables as never,
    token: tokenSource.token,
    prefix: '#',
  })
  return disposables
}

const DEBOUNCE_MS = 160

describe('WorkspaceSymbolQuickAccessProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not search on open with an empty query: no provider call, no busy, empty list', async () => {
    const { provider, calls } = setup()
    const picker = new FakeQuickPick<IQuickPickItem>()
    picker.value = '#'
    run(provider, picker)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3)
    expect(calls).toEqual([])
    expect(picker.busy).toBe(false)
    expect(picker.items).toEqual([])
  })

  it('queries the providers after the debounce once the filter is non-empty', async () => {
    const { provider, calls } = setup([entry('foo'), entry('barFoo')])
    const picker = new FakeQuickPick<IQuickPickItem>()
    picker.value = '#'
    run(provider, picker)
    await vi.advanceTimersByTimeAsync(0)

    picker.fireValue('#foo')
    expect(calls).toEqual([]) // debounced, not yet sent
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(calls.map((c) => c.query)).toEqual(['foo'])
    await vi.advanceTimersByTimeAsync(0)

    expect(picker.busy).toBe(false)
    // Exact-prefix match outranks the substring match.
    expect(picker.items.map((i) => (i as IQuickPickItem).label)).toEqual(['foo', 'barFoo'])
  })

  it('cancels the in-flight query when a newer keystroke supersedes it', async () => {
    const { provider, calls } = setup([entry('foo')], { pending: true })
    const picker = new FakeQuickPick<IQuickPickItem>()
    picker.value = '#'
    run(provider, picker)
    await vi.advanceTimersByTimeAsync(0)

    picker.fireValue('#fo')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    picker.fireValue('#foo')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(calls.map((c) => c.query)).toEqual(['fo', 'foo'])
    expect(calls[0]!.token.isCancellationRequested).toBe(true)
    expect(calls[1]!.token.isCancellationRequested).toBe(false)
  })

  it('clearing the filter cancels the in-flight query and empties the list without a new search', async () => {
    const { provider, calls } = setup([entry('foo')], { pending: true })
    const picker = new FakeQuickPick<IQuickPickItem>()
    picker.value = '#'
    run(provider, picker)
    await vi.advanceTimersByTimeAsync(0)

    picker.fireValue('#foo')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(calls).toHaveLength(1)

    picker.fireValue('#')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.token.isCancellationRequested).toBe(true)
    expect(picker.busy).toBe(false)
    expect(picker.items).toEqual([])
  })

  it('cancels the in-flight query when the provider is disposed (hide / prefix switch)', async () => {
    const { provider, calls } = setup([entry('foo')], { pending: true })
    const picker = new FakeQuickPick<IQuickPickItem>()
    picker.value = '#'
    const disposables = run(provider, picker)
    await vi.advanceTimersByTimeAsync(0)

    picker.fireValue('#foo')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(calls).toHaveLength(1)

    disposables.dispose()
    expect(calls[0]!.token.isCancellationRequested).toBe(true)
  })

  it('starts an initial query when the picker opens with a prefilled filter', async () => {
    const { provider, calls } = setup()
    const picker = new FakeQuickPick<IQuickPickItem>()
    picker.value = '#foo'
    run(provider, picker)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(calls.map((c) => c.query)).toEqual(['foo'])
  })

  it('starts an initial query when the prefill lands after provide without an event', async () => {
    // QuickInputService's value setter doesn't fire onDidChangeValue, so the
    // controller's '#' prefill (set after provide) is invisible to the change
    // listener; the provider re-reads picker.value once its async init settles.
    const { provider, calls } = setup()
    const picker = new FakeQuickPick<IQuickPickItem>()
    picker.value = '#'
    run(provider, picker)
    picker.value = '#TestValue'
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(calls.map((c) => c.query)).toEqual(['TestValue'])
  })
})

describe('WorkspaceSymbolQuickAccessProvider.defaultFilterValue', () => {
  afterEach(() => {
    FileEditorRegistry._resetForTests()
  })

  function setupWithEditor(
    editor: object,
  ): InstanceType<typeof WorkspaceSymbolQuickAccessProvider> {
    const input = new FileEditorInput(URI.file('/ws/a.ts'), {} as never)
    FileEditorRegistry.register(input, editor as never)
    const services = new ServiceCollection()
    services.set(IWorkspaceService, {
      current: { folder: URI.file('/ws'), name: 'ws' } as IWorkspace,
    } as never)
    services.set(IEditorGroupsService, {
      groups: [],
      activeGroup: { activeEditor: input },
    } as never)
    services.set(ILanguageFeaturesService, { getWorkspaceSymbolProviders: () => [] } as never)
    services.set(IUriIdentityService, new UriIdentityService('linux'))
    services.set(ILoggerService, { createLogger: () => new NullLogger() } as never)
    const inst = new InstantiationService(services)
    services.set(IInstantiationService, inst as unknown as IInstantiationService)
    return inst.createInstance(WorkspaceSymbolQuickAccessProvider)
  }

  it('uses the single-line selection when there is one', () => {
    const provider = setupWithEditor({
      getModel: () => ({ getValueInRange: () => 'selectedSymbol' }),
      getSelection: () => ({
        isEmpty: () => false,
        startLineNumber: 3,
        endLineNumber: 3,
      }),
    })
    expect(provider.defaultFilterValue).toBe('selectedSymbol')
  })

  it('falls back to the word under the cursor when the selection is empty', () => {
    const provider = setupWithEditor({
      getModel: () => ({ getWordAtPosition: () => ({ word: 'wordUnderCursor' }) }),
      getSelection: () => ({
        isEmpty: () => true,
        getPosition: () => ({ lineNumber: 1, column: 5 }),
      }),
    })
    expect(provider.defaultFilterValue).toBe('wordUnderCursor')
  })

  it('returns undefined for a multi-line selection', () => {
    const provider = setupWithEditor({
      getModel: () => ({ getValueInRange: () => 'a\nb' }),
      getSelection: () => ({
        isEmpty: () => false,
        startLineNumber: 1,
        endLineNumber: 3,
      }),
    })
    expect(provider.defaultFilterValue).toBeUndefined()
  })
})
