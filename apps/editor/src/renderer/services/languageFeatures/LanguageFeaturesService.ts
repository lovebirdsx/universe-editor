/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ILanguageFeaturesService — a thin app-layer facade over Monaco's language
 *  feature registries. Each `register*` call does two things:
 *    (a) stores the provider in an internal mirror table (Monaco does not expose
 *        an API to enumerate registered providers, and the Outline view needs to
 *        pull document symbols on demand), firing a change event; and
 *    (b) forwards to `monaco.languages.register*Provider` so Monaco's built-in
 *        F12 (Go to Definition) / Shift+F12 (Find References) peek UI works for
 *        free — we never reimplement those.
 *
 *  Lives in the app layer (not platform) because it depends on Monaco. Providers
 *  use Monaco's native types so forwarding needs no adaptation.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  Emitter,
  toDisposable,
  type Event,
  type IDisposable,
} from '@universe-editor/platform'
import { MonacoLoader, type monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

export interface IDocumentSymbolProvidersChangeEvent {
  readonly languageId: string
}

export interface ILanguageFeaturesService {
  readonly _serviceBrand: undefined
  readonly onDidChangeDocumentSymbolProviders: Event<IDocumentSymbolProvidersChangeEvent>
  registerDocumentSymbolProvider(
    languageId: string,
    provider: monaco.languages.DocumentSymbolProvider,
  ): IDisposable
  registerDefinitionProvider(
    languageId: string,
    provider: monaco.languages.DefinitionProvider,
  ): IDisposable
  registerReferenceProvider(
    languageId: string,
    provider: monaco.languages.ReferenceProvider,
  ): IDisposable
  getDocumentSymbolProviders(languageId: string): readonly monaco.languages.DocumentSymbolProvider[]
}

export const ILanguageFeaturesService =
  createDecorator<ILanguageFeaturesService>('languageFeaturesService')

export class LanguageFeaturesService extends Disposable implements ILanguageFeaturesService {
  declare readonly _serviceBrand: undefined

  private readonly _symbolProviders = new Map<
    string,
    Set<monaco.languages.DocumentSymbolProvider>
  >()
  private readonly _definitionProviders = new Map<
    string,
    Set<monaco.languages.DefinitionProvider>
  >()
  private readonly _referenceProviders = new Map<string, Set<monaco.languages.ReferenceProvider>>()

  private readonly _onDidChangeDocumentSymbolProviders = this._register(
    new Emitter<IDocumentSymbolProvidersChangeEvent>(),
  )
  readonly onDidChangeDocumentSymbolProviders = this._onDidChangeDocumentSymbolProviders.event

  registerDocumentSymbolProvider(
    languageId: string,
    provider: monaco.languages.DocumentSymbolProvider,
  ): IDisposable {
    return this._add(this._symbolProviders, languageId, provider, (m) =>
      m.languages.registerDocumentSymbolProvider(languageId, provider),
    )
  }

  registerDefinitionProvider(
    languageId: string,
    provider: monaco.languages.DefinitionProvider,
  ): IDisposable {
    return this._add(
      this._definitionProviders,
      languageId,
      provider,
      (m) => m.languages.registerDefinitionProvider(languageId, provider),
      false,
    )
  }

  registerReferenceProvider(
    languageId: string,
    provider: monaco.languages.ReferenceProvider,
  ): IDisposable {
    return this._add(
      this._referenceProviders,
      languageId,
      provider,
      (m) => m.languages.registerReferenceProvider(languageId, provider),
      false,
    )
  }

  getDocumentSymbolProviders(
    languageId: string,
  ): readonly monaco.languages.DocumentSymbolProvider[] {
    const set = this._symbolProviders.get(languageId)
    return set ? [...set] : []
  }

  private _add<T>(
    map: Map<string, Set<T>>,
    languageId: string,
    provider: T,
    registerOnMonaco: (m: typeof monaco) => IDisposable,
    fireSymbolChange = true,
  ): IDisposable {
    let set = map.get(languageId)
    if (!set) {
      set = new Set<T>()
      map.set(languageId, set)
    }
    set.add(provider)
    if (fireSymbolChange) this._onDidChangeDocumentSymbolProviders.fire({ languageId })

    const monacoDisposable = registerOnMonaco(MonacoLoader.get())

    return toDisposable(() => {
      monacoDisposable.dispose()
      const current = map.get(languageId)
      if (current) {
        current.delete(provider)
        if (current.size === 0) map.delete(languageId)
      }
      if (fireSymbolChange) this._onDidChangeDocumentSymbolProviders.fire({ languageId })
    })
  }
}
