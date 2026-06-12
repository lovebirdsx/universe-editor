/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for QuickAccessController: prefill, prefix routing to the registered
 *  provider, and tearing down the previous provider's store when the prefix
 *  changes or the picker hides.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  IInstantiationService,
  InstantiationService,
  IQuickInputService,
  QuickAccessRegistry,
  ServiceCollection,
  toDisposable,
  type IDisposable,
  type IQuickAccessProvider,
  type IQuickAccessProviderRunOptions,
  type IQuickInputService as IQuickInputServiceType,
  type IQuickPick,
  type IQuickPickItem,
  type IInputOptions,
  type IPickOptions,
  type QuickPickInput,
  type QuickPickPresentation,
} from '@universe-editor/platform'
import { QuickAccessController } from '../QuickAccessController.js'

// Shared activation/disposal log so the createInstance-built provider instances
// can report what the controller did to them.
interface ProviderLog {
  readonly activated: string[]
  readonly disposed: string[]
  readonly seenPrefix: string[]
  cancelledAfterSwitch: boolean
}

let log: ProviderLog

function makeProvider(tag: string): new () => IQuickAccessProvider {
  return class implements IQuickAccessProvider {
    provide(_picker: IQuickPick<IQuickPickItem>, options: IQuickAccessProviderRunOptions): void {
      log.activated.push(tag)
      log.seenPrefix.push(options.prefix)
      options.disposables.add(
        toDisposable(() => {
          log.disposed.push(tag)
          if (options.token.isCancellationRequested) log.cancelledAfterSwitch = true
        }),
      )
    }
  }
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
  placeholder: string | undefined
  items: readonly QuickPickInput<T>[] = []
  prefix = ''
  filterExternally = false
  filterMode: 'fuzzy' | 'word' = 'fuzzy'
  matchOnDescription = false
  matchOnDetail = false
  presentation: QuickPickPresentation = 'default'
  busy = false
  shown = false
  private _value = ''

  get value(): string {
    return this._value
  }

  set value(value: string) {
    this._value = value
    this._onDidChangeValue.fire(value)
  }

  show(): void {
    this.shown = true
  }

  hide(): void {
    this.shown = false
    this._onDidHide.fire()
  }

  dispose(): void {
    this._onDidAccept.dispose()
    this._onDidHide.dispose()
    this._onDidChangeValue.dispose()
    this._onDidChangeActive.dispose()
  }
}

class FakeQuickInputService implements IQuickInputServiceType {
  declare readonly _serviceBrand: undefined
  picker: FakeQuickPick<IQuickPickItem> | undefined

  createQuickPick<T extends IQuickPickItem>(): IQuickPick<T> {
    const picker = new FakeQuickPick<T>()
    this.picker = picker as unknown as FakeQuickPick<IQuickPickItem>
    return picker
  }

  async pick<T extends IQuickPickItem>(
    _items: readonly QuickPickInput<T>[],
    _options?: IPickOptions,
  ): Promise<T | undefined> {
    return undefined
  }

  async input(_options?: IInputOptions): Promise<string | undefined> {
    return undefined
  }

  hide(): void {
    this.picker?.hide()
  }
}

function setup(): { controller: QuickAccessController; quickInput: FakeQuickInputService } {
  const quickInput = new FakeQuickInputService()
  const services = new ServiceCollection()
  services.set(IQuickInputService, quickInput)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst as unknown as IInstantiationService)
  const controller = inst.createInstance(QuickAccessController)
  return { controller, quickInput }
}

