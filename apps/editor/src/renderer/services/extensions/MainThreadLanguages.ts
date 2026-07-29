/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side handler for the host → renderer `mainThreadLanguages` channel.
 *  A plugin registers language providers (addressed by a host-allocated handle);
 *  here we build the matching Monaco provider shell per LanguageProviderType, wire
 *  it into ILanguageFeaturesService, and track handle → disposable for teardown.
 *  Diagnostics published by a plugin land as Monaco markers keyed by `owner`.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableMap,
  DisposableStore,
  Emitter,
  URI,
  toDisposable,
  type IDisposable,
  type UriComponents,
} from '@universe-editor/platform'
import type {
  DocumentSelector,
  IExtHostLanguages,
  ILanguageProviderMetadata,
  IMainThreadLanguages,
  LanguageProviderType,
  LanguageServerStatus,
} from '@universe-editor/extensions-common'
import type { Diagnostic } from 'vscode-languageserver-types'
import { MonacoLoader } from '../../workbench/editor/monaco/MonacoLoader.js'
import { diagnosticToMarker } from '../languageFeatures/typescript/lspMonacoConvert.js'
import type { ILanguageFeaturesService } from '../languageFeatures/LanguageFeaturesService.js'
import {
  createCodeActionProxy,
  createCodeLensProxy,
  createCompletionProxy,
  createDefinitionProxy,
  createDocumentFormattingProxy,
  createDocumentHighlightProxy,
  createDocumentLinkProxy,
  createDocumentSemanticTokensProxy,
  createDocumentSymbolProxy,
  createFoldingRangeProxy,
  createHoverProxy,
  createImplementationProxy,
  createReferenceProxy,
  createRenameProxy,
  createSelectionRangeProxy,
  createSignatureHelpProxy,
  createTypeDefinitionProxy,
  createWorkspaceSymbolProxy,
} from '../languageFeatures/languageProviderProxy.js'

export class MainThreadLanguages extends Disposable implements IMainThreadLanguages {
  private readonly _providers = this._register(new DisposableMap<number>())
  /** Per-handle refresh signal for CodeLens providers: the host calls
   *  `$emitCodeLensDidChange(handle)` and we fire the Emitter the provider's
   *  `onDidChange` is wired to, making Monaco re-request that provider's lenses. */
  private readonly _codeLensChange = new Map<number, Emitter<void>>()

  constructor(
    private readonly _extHost: IExtHostLanguages,
    private readonly _languageFeatures: ILanguageFeaturesService,
  ) {
    super()
  }

  async $registerProvider(
    handle: number,
    type: LanguageProviderType,
    selector: DocumentSelector,
    metadata?: ILanguageProviderMetadata,
  ): Promise<void> {
    // A dying host's in-flight frames can dispatch AFTER this connection was
    // torn down (stop() is fire-and-forget, so a frame already read off the
    // channel lands here post-dispose). Drop it instead of building a dozen
    // Monaco registrations for a dead host; the DisposableMap guard in
    // lifecycle.ts is only the last-resort backstop.
    if (this._dropIfDisposed(type)) return
    // The host's activate races Monaco's dynamic import: on a cold window the
    // extension can win and its provider batch arrives before Monaco exists.
    // Registering then would throw ([MonacoLoader] not initialized) — silently
    // dropping the whole batch AND leaking the half-built provider store. Wait
    // for Monaco instead; both $register and $unregister await the same promise,
    // so their relative order is preserved.
    await MonacoLoader.ensureInitialized()
    if (this._dropIfDisposed(type)) return
    this._providers.set(handle, this._createProvider(handle, type, selector, metadata))
  }

  async $unregisterProvider(handle: number): Promise<void> {
    await MonacoLoader.ensureInitialized()
    this._providers.deleteAndDispose(handle)
  }

  private _dropIfDisposed(type: LanguageProviderType): boolean {
    if (!this._store.isDisposed) return false
    console.warn(
      new Error(`[MainThreadLanguages] $registerProvider(${type}) arrived after dispose — dropped`)
        .stack,
    )
    return true
  }

  $publishDiagnostics(
    owner: string,
    uri: UriComponents,
    diagnostics: readonly Diagnostic[],
  ): Promise<void> {
    this._setMarkers(owner, uri, diagnostics)
    return Promise.resolve()
  }

  $clearDiagnostics(owner: string, uri?: UriComponents): Promise<void> {
    if (uri) this._setMarkers(owner, uri, [])
    else MonacoLoader.peek()?.editor.removeAllMarkers(owner)
    return Promise.resolve()
  }

  $emitCodeLensDidChange(handle: number): void {
    this._codeLensChange.get(handle)?.fire()
  }

  $setLanguageServerStatus(id: string, status: LanguageServerStatus): void {
    this._languageFeatures.setLanguageServerStatus(id, status)
  }

