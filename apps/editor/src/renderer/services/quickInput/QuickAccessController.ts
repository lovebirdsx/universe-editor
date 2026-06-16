/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Drives a single quick pick whose leading prefix routes to a registered
 *  IQuickAccessProvider (VSCode parity, platform/quickinput/browser/quickAccess.ts).
 *  Switching prefix disposes the previous provider's store (cancelling its async
 *  work and restoring any preview) before activating the next.
 *--------------------------------------------------------------------------------------------*/

import {
  CancellationTokenSource,
  Disposable,
  DisposableStore,
  IInstantiationService,
  IQuickInputService,
  InstantiationType,
  MutableDisposable,
  QuickAccessRegistry,
  createDecorator,
  registerSingleton,
  type IQuickAccessProviderDescriptor,
  type IQuickPickItem,
} from '@universe-editor/platform'

export interface IQuickAccessController {
  readonly _serviceBrand: undefined
  /**
   * Open the unified quick access picker, optionally prefilled with `value`
   * (e.g. '@' to land directly in file-symbol mode). Resolves when it hides.
   */
  show(value?: string): Promise<void>
}

export const IQuickAccessController =
  createDecorator<IQuickAccessController>('quickAccessController')

export class QuickAccessController extends Disposable implements IQuickAccessController {
  declare readonly _serviceBrand: undefined

  // Anchors the current show() session to this singleton service. Cleanup
  // normally fires on onDidHide; rooting here means an E2E teardown that tears
  // down the window mid-show still disposes the in-flight picker + subscriptions.
  private readonly _session = this._register(new MutableDisposable<DisposableStore>())

  constructor(
    @IQuickInputService private readonly _quickInput: IQuickInputService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
  ) {
    super()
  }

  show(value = ''): Promise<void> {
    const rootStore = new DisposableStore()
    this._session.value = rootStore

    const picker = rootStore.add(this._quickInput.createQuickPick<IQuickPickItem>())
    // Prefill before show(): while hidden, value writes are swallowed, so the
    // first pushed state (on show) already carries `value` and the input box
    // renders it. Reversing the order would drop the initial value.
    picker.value = value

    return new Promise<void>((resolve) => {
      let activeDescriptor: IQuickAccessProviderDescriptor | undefined
      let providerStore: DisposableStore | undefined
      let tokenSource: CancellationTokenSource | undefined
      let didResolve = false

      const disposeActiveProvider = (): void => {
        tokenSource?.cancel()
        tokenSource?.dispose()
        tokenSource = undefined
        providerStore?.dispose()
        providerStore = undefined
        activeDescriptor = undefined
      }

      const route = (current: string): void => {
        const descriptor = QuickAccessRegistry.getQuickAccessProvider(current)
        if (descriptor === activeDescriptor) return
        // Prefix changed → tear down the previous provider (cancels its async
        // work, fires its restore-view-state disposable), then activate the next.
        disposeActiveProvider()
        if (!descriptor) {
          picker.items = []
          return
        }
        activeDescriptor = descriptor
        const store = rootStore.add(new DisposableStore())
        const source = new CancellationTokenSource()
        providerStore = store
        tokenSource = source
        picker.items = []
        picker.busy = false
        picker.filterExternally = false
        picker.filterMode = 'fuzzy'
        picker.matchOnDescription = false
        picker.matchOnDetail = false
        picker.prefix = descriptor.prefix
        picker.placeholder = descriptor.placeholder
        const provider = this._instantiation.createInstance(descriptor.ctor)
        provider.provide(picker, {
          disposables: store,
          token: source.token,
          prefix: descriptor.prefix,
        })
      }

      const finish = (): void => {
        if (didResolve) return
        didResolve = true
        disposeActiveProvider()
        if (this._session.value === rootStore) this._session.clear()
        else rootStore.dispose()
        resolve()
      }

      rootStore.add(picker.onDidChangeValue((v) => route(v)))
      rootStore.add(picker.onDidHide(() => finish()))

      picker.show()
      // The initial value won't fire onDidChangeValue, so route once manually.
      route(picker.value)
    })
  }
}

registerSingleton(IQuickAccessController, QuickAccessController, InstantiationType.Delayed)
