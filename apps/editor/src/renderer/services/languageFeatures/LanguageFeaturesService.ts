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
import type { LanguageServerStatus } from '@universe-editor/extensions-common'
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
  registerFoldingRangeProvider(
    languageId: string,
    provider: monaco.languages.FoldingRangeProvider,
  ): IDisposable
  registerDocumentLinkProvider(
    languageId: string,
    provider: monaco.languages.LinkProvider,
  ): IDisposable
  registerDocumentHighlightProvider(
    languageId: string,
    provider: monaco.languages.DocumentHighlightProvider,
  ): IDisposable
  registerSelectionRangeProvider(
    languageId: string,
    provider: monaco.languages.SelectionRangeProvider,
  ): IDisposable
  registerCodeActionProvider(
    languageId: string,
    provider: monaco.languages.CodeActionProvider,
  ): IDisposable
  registerDocumentFormattingEditProvider(
    languageId: string,
    provider: monaco.languages.DocumentFormattingEditProvider,
  ): IDisposable
  registerDocumentSemanticTokensProvider(
    languageId: string,
    provider: monaco.languages.DocumentSemanticTokensProvider,
  ): IDisposable
  registerCodeLensProvider(
    languageId: string,
    provider: monaco.languages.CodeLensProvider,
  ): IDisposable
  registerInlineCompletionsProvider(
    languageSelector: monaco.languages.LanguageSelector,
    provider: monaco.languages.InlineCompletionsProvider,
  ): IDisposable
  getDocumentSymbolProviders(languageId: string): readonly monaco.languages.DocumentSymbolProvider[]
  getDefinitionProviders(languageId: string): readonly monaco.languages.DefinitionProvider[]
  getFoldingRangeProviders(languageId: string): readonly monaco.languages.FoldingRangeProvider[]
  hasDefinitionProvider(languageId: string): boolean
  hasImplementationProvider(languageId: string): boolean
  hasReferenceProvider(languageId: string): boolean
  getWorkspaceSymbolProviders(): readonly IWorkspaceSymbolProvider[]
  /**
   * Lifecycle state of a language server, keyed by id (e.g. `'typescript'`),
   * pushed by its plugin. Absent id → never reported → treated as `'ready'`
   * (no server, or a language without one, must not make navigation wait).
   */
  getLanguageServerStatus(id: string): LanguageServerStatus
  /** Whether any reported language server is currently `starting`. */
  hasStartingLanguageServer(): boolean
  /** Fires when any language server's status changes. */
  readonly onDidChangeLanguageServerStatus: Event<ILanguageServerStatusChangeEvent>
  setLanguageServerStatus(id: string, status: LanguageServerStatus): void
  /**
   * Resolves once every currently-`starting` language server reaches `ready` (or
   * `error`). Resolves immediately when none is starting. Used by navigation
   * commands to await a cold-starting server instead of blocking silently.
   */
  whenLanguageServersSettled(): Promise<void>
}

export interface ILanguageServerStatusChangeEvent {
  readonly id: string
  readonly status: LanguageServerStatus
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
  private readonly _foldingRangeProviders = new Map<
    string,
    Set<monaco.languages.FoldingRangeProvider>
  >()
  private readonly _workspaceSymbolProviders = new Set<IWorkspaceSymbolProvider>()

  private readonly _onDidChangeDocumentSymbolProviders = this._register(
    new Emitter<IDocumentSymbolProvidersChangeEvent>(),
  )
  readonly onDidChangeDocumentSymbolProviders = this._onDidChangeDocumentSymbolProviders.event

  private readonly _onDidChangeProviders = this._register(new Emitter<void>())
  readonly onDidChangeProviders = this._onDidChangeProviders.event

  /** Per-server lifecycle state. An id absent from the map has never reported,
   *  so it's treated as `ready` (see getLanguageServerStatus). */
  private readonly _languageServerStatus = new Map<string, LanguageServerStatus>()
  private readonly _onDidChangeLanguageServerStatus = this._register(
    new Emitter<ILanguageServerStatusChangeEvent>(),
  )
  readonly onDidChangeLanguageServerStatus = this._onDidChangeLanguageServerStatus.event

