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
  NullLogger,
  URI,
  toDisposable,
  type IDisposable,
  type ILogger,
  type UriComponents,
} from '@universe-editor/platform'
import type {
  DocumentSelector,
  IExtHostLanguages,
  ILanguageConfigurationDto,
  ILanguageProviderMetadata,
  IMainThreadLanguages,
  LanguageProviderType,
  LanguageServerStatus,
} from '@universe-editor/extensions-common'
import type { Diagnostic } from 'vscode-languageserver-types'
import { MonacoLoader, type monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import type { ILanguageConfigurationMapping } from '../languages/languageConfiguration.js'
import {
  diagnosticToMarker,
  markerToLspDiagnostic,
} from '../languageFeatures/typescript/lspMonacoConvert.js'
import type { ILanguageFeaturesService } from '../languageFeatures/LanguageFeaturesService.js'
import {
  createCodeActionProxy,
  createCodeLensProxy,
  createCompletionProxy,
  createDefinitionProxy,
  createDocumentFormattingProxy,
  createDocumentHighlightProxy,
  createDocumentLinkProxy,
  createDocumentRangeFormattingProxy,
  createDocumentRangeSemanticTokensProxy,
  createDocumentSemanticTokensProxy,
  createDocumentSymbolProxy,
  createFoldingRangeProxy,
  createHoverProxy,
  createImplementationProxy,
  createInlayHintsProxy,
  createOnTypeFormattingProxy,
  createReferenceProxy,
  createRenameProxy,
  createSelectionRangeProxy,
  createSignatureHelpProxy,
  createTypeDefinitionProxy,
  createWorkspaceSymbolProxy,
} from '../languageFeatures/languageProviderProxy.js'

/** Marker-change pushes are debounced into one RPC per burst: a language server
 *  publishing per-file diagnostics during a project-wide re-parse would
 *  otherwise fire one frame per file per pass (this repo has an RPC-flood
 *  history). 50ms matches the document-mirror change debounce. */
const DIAGNOSTICS_CHANGE_DEBOUNCE_MS = 50

/** Wire language-configuration DTO → the Monaco shape `setLanguageConfiguration`
 *  takes: `wordPattern` crosses the wire as a source string and is recompiled
 *  here (an uncompilable pattern is dropped, same as parseLanguageConfiguration). */
function toLanguageConfigurationMapping(
  config: ILanguageConfigurationDto,
): ILanguageConfigurationMapping {
  const mapped: ILanguageConfigurationMapping = {}
  if (config.comments) mapped.comments = { ...config.comments }
  if (config.brackets) mapped.brackets = [...config.brackets]
  if (config.autoClosingPairs) {
    mapped.autoClosingPairs = config.autoClosingPairs.map((p) => ({
      open: p.open,
      close: p.close,
      ...(p.notIn !== undefined ? { notIn: [...p.notIn] } : {}),
    }))
  }
  if (config.surroundingPairs) {
    mapped.surroundingPairs = config.surroundingPairs.map((p) => ({ ...p }))
  }
  if (config.wordPattern !== undefined) {
    try {
      mapped.wordPattern = new RegExp(config.wordPattern)
    } catch {
      // Uncompilable word pattern: ignore (VSCode logs and continues too).
    }
  }
  return mapped
}

export class MainThreadLanguages extends Disposable implements IMainThreadLanguages {
  private readonly _providers = this._register(new DisposableMap<number>())
  /** Per-handle Monaco disposable for `$setLanguageConfiguration` registrations. */
  private readonly _languageConfigurations = this._register(new DisposableMap<number>())
  /** Per-handle refresh signal for CodeLens providers: the host calls
   *  `$emitCodeLensDidChange(handle)` and we fire the Emitter the provider's
   *  `onDidChange` is wired to, making Monaco re-request that provider's lenses. */
  private readonly _codeLensChange = new Map<number, Emitter<void>>()
  /** Per-handle refresh signal for inlay-hints providers — same wiring as
   *  `_codeLensChange`, driven by `$emitInlayHintsDidChange(handle)`. */
  private readonly _inlayHintsChange = new Map<number, Emitter<void>>()
  /** Per-handle refresh signal for document-semantic-tokens providers, driven by
   *  `$emitSemanticTokensDidChange(handle)`. */
  private readonly _semanticTokensChange = new Map<number, Emitter<void>>()
  /** Live `onDidChangeDiagnostics` listeners on the host; pushes only flow
   *  while this is non-zero (see MainThreadFileEvents for the same pattern). */
  private _diagnosticsInterest = 0
  private readonly _pendingDiagnosticUris = new Map<string, UriComponents>()
  private _diagnosticsPushTimer: ReturnType<typeof setTimeout> | undefined
  private _markerListener: IDisposable | undefined

  private readonly _logger: ILogger

  constructor(
    private readonly _extHost: IExtHostLanguages,
    private readonly _languageFeatures: ILanguageFeaturesService,
    logger?: ILogger,
  ) {
    super()
    // A self-created fallback roots through this store so the leak tracker does
    // not report it; an injected logger stays owned by the caller.
    this._logger = logger ?? this._register(new NullLogger())
    this._register(
      toDisposable(() => {
        this._markerListener?.dispose()
        if (this._diagnosticsPushTimer !== undefined) clearTimeout(this._diagnosticsPushTimer)
      }),
    )
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

  async $getDiagnostics(uri?: UriComponents): Promise<Array<[UriComponents, Diagnostic[]]>> {
    const monacoNs = await MonacoLoader.ensureInitialized()
    if (this._store.isDisposed) return []
    const revived = uri ? URI.revive(uri) : undefined
    const markers: readonly monaco.editor.IMarker[] = monacoNs.editor.getModelMarkers(
      revived ? { resource: monacoNs.Uri.parse(revived.toString()) } : {},
    )
    const byResource = new Map<string, [UriComponents, Diagnostic[]]>()
    for (const marker of markers) {
      const key = marker.resource.toString()
      let entry = byResource.get(key)
      if (!entry) {
        entry = [URI.parse(key).toJSON(), []]
        byResource.set(key, entry)
      }
      entry[1].push(markerToLspDiagnostic(marker))
    }
    return [...byResource.values()]
  }

  $subscribeDiagnostics(): Promise<void> {
    this._diagnosticsInterest++
    if (this._diagnosticsInterest === 1) this._armMarkerListener()
    return Promise.resolve()
  }

  $unsubscribeDiagnostics(): Promise<void> {
    this._diagnosticsInterest = Math.max(0, this._diagnosticsInterest - 1)
    if (this._diagnosticsInterest === 0) {
      this._markerListener?.dispose()
      this._markerListener = undefined
      if (this._diagnosticsPushTimer !== undefined) {
        clearTimeout(this._diagnosticsPushTimer)
        this._diagnosticsPushTimer = undefined
        this._pendingDiagnosticUris.clear()
      }
    }
    return Promise.resolve()
  }

  private _armMarkerListener(): void {
    if (this._markerListener || this._store.isDisposed || this._diagnosticsInterest === 0) return
    const monacoNs = MonacoLoader.peek()
    if (!monacoNs) {
      // Monaco hasn't loaded yet, so no markers exist to observe. Arm once the
      // load completes (any provider registration forces the same load); marker
      // changes can't happen before that, so nothing is missed.
      void MonacoLoader.ensureInitialized().then(() => this._armMarkerListener())
      return
    }
    this._markerListener = monacoNs.editor.onDidChangeMarkers((resources) => {
      for (const resource of resources) {
        const key = resource.toString()
        this._pendingDiagnosticUris.set(key, URI.parse(key).toJSON())
      }
      this._scheduleDiagnosticsPush()
    })
    this._logger.debug('[MainThreadLanguages] diagnostics change pushes armed')
  }

  private _scheduleDiagnosticsPush(): void {
    if (this._diagnosticsPushTimer !== undefined) return
    this._diagnosticsPushTimer = setTimeout(() => {
      this._diagnosticsPushTimer = undefined
      if (this._store.isDisposed || this._diagnosticsInterest === 0) {
        this._pendingDiagnosticUris.clear()
        return
      }
      const uris = [...this._pendingDiagnosticUris.values()]
      this._pendingDiagnosticUris.clear()
      void this._extHost.$acceptDiagnosticsChange(uris).catch((err: unknown) => {
        this._logger.warn(
          `[MainThreadLanguages] diagnostics change push failed: ${(err as Error).message}`,
        )
      })
    }, DIAGNOSTICS_CHANGE_DEBOUNCE_MS)
  }

  $emitCodeLensDidChange(handle: number): void {
    this._codeLensChange.get(handle)?.fire()
  }

  $emitInlayHintsDidChange(handle: number): void {
    this._inlayHintsChange.get(handle)?.fire()
  }

  $emitSemanticTokensDidChange(handle: number): void {
    this._semanticTokensChange.get(handle)?.fire()
  }

  async $getLanguages(): Promise<string[]> {
    const monacoNs = await MonacoLoader.ensureInitialized()
    return monacoNs.languages.getLanguages().map((l) => l.id)
  }

  $setLanguageServerStatus(id: string, status: LanguageServerStatus): void {
    this._languageFeatures.setLanguageServerStatus(id, status)
  }

  async $setTextDocumentLanguage(uri: UriComponents, languageId: string): Promise<void> {
    const monacoNs = await MonacoLoader.ensureInitialized()
    const resource = URI.revive(uri)
    if (!resource) {
      throw new Error(`setTextDocumentLanguage: invalid URI ${JSON.stringify(uri)}`)
    }
    const model = monacoNs.editor.getModel(monacoNs.Uri.parse(resource.toString()))
    if (!model || model.isDisposed()) {
      throw new Error(`setTextDocumentLanguage: no open document for ${resource.toString()}`)
    }
    // This fires the model's onDidChangeLanguage, which DocumentSyncContribution
    // mirrors to the host as close(old language) + open(new language).
    monacoNs.editor.setModelLanguage(model, languageId)
  }

  async $setLanguageConfiguration(
    handle: number,
    languageId: string,
    configuration: ILanguageConfigurationDto,
  ): Promise<void> {
    const monacoNs = await MonacoLoader.ensureInitialized()
    if (this._store.isDisposed) return
    this._languageConfigurations.set(
      handle,
      monacoNs.languages.setLanguageConfiguration(
        languageId,
        toLanguageConfigurationMapping(configuration),
      ),
    )
  }

  async $unregisterLanguageConfiguration(handle: number): Promise<void> {
    await MonacoLoader.ensureInitialized()
    this._languageConfigurations.deleteAndDispose(handle)
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
      case 'documentRangeFormatting': {
        const p = createDocumentRangeFormattingProxy(handle, ext)
        for (const lang of selector) {
          store.add(lf.registerDocumentRangeFormattingEditProvider(lang, p))
        }
        break
      }
      case 'onTypeFormatting': {
        // Trigger characters ride the registration metadata: Monaco reads
        // autoFormatTriggerCharacters synchronously off the provider object.
        const p = createOnTypeFormattingProxy(
          handle,
          ext,
          metadata?.onTypeFormattingTriggerCharacters ?? [],
        )
        for (const lang of selector) store.add(lf.registerOnTypeFormattingEditProvider(lang, p))
        break
      }
      case 'inlayHints': {
        const changeEmitter = new Emitter<void>()
        this._inlayHintsChange.set(handle, changeEmitter)
        store.add(toDisposable(() => this._inlayHintsChange.delete(handle)))
        store.add(changeEmitter)
        // inlayHintsResolve rides the metadata: the resolve shell is only
        // attached when the extension provider implements resolveInlayHint.
        const p = createInlayHintsProxy(
          handle,
          ext,
          changeEmitter.event,
          metadata?.inlayHintsResolve === true,
        )
        for (const lang of selector) store.add(lf.registerInlayHintsProvider(lang, p))
        break
      }
      case 'documentSemanticTokens': {
        // The legend rides along in metadata: Monaco's getLegend() is synchronous,
        // so it must be known at registration time, not fetched per request.
        const legend = metadata?.semanticTokensLegend
        if (legend) {
          const changeEmitter = new Emitter<void>()
          this._semanticTokensChange.set(handle, changeEmitter)
          store.add(toDisposable(() => this._semanticTokensChange.delete(handle)))
          store.add(changeEmitter)
          const p = createDocumentSemanticTokensProxy(
            handle,
            ext,
            legend,
            changeEmitter.event,
            store,
          )
          for (const lang of selector) {
            store.add(lf.registerDocumentSemanticTokensProvider(lang, p))
          }
        }
        break
      }
      case 'documentRangeSemanticTokens': {
        const legend = metadata?.semanticTokensLegend
        if (legend) {
          const p = createDocumentRangeSemanticTokensProxy(handle, ext, legend)
          for (const lang of selector) {
            store.add(lf.registerDocumentRangeSemanticTokensProvider(lang, p))
          }
        }
        break
      }
      case 'codeLens': {
        const changeEmitter = new Emitter<void>()
        this._codeLensChange.set(handle, changeEmitter)
        store.add(toDisposable(() => this._codeLensChange.delete(handle)))
        store.add(changeEmitter)
        const p = createCodeLensProxy(handle, ext, changeEmitter.event, store)
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