describe('QuickAccessController', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function registerProviders(): void {
    disposables.push(
      QuickAccessRegistry.registerQuickAccessProvider({
        ctor: makeProvider('file'),
        prefix: '',
        placeholder: 'Go to File…',
      }),
    )
    disposables.push(
      QuickAccessRegistry.registerQuickAccessProvider({
        ctor: makeProvider('symbol'),
        prefix: '@',
        placeholder: 'Go to Symbol…',
      }),
    )
  }

  it('prefills the value and routes to the matching provider on open', () => {
    log = { activated: [], disposed: [], seenPrefix: [], cancelledAfterSwitch: false }
    registerProviders()
    const { controller, quickInput } = setup()

    void controller.show('@')
    const picker = quickInput.picker!

    expect(picker.shown).toBe(true)
    expect(picker.value).toBe('@')
    expect(log.activated).toEqual(['symbol'])
    expect(log.seenPrefix).toEqual(['@'])
    expect(picker.prefix).toBe('@')
    expect(picker.placeholder).toBe('Go to Symbol…')
  })

  it('empty value routes to the default file provider', () => {
    log = { activated: [], disposed: [], seenPrefix: [], cancelledAfterSwitch: false }
    registerProviders()
    const { controller, quickInput } = setup()

    void controller.show()
    expect(quickInput.picker!.prefix).toBe('')
    expect(log.activated).toEqual(['file'])
  })

  it('switching prefix disposes the previous provider store (with token cancelled) and activates the next', () => {
    log = { activated: [], disposed: [], seenPrefix: [], cancelledAfterSwitch: false }
    registerProviders()
    const { controller, quickInput } = setup()

    void controller.show()
    const picker = quickInput.picker!
    expect(log.activated).toEqual(['file'])

    picker.value = '@'
    expect(log.disposed).toEqual(['file'])
    expect(log.cancelledAfterSwitch).toBe(true)
    expect(log.activated).toEqual(['file', 'symbol'])
    expect(picker.prefix).toBe('@')
  })

  it('does not re-activate when the prefix stays the same', () => {
    log = { activated: [], disposed: [], seenPrefix: [], cancelledAfterSwitch: false }
    registerProviders()
    const { controller, quickInput } = setup()

    void controller.show('@')
    const picker = quickInput.picker!
    picker.value = '@foo'
    picker.value = '@bar'
    expect(log.activated).toEqual(['symbol'])
    expect(log.disposed).toEqual([])
  })

  it('resets filter props for each provider before it runs', () => {
    disposables.push(
      QuickAccessRegistry.registerQuickAccessProvider({
        ctor: class implements IQuickAccessProvider {
          provide(picker: IQuickPick<IQuickPickItem>): void {
            // Provider opts into external filtering; the controller must have
            // reset it to the default beforehand.
            picker.filterExternally = true
          }
        },
        prefix: '',
        placeholder: 'Default',
      }),
    )
    log = { activated: [], disposed: [], seenPrefix: [], cancelledAfterSwitch: false }
    disposables.push(
      QuickAccessRegistry.registerQuickAccessProvider({
        ctor: makeProvider('symbol'),
        prefix: '@',
        placeholder: 'Symbol',
      }),
    )
    const { controller, quickInput } = setup()

    void controller.show()
    const picker = quickInput.picker!
    expect(picker.filterExternally).toBe(true)

    picker.value = '@'
    // The symbol provider leaves filterExternally untouched, so the controller's
    // reset to false must be visible.
    expect(picker.filterExternally).toBe(false)
  })

  it('hiding the picker disposes the active provider store and the picker', () => {
    log = { activated: [], disposed: [], seenPrefix: [], cancelledAfterSwitch: false }
    registerProviders()
    const { controller, quickInput } = setup()

    void controller.show('@')
    const picker = quickInput.picker!
    picker.hide()
    expect(log.disposed).toEqual(['symbol'])
  })

  it('resolves the show() promise when the picker hides', async () => {
    log = { activated: [], disposed: [], seenPrefix: [], cancelledAfterSwitch: false }
    registerProviders()
    const { controller, quickInput } = setup()

    const promise = controller.show('@')
    quickInput.picker!.hide()
    await expect(promise).resolves.toBeUndefined()
  })
})
