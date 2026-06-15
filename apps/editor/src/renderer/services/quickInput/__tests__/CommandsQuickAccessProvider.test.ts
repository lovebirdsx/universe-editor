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
  type IQuickInputButton,
  type IQuickPick,
  type IQuickPickItem,
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
  readonly executed: string[] = []
  async executeCommand<T = unknown>(id: string): Promise<T | undefined> {
    this.executed.push(id)
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

function setup(storage: FakeStorageService): CommandsQuickAccessProvider {
  const services = new ServiceCollection()
  services.set(IStorageService, storage as unknown as IStorageService)
  services.set(ICommandService, new FakeCommandService() as unknown as ICommandService)
  services.set(
    IEditorGroupsService,
    new FakeEditorGroupsService() as unknown as IEditorGroupsService,
  )
  services.set(IContextKeyService, new FakeContextKeyService() as unknown as IContextKeyService)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst as unknown as IInstantiationService)
  return inst.createInstance(CommandsQuickAccessProvider)
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
    const provider = setup(storage)
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
    const provider = setup(storage)
    const picker = new FakeQuickPick<IQuickPickItem>()

    provider.provide(picker, runOptions(runDisposables))
    await Promise.resolve()
    await Promise.resolve()

    picker.fireAccept([{ id: 'cmd.a', label: 'Alpha' }])

    expect(storage.setSpy).toHaveBeenCalledWith(MRU_KEY, ['cmd.a', 'cmd.b'])
  })
})
