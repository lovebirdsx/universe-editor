/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for CommandsQuickAccessProvider's MRU wiring: the provider must seed the
 *  picker with the stored recently-used order and persist the accepted command
 *  back to storage so the next open surfaces it first. Regression coverage for the
 *  command palette losing its "recently used" sort after the QuickAccess refactor.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Event,
  ICommandService,
  IContextKeyService,
  IEditorGroupsService,
  IInstantiationService,
  IStorageService,
  InstantiationService,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  StorageScope,
  type IDisposable,
  type IQuickAccessProviderRunOptions,
  type IKeyMods,
  type IQuickInputButton,
  type IQuickPickItemButtonEvent,
  type IQuickPick,
  type IQuickPickItem,
  type IQuickPickItemButton,
  type QuickPickInput,
  type QuickPickPresentation,
} from '@universe-editor/platform'
import { CommandsQuickAccessProvider } from '../providers/CommandsQuickAccessProvider.js'

const MRU_KEY = 'quickinput.mru.workbench.commandPalette'

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
  value = ''
  prefix = ''
  mruIds: readonly string[] = []
  filterExternally = false
  filterMode: 'fuzzy' | 'word' = 'fuzzy'
  matchOnDescription = false
  matchOnDetail = false
  presentation: QuickPickPresentation = 'default'
  busy = false

  fireAccept(items: T[]): void {
    this._onDidAccept.fire(items)
  }

  fireItemButton(button: IQuickPickItemButton, item: T): void {
    this._onDidTriggerItemButton.fire({ button, item, keyMods: { ctrl: false, alt: false } })
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
    this._onDidTriggerItemButton.dispose()
    this._onDidTriggerOk.dispose()
  }
}

class FakeStorageService implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly onDidChangeWorkspaceScope: Event<void> = new Emitter<void>().event
  readonly store = new Map<string, unknown>()
  readonly setSpy = vi.fn()

  async get<T = unknown>(key: string, _scope?: StorageScope): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }
  async set(key: string, value: unknown, _scope?: StorageScope): Promise<void> {
    this.store.set(key, value)
    this.setSpy(key, value)
  }
  async remove(key: string, _scope?: StorageScope): Promise<void> {
    this.store.delete(key)
  }
}

class FakeCommandService implements Partial<ICommandService> {
  declare readonly _serviceBrand: undefined
  readonly executed: { id: string; args: unknown[] }[] = []
  async executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T | undefined> {
    this.executed.push({ id, args })
    return undefined
  }
}

class FakeEditorGroupsService implements Partial<IEditorGroupsService> {
  declare readonly _serviceBrand: undefined
  get activeGroup() {
    return { activeEditor: null } as never
  }
}

class FakeContextKeyService implements Partial<IContextKeyService> {
  declare readonly _serviceBrand: undefined
  contextMatchesRules(): boolean {
    return true
  }
}

function setup(storage: FakeStorageService): {
  provider: CommandsQuickAccessProvider
  commands: FakeCommandService
} {
  const commands = new FakeCommandService()
  const services = new ServiceCollection()
  services.set(IStorageService, storage as unknown as IStorageService)
  services.set(ICommandService, commands as unknown as ICommandService)
  services.set(
    IEditorGroupsService,
    new FakeEditorGroupsService() as unknown as IEditorGroupsService,
  )
  services.set(IContextKeyService, new FakeContextKeyService() as unknown as IContextKeyService)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst as unknown as IInstantiationService)
  return { provider: inst.createInstance(CommandsQuickAccessProvider), commands }
}

function runOptions(disposables: IDisposable[]): IQuickAccessProviderRunOptions {
  const store = {
    add<T extends IDisposable>(d: T): T {
      disposables.push(d)
      return d
    },
  }
  return {
    disposables: store as unknown as IQuickAccessProviderRunOptions['disposables'],
    token: { isCancellationRequested: false, onCancellationRequested: new Emitter<void>().event },
    prefix: '>',
  }
}