  private _createProvider(
    handle: number,
    type: LanguageProviderType,
    selector: DocumentSelector,
    metadata: ILanguageProviderMetadata | undefined,
  ): IDisposable {
    const lf = this._languageFeatures
    const ext = this._extHost
    const store = new DisposableStore()

    try {
      this._fillProviderStore(store, handle, type, selector, metadata, lf, ext)
    } catch (err) {
      // A half-built store that never reaches this._providers would be an
      // orphan the leak tracker reports at teardown — release it before
      // propagating the failure to the host.
      store.dispose()
      throw err
    }
    return store
  }

  private _fillProviderStore(
    store: DisposableStore,
    handle: number,
    type: LanguageProviderType,
    selector: DocumentSelector,
    metadata: ILanguageProviderMetadata | undefined,
    lf: ILanguageFeaturesService,
    ext: IExtHostLanguages,
  ): void {
    switch (type) {
      case 'definition': {
        const p = createDefinitionProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerDefinitionProvider(lang, p))
        break
      }
      case 'references': {
        const p = createReferenceProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerReferenceProvider(lang, p))
        break
      }
      case 'implementation': {
        const p = createImplementationProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerImplementationProvider(lang, p))
        break
      }
      case 'typeDefinition': {
        const p = createTypeDefinitionProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerTypeDefinitionProvider(lang, p))
        break
      }
      case 'hover': {
        const p = createHoverProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerHoverProvider(lang, p))
        break
      }
      case 'completion': {
        const p = createCompletionProxy(handle, ext, metadata?.triggerCharacters ?? [])
        for (const lang of selector) store.add(lf.registerCompletionProvider(lang, p))
        break
      }
      case 'signatureHelp': {
        const p = createSignatureHelpProxy(
          handle,
          ext,
          metadata?.signatureHelpTriggerCharacters ?? [],
          metadata?.signatureHelpRetriggerCharacters ?? [],
        )
        for (const lang of selector) store.add(lf.registerSignatureHelpProvider(lang, p))
        break
      }
      case 'documentSymbol': {
        const p = createDocumentSymbolProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerDocumentSymbolProvider(lang, p))
        break
      }
      case 'rename': {
        const p = createRenameProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerRenameProvider(lang, p))
        break
      }
      case 'workspaceSymbol': {
        store.add(lf.registerWorkspaceSymbolProvider(createWorkspaceSymbolProxy(handle, ext)))
        break
      }
      case 'foldingRange': {
        const p = createFoldingRangeProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerFoldingRangeProvider(lang, p))
        break
      }
      case 'documentLink': {
        const p = createDocumentLinkProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerDocumentLinkProvider(lang, p))
        break
      }
      case 'documentHighlight': {
        const p = createDocumentHighlightProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerDocumentHighlightProvider(lang, p))
        break
      }
      case 'selectionRange': {
        const p = createSelectionRangeProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerSelectionRangeProvider(lang, p))
        break
      }
      case 'codeAction': {
        const p = createCodeActionProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerCodeActionProvider(lang, p))
        break
      }
      case 'documentFormatting': {
        const p = createDocumentFormattingProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerDocumentFormattingEditProvider(lang, p))
        break
      }
      case 'documentSemanticTokens': {
        // The legend rides along in metadata: Monaco's getLegend() is synchronous,
        // so it must be known at registration time, not fetched per request.
        const legend = metadata?.semanticTokensLegend
        if (legend) {
          const p = createDocumentSemanticTokensProxy(handle, ext, legend)
          for (const lang of selector) {
            store.add(lf.registerDocumentSemanticTokensProvider(lang, p))
          }
        }
        break
      }
      case 'codeLens': {
        const changeEmitter = new Emitter<void>()
        this._codeLensChange.set(handle, changeEmitter)
        store.add(toDisposable(() => this._codeLensChange.delete(handle)))
        store.add(changeEmitter)
        const p = createCodeLensProxy(handle, ext, changeEmitter.event)
        for (const lang of selector) store.add(lf.registerCodeLensProvider(lang, p))
        break
      }
    }
  }

  private _setMarkers(owner: string, uri: UriComponents, diagnostics: readonly Diagnostic[]): void {
    const resource = URI.revive(uri)
    if (!resource) return
    // Diagnostics racing Monaco's dynamic import target a model that cannot
    // exist yet — dropping them mirrors the !model early-return below.
    const monacoNs = MonacoLoader.peek()
    if (!monacoNs) return
    // Resolve through Monaco's own registry: it canonicalizes the Windows drive
    // letter (lowercases it), so a platform URI carrying an uppercase drive still
    // matches the model created from the lowercased Monaco uri.
    const model = monacoNs.editor.getModel(monacoNs.Uri.parse(resource.toString()))
    if (!model || model.isDisposed()) return
    monacoNs.editor.setModelMarkers(
      model,
      owner,
      diagnostics.map((d) => diagnosticToMarker(d, monacoNs)),
    )
  }
}
