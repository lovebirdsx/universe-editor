/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  QuickAccess provider registry — VSCode parity (platform/quickinput/common/quickAccess.ts).
 *  A single quick-open entry routes to a provider by the input's leading prefix
 *  ('' = files, '@' = file symbols, '@:' = grouped symbols, '>' = commands,
 *  '#' = workspace symbols). Longest matching prefix wins.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../base/cancellation.js'
import { DisposableStore, IDisposable, toDisposable } from '../base/lifecycle.js'
import type { IQuickPick, IQuickPickItem } from './quickInputService.js'

export interface IQuickAccessProviderRunOptions {
  /** The provider hangs every subscription / timer / token wiring here. */
  readonly disposables: DisposableStore
  /** Cancelled when the value (and thus the routed provider) changes or the picker hides. */
  readonly token: CancellationToken
  /** This provider's routing prefix; strip it off `picker.value` to get the filter. */
  readonly prefix: string
}

export interface IQuickAccessProvider {
  /**
   * Filter to prefill when the picker opens with just this provider's prefix
   * (e.g. the word under the cursor for '#'). The appended text is selected so
   * typing replaces it. VSCode parity (IQuickAccessProvider.defaultFilterValue).
   * `| undefined`: implementors compute it and may legitimately have none.
   */
  readonly defaultFilterValue?: string | undefined
  /**
   * Drive the shared picker for this provider's mode. Called once when this
   * provider becomes active; the provider subscribes to `picker.onDidChangeValue`
   * itself (hung on `options.disposables`) to react to subsequent edits. All
   * cleanup is owned by `options.disposables`, which the controller disposes on
   * prefix switch / hide — so `provide` returns nothing.
   */
  provide(picker: IQuickPick<IQuickPickItem>, options: IQuickAccessProviderRunOptions): void
}

export interface IQuickAccessProviderDescriptor {
  /** Instantiated lazily per open via the renderer's IInstantiationService. */
  readonly ctor: new (...services: never[]) => IQuickAccessProvider
  /** Routing prefix: '' (default/files), '@', '@:', '>', '#', … */
  readonly prefix: string
  /** Placeholder shown while this provider is active. */
  readonly placeholder: string
}

export interface IQuickAccessRegistry {
  registerQuickAccessProvider(descriptor: IQuickAccessProviderDescriptor): IDisposable
  /** Longest-prefix match for `value`; falls back to the default ('' prefix) provider. */
  getQuickAccessProvider(value: string): IQuickAccessProviderDescriptor | undefined
  getDefaultProvider(): IQuickAccessProviderDescriptor | undefined
  getQuickAccessProviders(): readonly IQuickAccessProviderDescriptor[]
}

class QuickAccessRegistryImpl implements IQuickAccessRegistry {
  private readonly _providers: IQuickAccessProviderDescriptor[] = []

  registerQuickAccessProvider(descriptor: IQuickAccessProviderDescriptor): IDisposable {
    this._providers.push(descriptor)
    // Longest prefix first so '@:' is tested before '@'; '' (default) sinks last.
    this._providers.sort((a, b) => b.prefix.length - a.prefix.length)
    return toDisposable(() => {
      const idx = this._providers.indexOf(descriptor)
      if (idx !== -1) this._providers.splice(idx, 1)
    })
  }

  getQuickAccessProvider(value: string): IQuickAccessProviderDescriptor | undefined {
    const nonDefault = this._providers.find(
      (p) => p.prefix.length > 0 && value.startsWith(p.prefix),
    )
    return nonDefault ?? this.getDefaultProvider()
  }

  getDefaultProvider(): IQuickAccessProviderDescriptor | undefined {
    return this._providers.find((p) => p.prefix.length === 0)
  }

  getQuickAccessProviders(): readonly IQuickAccessProviderDescriptor[] {
    return this._providers
  }
}

export const QuickAccessRegistry: IQuickAccessRegistry = new QuickAccessRegistryImpl()
