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
import type { SymbolInformation, WorkspaceSymbol } from 'vscode-languageserver-types'
import { MonacoLoader, type monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

export interface IDocumentSymbolProvidersChangeEvent {
  readonly languageId: string
}

/**
 * Workspace symbols have no Monaco provider counterpart (Monaco only exposes
 * per-document symbols), so the facade keeps them in its own table; the Ctrl+T
 * picker enumerates them directly. Results stay LSP-shaped — the picker converts.
 */
export interface IWorkspaceSymbolProvider {
  provideWorkspaceSymbols(query: string): Promise<WorkspaceSymbol[] | SymbolInformation[] | null>
}

export interface ILanguageFeaturesService {
  readonly _serviceBrand: undefined
  readonly onDidChangeDocumentSymbolProviders: Event<IDocumentSymbolProvidersChangeEvent>
  /** Fires on every provider registration/disposal of any kind. */
  readonly onDidChangeProviders: Event<void>
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
  registerImplementationProvider(
    languageId: string,
    provider: monaco.languages.ImplementationProvider,
  ): IDisposable
  registerTypeDefinitionProvider(
    languageId: string,
    provider: monaco.languages.TypeDefinitionProvider,
  ): IDisposable
  registerHoverProvider(languageId: string, provider: monaco.languages.HoverProvider): IDisposable
  registerCompletionProvider(
    languageId: string,
    provider: monaco.languages.CompletionItemProvider,
  ): IDisposable
  registerSignatureHelpProvider(
    languageId: string,
    provider: monaco.languages.SignatureHelpProvider,
  ): IDisposable
  registerRenameProvider(languageId: string, provider: monaco.languages.RenameProvider): IDisposable
  registerWorkspaceSymbolProvider(provider: IWorkspaceSymbolProvider): IDisposable
  getDocumentSymbolProviders(languageId: string): readonly monaco.languages.DocumentSymbolProvider[]
  getDefinitionProviders(languageId: string): readonly monaco.languages.DefinitionProvider[]
  hasDefinitionProvider(languageId: string): boolean
  hasImplementationProvider(languageId: string): boolean
  hasReferenceProvider(languageId: string): boolean
  getWorkspaceSymbolProviders(): readonly IWorkspaceSymbolProvider[]
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
  private readonly _implementationProviders = new Map<
    string,
    Set<monaco.languages.ImplementationProvider>
  >()
  private readonly _typeDefinitionProviders = new Map<
    string,
    Set<monaco.languages.TypeDefinitionProvider>
  >()
  private readonly _hoverProviders = new Map<string, Set<monaco.languages.HoverProvider>>()
  private readonly _completionProviders = new Map<
    string,
    Set<monaco.languages.CompletionItemProvider>
  >()
  private readonly _signatureHelpProviders = new Map<
    string,
    Set<monaco.languages.SignatureHelpProvider>
  >()
  private readonly _renameProviders = new Map<string, Set<monaco.languages.RenameProvider>>()
  private readonly _workspaceSymbolProviders = new Set<IWorkspaceSymbolProvider>()

  private readonly _onDidChangeDocumentSymbolProviders = this._register(
    new Emitter<IDocumentSymbolProvidersChangeEvent>(),
  )
  readonly onDidChangeDocumentSymbolProviders = this._onDidChangeDocumentSymbolProviders.event

  private readonly _onDidChangeProviders = this._register(new Emitter<void>())
  readonly onDidChangeProviders = this._onDidChangeProviders.event

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

  registerImplementationProvider(
    languageId: string,
    provider: monaco.languages.ImplementationProvider,
  ): IDisposable {
    return this._add(
      this._implementationProviders,
      languageId,
      provider,
      (m) => m.languages.registerImplementationProvider(languageId, provider),
      false,
    )
  }

  registerTypeDefinitionProvider(
    languageId: string,
    provider: monaco.languages.TypeDefinitionProvider,
  ): IDisposable {
    return this._add(
      this._typeDefinitionProviders,
      languageId,
      provider,
      (m) => m.languages.registerTypeDefinitionProvider(languageId, provider),
      false,
    )
  }

  registerHoverProvider(languageId: string, provider: monaco.languages.HoverProvider): IDisposable {
    return this._add(
      this._hoverProviders,
      languageId,
      provider,
      (m) => m.languages.registerHoverProvider(languageId, provider),
      false,
    )
  }

  registerCompletionProvider(
    languageId: string,
    provider: monaco.languages.CompletionItemProvider,
  ): IDisposable {
    return this._add(
      this._completionProviders,
      languageId,
      provider,
      (m) => m.languages.registerCompletionItemProvider(languageId, provider),
      false,
    )
  }

  registerSignatureHelpProvider(
    languageId: string,
    provider: monaco.languages.SignatureHelpProvider,
  ): IDisposable {
    return this._add(
      this._signatureHelpProviders,
      languageId,
      provider,
      (m) => m.languages.registerSignatureHelpProvider(languageId, provider),
      false,
    )
  }

  registerRenameProvider(
    languageId: string,
    provider: monaco.languages.RenameProvider,
  ): IDisposable {
    return this._add(
      this._renameProviders,
      languageId,
      provider,
      (m) => m.languages.registerRenameProvider(languageId, provider),
      false,
    )
  }

  getDocumentSymbolProviders(
    languageId: string,
  ): readonly monaco.languages.DocumentSymbolProvider[] {
    const set = this._symbolProviders.get(languageId)
    return set ? [...set] : []
  }

  getDefinitionProviders(languageId: string): readonly monaco.languages.DefinitionProvider[] {
    const set = this._definitionProviders.get(languageId)
    return set ? [...set] : []
  }

  hasImplementationProvider(languageId: string): boolean {
    const set = this._implementationProviders.get(languageId)
    return set !== undefined && set.size > 0
  }

  hasDefinitionProvider(languageId: string): boolean {
    const set = this._definitionProviders.get(languageId)
    return set !== undefined && set.size > 0
  }

  hasReferenceProvider(languageId: string): boolean {
    const set = this._referenceProviders.get(languageId)
    return set !== undefined && set.size > 0
  }

  registerWorkspaceSymbolProvider(provider: IWorkspaceSymbolProvider): IDisposable {
    this._workspaceSymbolProviders.add(provider)
    return toDisposable(() => {
      this._workspaceSymbolProviders.delete(provider)
    })
  }

  getWorkspaceSymbolProviders(): readonly IWorkspaceSymbolProvider[] {
    return [...this._workspaceSymbolProviders]
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
    this._onDidChangeProviders.fire()

    const monacoDisposable = registerOnMonaco(MonacoLoader.get())

    return toDisposable(() => {
      monacoDisposable.dispose()
      const current = map.get(languageId)
      if (current) {
        current.delete(provider)
        if (current.size === 0) map.delete(languageId)
      }
      if (fireSymbolChange) this._onDidChangeDocumentSymbolProviders.fire({ languageId })
      this._onDidChangeProviders.fire()
    })
  }
}