  getLanguageServerStatus(id: string): LanguageServerStatus {
    return this._languageServerStatus.get(id) ?? 'ready'
  }

  hasStartingLanguageServer(): boolean {
    return [...this._languageServerStatus.values()].some((s) => s === 'starting')
  }

  setLanguageServerStatus(id: string, status: LanguageServerStatus): void {
    if (this._languageServerStatus.get(id) === status) return
    this._languageServerStatus.set(id, status)
    this._onDidChangeLanguageServerStatus.fire({ id, status })
  }

  whenLanguageServersSettled(): Promise<void> {
    if (!this.hasStartingLanguageServer()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      // Register the subscription so it's disposed if the service itself is torn
      // down while a server is still starting (the promise would otherwise never
      // resolve and the listener would leak — see e2e teardown).
      const sub = this._register(
        this._onDidChangeLanguageServerStatus.event(() => {
          if (this.hasStartingLanguageServer()) return
          sub.dispose()
          resolve()
        }),
      )
    })
  }

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

  registerFoldingRangeProvider(
    languageId: string,
    provider: monaco.languages.FoldingRangeProvider,
  ): IDisposable {
    return this._add(
      this._foldingRangeProviders,
      languageId,
      provider,
      (m) => m.languages.registerFoldingRangeProvider(languageId, provider),
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

  getFoldingRangeProviders(languageId: string): readonly monaco.languages.FoldingRangeProvider[] {
    const set = this._foldingRangeProviders.get(languageId)
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

  registerInlineCompletionsProvider(
    languageSelector: monaco.languages.LanguageSelector,
    provider: monaco.languages.InlineCompletionsProvider,
  ): IDisposable {
    // Inline completions are not mirrored in a table — the Outline view doesn't
    // need them and the selector may be '*' (all languages), which doesn't fit
    // the per-languageId map. Forward straight to Monaco.
    return MonacoLoader.get().languages.registerInlineCompletionsProvider(
      languageSelector,
      provider,
    )
  }

  registerDocumentLinkProvider(
    languageId: string,
    provider: monaco.languages.LinkProvider,
  ): IDisposable {
    // Links aren't mirrored (no Outline consumer); forward straight to Monaco,
    // which drives Ctrl+Click navigation through the editor opener.
    return MonacoLoader.get().languages.registerLinkProvider(languageId, provider)
  }

  registerDocumentHighlightProvider(
    languageId: string,
    provider: monaco.languages.DocumentHighlightProvider,
  ): IDisposable {
    return MonacoLoader.get().languages.registerDocumentHighlightProvider(languageId, provider)
  }

  registerSelectionRangeProvider(
    languageId: string,
    provider: monaco.languages.SelectionRangeProvider,
  ): IDisposable {
    return MonacoLoader.get().languages.registerSelectionRangeProvider(languageId, provider)
  }

  registerCodeActionProvider(
    languageId: string,
    provider: monaco.languages.CodeActionProvider,
  ): IDisposable {
    return MonacoLoader.get().languages.registerCodeActionProvider(languageId, provider)
  }

  registerDocumentFormattingEditProvider(
    languageId: string,
    provider: monaco.languages.DocumentFormattingEditProvider,
  ): IDisposable {
    // Not mirrored (no Outline consumer); forward straight to Monaco, which owns
    // the format-document command dispatch.
    return MonacoLoader.get().languages.registerDocumentFormattingEditProvider(languageId, provider)
  }

  registerDocumentSemanticTokensProvider(
    languageId: string,
    provider: monaco.languages.DocumentSemanticTokensProvider,
  ): IDisposable {
    return MonacoLoader.get().languages.registerDocumentSemanticTokensProvider(languageId, provider)
  }

  registerCodeLensProvider(
    languageId: string,
    provider: monaco.languages.CodeLensProvider,
  ): IDisposable {
    // Not mirrored (no Outline consumer); forward straight to Monaco, which owns
    // the CodeLens controller (rendering, click dispatch, onDidChange refresh).
    return MonacoLoader.get().languages.registerCodeLensProvider(languageId, provider)
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