describe('CommandsQuickAccessProvider MRU', () => {
  const menuDisposables: IDisposable[] = []
  const runDisposables: IDisposable[] = []

  beforeEach(() => {
    menuDisposables.push(
      MenuRegistry.addMenuItem(MenuId.CommandPalette, { command: 'cmd.a', title: 'Alpha' }),
      MenuRegistry.addMenuItem(MenuId.CommandPalette, { command: 'cmd.b', title: 'Bravo' }),
    )
  })

  afterEach(() => {
    while (menuDisposables.length > 0) menuDisposables.pop()?.dispose()
    while (runDisposables.length > 0) runDisposables.pop()?.dispose()
  })

  it('seeds the picker mruIds from stored history', async () => {
    const storage = new FakeStorageService()
    storage.store.set(MRU_KEY, ['cmd.b'])
    const { provider } = setup(storage)
    const picker = new FakeQuickPick<IQuickPickItem>()

    provider.provide(picker, runOptions(runDisposables))
    // The provider reads storage asynchronously; flush the microtask queue.
    await Promise.resolve()
    await Promise.resolve()

    expect(picker.mruIds).toEqual(['cmd.b'])
  })

  it('persists the accepted command to the front of the MRU list', async () => {
    const storage = new FakeStorageService()
    storage.store.set(MRU_KEY, ['cmd.b'])
    const { provider } = setup(storage)
    const picker = new FakeQuickPick<IQuickPickItem>()

    provider.provide(picker, runOptions(runDisposables))
    await Promise.resolve()
    await Promise.resolve()

    picker.fireAccept([{ id: 'cmd.a', label: 'Alpha' }])

    expect(storage.setSpy).toHaveBeenCalledWith(MRU_KEY, ['cmd.a', 'cmd.b'])
  })

  it('offers a gear button on every command and close on recently used rows', async () => {
    const storage = new FakeStorageService()
    storage.store.set(MRU_KEY, ['cmd.b'])
    const { provider } = setup(storage)
    const picker = new FakeQuickPick<IQuickPickItem>()

    provider.provide(picker, runOptions(runDisposables))
    await Promise.resolve()
    await Promise.resolve()

    const itemOf = (id: string): IQuickPickItem =>
      picker.items.find((i): i is IQuickPickItem => !('type' in i) && i.id === id)!
    expect(itemOf('cmd.a').buttons?.map((b) => b.iconId)).toEqual(['settings-gear'])
    expect(itemOf('cmd.b').buttons?.map((b) => b.iconId)).toEqual(['settings-gear', 'x'])
  })

  it('gear hides the picker and opens the keybindings editor filtered to the command', async () => {
    const storage = new FakeStorageService()
    const { provider, commands } = setup(storage)
    const picker = new FakeQuickPick<IQuickPickItem>()
    let hidden = false
    picker.onDidHide(() => {
      hidden = true
    })

    provider.provide(picker, runOptions(runDisposables))
    await Promise.resolve()
    await Promise.resolve()

    const alpha = picker.items.find((i): i is IQuickPickItem => !('type' in i) && i.id === 'cmd.a')!
    picker.fireItemButton(alpha.buttons![0]!, alpha)

    expect(hidden).toBe(true)
    // The command run is deferred past hide's synchronous tail via queueMicrotask.
    await Promise.resolve()
    expect(commands.executed).toEqual([
      { id: 'workbench.action.openGlobalKeybindings', args: [{ query: '@command:cmd.a' }] },
    ])
  })

  it('close removes the row from MRU history and the visible list', async () => {
    const storage = new FakeStorageService()
    storage.store.set(MRU_KEY, ['cmd.b'])
    const { provider } = setup(storage)
    const picker = new FakeQuickPick<IQuickPickItem>()

    provider.provide(picker, runOptions(runDisposables))
    await Promise.resolve()
    await Promise.resolve()

    const bravo = picker.items.find((i): i is IQuickPickItem => !('type' in i) && i.id === 'cmd.b')!
    picker.fireItemButton(bravo.buttons![1]!, bravo)

    expect(storage.setSpy).toHaveBeenCalledWith(MRU_KEY, [])
    expect(picker.mruIds).toEqual([])
    expect(picker.items.some((i) => !('type' in i) && i.id === 'cmd.b')).toBe(false)
    // The plain command row remains, and without a stored MRU entry a reopen
    // would render it without the close button.
    expect(picker.items.some((i) => !('type' in i) && i.id === 'cmd.a')).toBe(true)
  })
})
