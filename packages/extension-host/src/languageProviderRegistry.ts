/**
 * Language-provider registry for the extension host. Owns the handle → provider
 * map for every language feature an extension registers (definition, hover,
 * completion, …), ships the registration to the renderer's MainThreadLanguages,
 * and routes the renderer's `provide*` RPC back to the right provider. Also backs
 * `createDiagnosticCollection`.
 *
 * Split out of extensionService.ts: registration/routing is a self-contained
 * concern with its own handle counter, so it lives here and the service holds one
 * instance.
 */
import type {
  CodeActionProvider,
  CodeLensProvider,
  CompletionItemProvider,
  DefinitionProvider,
  DiagnosticCollection,
  Disposable,
  DocumentFormattingEditProvider,
  DocumentHighlightProvider,
  DocumentLinkProvider,
  DocumentRangeFormattingEditProvider,
  DocumentSelector,
  DocumentSemanticTokensProvider,
  DocumentSymbolProvider,
  FoldingRangeProvider,
  HoverProvider,
  ImplementationProvider,
  InlayHintsProvider,
  OnTypeFormattingEditProvider,
  ReferenceProvider,
  RenameProvider,
  SelectionRangeProvider,
  SignatureHelpProvider,
  SignatureHelpProviderMetadata,
  TypeDefinitionProvider,
  UriComponents,
  WorkspaceSymbolProvider,
} from '@universe-editor/extension-api'
import {
  type ICodeActionContext,
  type ICompletionContext,
  type IFormattingOptionsDto,
  type IInlayHintDto,
  type ILanguageProviderMetadata,
  type IMainThreadLanguages,
  type IReferenceContext,
  type ISignatureHelpContext,
  type LanguageProviderType,
} from '@universe-editor/extensions-common'
import type {
  CodeAction,
  CodeLens,
  CompletionItem,
  CompletionList,
  Definition,
  DefinitionLink,
  Diagnostic,
  DocumentHighlight,
  DocumentLink,
  DocumentSymbol,
  FoldingRange,
  Hover,
  InlayHint,
  Location,
  Position,
  Range,
  SelectionRange,
  SemanticTokens,
  SignatureHelp,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'
import type { ExtHostDocuments } from './hostDocuments.js'
import { reviveWireUri } from './wireUri.js'
import { CancellationTokenSource } from '@universe-editor/platform'

/** Any of the language providers a plugin can register, keyed by its handle. */
type AnyLanguageProvider =
  | DefinitionProvider
  | ReferenceProvider
  | ImplementationProvider
  | TypeDefinitionProvider
  | HoverProvider
  | CompletionItemProvider
  | SignatureHelpProvider
  | DocumentSymbolProvider
  | RenameProvider
  | WorkspaceSymbolProvider
  | FoldingRangeProvider
  | DocumentLinkProvider
  | DocumentHighlightProvider
  | SelectionRangeProvider
  | CodeActionProvider
  | DocumentFormattingEditProvider
  | CodeLensProvider
  | DocumentSemanticTokensProvider
  | DocumentRangeFormattingEditProvider
  | OnTypeFormattingEditProvider
  | InlayHintsProvider

interface RegisteredProvider {
  readonly type: LanguageProviderType
  readonly provider: AnyLanguageProvider
}

function toSelector(selector: DocumentSelector): readonly string[] {
  return typeof selector === 'string' ? [selector] : selector
}

/** Strip the opaque `data` resolve payload: it never crosses the wire. */
function toInlayHintDto(hint: InlayHint): IInlayHintDto {
  const { data: _data, ...dto } = hint
  return dto
}

/**
 * Host-side DiagnosticCollection. `set`/`clear` push markers to the renderer
 * over `mainThreadLanguages`, keyed by the collection name (the marker owner).
 * The uri is revived at this wire boundary (see wireUri.ts): extensions may
 * hand in raw components without `$mid` (the TS built-in hand-builds them),
 * which the remote codec's URI transformer would otherwise miss.
 */
class HostDiagnosticCollection implements DiagnosticCollection {
  constructor(
    readonly name: string,
    private readonly _languages: IMainThreadLanguages,
  ) {}

  set(uri: UriComponents, diagnostics: readonly Diagnostic[] | undefined): void {
    if (diagnostics === undefined) {
      void this._languages.$clearDiagnostics(this.name, reviveWireUri(uri))
    } else {
      void this._languages.$publishDiagnostics(this.name, reviveWireUri(uri), diagnostics)
    }
  }

  delete(uri: UriComponents): void {
    void this._languages.$clearDiagnostics(this.name, reviveWireUri(uri))
  }

  clear(): void {
    void this._languages.$clearDiagnostics(this.name)
  }

  dispose(): void {
    this.clear()
  }
}

export class LanguageProviderRegistry {
  private readonly _providers = new Map<number, RegisteredProvider>()
  private _languageHandle = 0
  private _diagnosticHandle = 0
  /** In-flight workspace-symbol queries by provider handle (for cancellation). */
  private readonly _workspaceSymbolRequests = new Map<number, CancellationTokenSource>()
  /**
   * Original inlay-hint objects per provider handle, keyed by a cache id that
   * bumps on every provide round (latest-wins). The renderer only sees DTOs
   * stripped of `data`; `$resolveInlayHint` addresses the originals through
   * (cacheId, index) so the extension gets its own object — `data` included —
   * back for lazy resolution.
   */
  private readonly _inlayHintCache = new Map<number, { cacheId: number; hints: InlayHint[] }>()
  private _inlayHintCacheId = 0

  /**
   * `languages` is an accessor (not the value) so the "not available in this
   * host" error surfaces at registration time rather than construction time,
   * matching the original lazy behavior.
   */
  constructor(
    private readonly _languages: () => IMainThreadLanguages,
    private readonly _documents: ExtHostDocuments,
  ) {}

  private _register(
    type: LanguageProviderType,
    selector: DocumentSelector,
    provider: AnyLanguageProvider,
    metadata?: ILanguageProviderMetadata,
  ): Disposable {
    const languages = this._languages()
    const handle = this._languageHandle++
    this._providers.set(handle, { type, provider })
    void languages.$registerProvider(handle, type, toSelector(selector), metadata)
    return {
      dispose: () => {
        if (this._providers.delete(handle)) void languages.$unregisterProvider(handle)
      },
    }
  }

  registerDefinitionProvider(selector: DocumentSelector, provider: DefinitionProvider): Disposable {
    return this._register('definition', selector, provider)
  }

  registerReferenceProvider(selector: DocumentSelector, provider: ReferenceProvider): Disposable {
    return this._register('references', selector, provider)
  }

  registerImplementationProvider(
    selector: DocumentSelector,
    provider: ImplementationProvider,
  ): Disposable {
    return this._register('implementation', selector, provider)
  }

  registerTypeDefinitionProvider(
    selector: DocumentSelector,
    provider: TypeDefinitionProvider,
  ): Disposable {
    return this._register('typeDefinition', selector, provider)
  }

  registerHoverProvider(selector: DocumentSelector, provider: HoverProvider): Disposable {
    return this._register('hover', selector, provider)
  }

  registerCompletionItemProvider(
    selector: DocumentSelector,
    provider: CompletionItemProvider,
    triggerCharacters: readonly string[],
  ): Disposable {
    return this._register(
      'completion',
      selector,
      provider,
      triggerCharacters.length > 0 ? { triggerCharacters } : undefined,
    )
  }

  registerSignatureHelpProvider(
    selector: DocumentSelector,
    provider: SignatureHelpProvider,
    metadata: SignatureHelpProviderMetadata,
  ): Disposable {
    return this._register('signatureHelp', selector, provider, {
      signatureHelpTriggerCharacters: metadata.triggerCharacters,
      signatureHelpRetriggerCharacters: metadata.retriggerCharacters,
    })
  }

  registerDocumentSymbolProvider(
    selector: DocumentSelector,
    provider: DocumentSymbolProvider,
  ): Disposable {
    return this._register('documentSymbol', selector, provider)
  }

  registerRenameProvider(selector: DocumentSelector, provider: RenameProvider): Disposable {
    return this._register('rename', selector, provider)
  }

  registerWorkspaceSymbolProvider(provider: WorkspaceSymbolProvider): Disposable {
    return this._register('workspaceSymbol', [], provider)
  }

  registerFoldingRangeProvider(
    selector: DocumentSelector,
    provider: FoldingRangeProvider,
  ): Disposable {
    return this._register('foldingRange', selector, provider)
  }

  registerDocumentLinkProvider(
    selector: DocumentSelector,
    provider: DocumentLinkProvider,
  ): Disposable {
    return this._register('documentLink', selector, provider)
  }

  registerDocumentHighlightProvider(
    selector: DocumentSelector,
    provider: DocumentHighlightProvider,
  ): Disposable {
    return this._register('documentHighlight', selector, provider)
  }

  registerSelectionRangeProvider(
    selector: DocumentSelector,
    provider: SelectionRangeProvider,
  ): Disposable {
    return this._register('selectionRange', selector, provider)
  }

  registerCodeActionsProvider(
    selector: DocumentSelector,
    provider: CodeActionProvider,
  ): Disposable {
    return this._register('codeAction', selector, provider)
  }

  registerDocumentFormattingEditProvider(
    selector: DocumentSelector,
    provider: DocumentFormattingEditProvider,
  ): Disposable {
    return this._register('documentFormatting', selector, provider)
  }

  registerDocumentRangeFormattingEditProvider(
    selector: DocumentSelector,
    provider: DocumentRangeFormattingEditProvider,
  ): Disposable {
    return this._register('documentRangeFormatting', selector, provider)
  }

  registerOnTypeFormattingEditProvider(
    selector: DocumentSelector,
    provider: OnTypeFormattingEditProvider,
    triggerCharacters: readonly string[],
  ): Disposable {
    return this._register(
      'onTypeFormatting',
      selector,
      provider,
      triggerCharacters.length > 0
        ? { onTypeFormattingTriggerCharacters: triggerCharacters }
        : undefined,
    )
  }

  registerDocumentSemanticTokensProvider(
    selector: DocumentSelector,
    provider: DocumentSemanticTokensProvider,
  ): Disposable {
    return this._register('documentSemanticTokens', selector, provider, {
      semanticTokensLegend: provider.legend,
    })
  }

  /**
   * CodeLens is the one feature whose provider can signal "my lenses changed"
   * (`onDidChangeCodeLenses`). We inline the registration (rather than reuse
   * `_register`) to capture the allocated handle and forward that signal to the
   * renderer as `$emitCodeLensDidChange(handle)`, which makes Monaco re-request.
   */
  registerCodeLensProvider(selector: DocumentSelector, provider: CodeLensProvider): Disposable {
    const languages = this._languages()
    const handle = this._languageHandle++
    this._providers.set(handle, { type: 'codeLens', provider })
    void languages.$registerProvider(handle, 'codeLens', toSelector(selector))
    const changeSub = provider.onDidChangeCodeLenses?.(() => {
      languages.$emitCodeLensDidChange(handle)
    })
    return {
      dispose: () => {
        changeSub?.dispose()
        if (this._providers.delete(handle)) void languages.$unregisterProvider(handle)
      },
    }
  }

  /**
   * Inlay hints carry the same server-driven refresh signal as CodeLens
   * (`onDidChangeInlayHints`), so registration follows the same inline shape:
   * capture the handle and forward the signal as `$emitInlayHintsDidChange(handle)`.
   * When the provider implements `resolveInlayHint`, that fact rides the
   * registration metadata so the renderer attaches a lazy-resolve shell.
   */
  registerInlayHintsProvider(selector: DocumentSelector, provider: InlayHintsProvider): Disposable {
    const languages = this._languages()
    const handle = this._languageHandle++
    this._providers.set(handle, { type: 'inlayHints', provider })
    void languages.$registerProvider(
      handle,
      'inlayHints',
      toSelector(selector),
      provider.resolveInlayHint ? { inlayHintsResolve: true } : undefined,
    )
    const changeSub = provider.onDidChangeInlayHints?.(() => {
      languages.$emitInlayHintsDidChange(handle)
    })
    return {
      dispose: () => {
        changeSub?.dispose()
        this._inlayHintCache.delete(handle)
        if (this._providers.delete(handle)) void languages.$unregisterProvider(handle)
      },
    }
  }

  createDiagnosticCollection(name?: string): DiagnosticCollection {
    return new HostDiagnosticCollection(
      name ?? `diagnostics-${this._diagnosticHandle++}`,
      this._languages(),
    )
  }

  // --- RPC surface (called from the renderer) ---

  private _provider<T extends AnyLanguageProvider>(
    handle: number,
    type: LanguageProviderType,
  ): T | undefined {
    const entry = this._providers.get(handle)
    return entry && entry.type === type ? (entry.provider as T) : undefined
  }

  async provideDefinition(
    handle: number,
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null> {
    const provider = this._provider<DefinitionProvider>(handle, 'definition')
    if (!provider) return null
    return (
      (await provider.provideDefinition(this._documents.getOrSynthesize(uri), position)) ?? null
    )
  }

  async provideReferences(
    handle: number,
    uri: UriComponents,
    position: Position,
    context: IReferenceContext,
  ): Promise<Location[] | null> {
    const provider = this._provider<ReferenceProvider>(handle, 'references')
    if (!provider) return null
    return (
      (await provider.provideReferences(this._documents.getOrSynthesize(uri), position, context)) ??
      null
    )
  }

  async provideImplementation(
    handle: number,
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null> {
    const provider = this._provider<ImplementationProvider>(handle, 'implementation')
    if (!provider) return null
    return (
      (await provider.provideImplementation(this._documents.getOrSynthesize(uri), position)) ?? null
    )
  }

  async provideTypeDefinition(
    handle: number,
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null> {
    const provider = this._provider<TypeDefinitionProvider>(handle, 'typeDefinition')
    if (!provider) return null
    return (
      (await provider.provideTypeDefinition(this._documents.getOrSynthesize(uri), position)) ?? null
    )
  }

  async provideHover(
    handle: number,
    uri: UriComponents,
    position: Position,
  ): Promise<Hover | null> {
    const provider = this._provider<HoverProvider>(handle, 'hover')
    if (!provider) return null
    return (await provider.provideHover(this._documents.getOrSynthesize(uri), position)) ?? null
  }

  async provideCompletion(
    handle: number,
    uri: UriComponents,
    position: Position,
    context: ICompletionContext,
  ): Promise<CompletionItem[] | CompletionList | null> {
    const provider = this._provider<CompletionItemProvider>(handle, 'completion')
    if (!provider) return null
    return (
      (await provider.provideCompletionItems(
        this._documents.getOrSynthesize(uri),
        position,
        context,
      )) ?? null
    )
  }

  async resolveCompletionItem(handle: number, item: CompletionItem): Promise<CompletionItem> {
    const provider = this._provider<CompletionItemProvider>(handle, 'completion')
    if (!provider?.resolveCompletionItem) return item
    return (await provider.resolveCompletionItem(item)) ?? item
  }

  async provideSignatureHelp(
    handle: number,
    uri: UriComponents,
    position: Position,
    context: ISignatureHelpContext,
  ): Promise<SignatureHelp | null> {
    const provider = this._provider<SignatureHelpProvider>(handle, 'signatureHelp')
    if (!provider) return null
    return (
      (await provider.provideSignatureHelp(
        this._documents.getOrSynthesize(uri),
        position,
        context,
      )) ?? null
    )
  }

  async provideDocumentSymbols(
    handle: number,
    uri: UriComponents,
  ): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    const provider = this._provider<DocumentSymbolProvider>(handle, 'documentSymbol')
    if (!provider) return null
    return (await provider.provideDocumentSymbols(this._documents.getOrSynthesize(uri))) ?? null
  }

  async provideRenameEdits(
    handle: number,
    uri: UriComponents,
    position: Position,
    newName: string,
  ): Promise<WorkspaceEdit | null> {
    const provider = this._provider<RenameProvider>(handle, 'rename')
    if (!provider) return null
    return (
      (await provider.provideRenameEdits(
        this._documents.getOrSynthesize(uri),
        position,
        newName,
      )) ?? null
    )
  }

  async provideWorkspaceSymbols(
    handle: number,
    query: string,
  ): Promise<WorkspaceSymbol[] | SymbolInformation[] | null> {
    // Latest-wins per handle: a new query supersedes the in-flight one (the
    // picker debounces keystrokes), so cancel it before starting — the TS
    // server serializes requests and a stale query would stall the fresh one.
    this.cancelWorkspaceSymbols(handle)
    const provider = this._provider<WorkspaceSymbolProvider>(handle, 'workspaceSymbol')
    if (!provider) return null
    const cts = new CancellationTokenSource()
    this._workspaceSymbolRequests.set(handle, cts)
    try {
      return (await provider.provideWorkspaceSymbols(query, cts.token)) ?? null
    } finally {
      if (this._workspaceSymbolRequests.get(handle) === cts) {
        this._workspaceSymbolRequests.delete(handle)
      }
      cts.dispose()
    }
  }

  /** Cancel the in-flight workspace-symbol query for `handle`, if any. */
  cancelWorkspaceSymbols(handle: number): void {
    const cts = this._workspaceSymbolRequests.get(handle)
    if (!cts) return
    this._workspaceSymbolRequests.delete(handle)
    cts.cancel()
    cts.dispose()
  }

  async provideFoldingRanges(handle: number, uri: UriComponents): Promise<FoldingRange[] | null> {
    const provider = this._provider<FoldingRangeProvider>(handle, 'foldingRange')
    if (!provider) return null
    return (await provider.provideFoldingRanges(this._documents.getOrSynthesize(uri))) ?? null
  }

  async provideDocumentLinks(handle: number, uri: UriComponents): Promise<DocumentLink[] | null> {
    const provider = this._provider<DocumentLinkProvider>(handle, 'documentLink')
    if (!provider) return null
    return (await provider.provideDocumentLinks(this._documents.getOrSynthesize(uri))) ?? null
  }

  async resolveDocumentLink(handle: number, link: DocumentLink): Promise<DocumentLink | null> {
    const provider = this._provider<DocumentLinkProvider>(handle, 'documentLink')
    if (!provider?.resolveDocumentLink) return null
    return (await provider.resolveDocumentLink(link)) ?? null
  }

  async provideDocumentHighlights(
    handle: number,
    uri: UriComponents,
    position: Position,
  ): Promise<DocumentHighlight[] | null> {
    const provider = this._provider<DocumentHighlightProvider>(handle, 'documentHighlight')
    if (!provider) return null
    return (
      (await provider.provideDocumentHighlights(this._documents.getOrSynthesize(uri), position)) ??
      null
    )
  }

  async provideSelectionRanges(
    handle: number,
    uri: UriComponents,
    positions: Position[],
  ): Promise<SelectionRange[] | null> {
    const provider = this._provider<SelectionRangeProvider>(handle, 'selectionRange')
    if (!provider) return null
    return (
      (await provider.provideSelectionRanges(this._documents.getOrSynthesize(uri), positions)) ??
      null
    )
  }

  async provideCodeActions(
    handle: number,
    uri: UriComponents,
    range: Range,
    context: ICodeActionContext,
  ): Promise<CodeAction[] | null> {
    const provider = this._provider<CodeActionProvider>(handle, 'codeAction')
    if (!provider) return null
    return (
      (await provider.provideCodeActions(this._documents.getOrSynthesize(uri), range, context)) ??
      null
    )
  }

  async provideDocumentFormattingEdits(
    handle: number,
    uri: UriComponents,
    options: IFormattingOptionsDto,
  ): Promise<TextEdit[] | null> {
    const provider = this._provider<DocumentFormattingEditProvider>(handle, 'documentFormatting')
    if (!provider) return null
    return (
      (await provider.provideDocumentFormattingEdits(
        this._documents.getOrSynthesize(uri),
        options,
      )) ?? null
    )
  }

  async provideDocumentRangeFormattingEdits(
    handle: number,
    uri: UriComponents,
    range: Range,
    options: IFormattingOptionsDto,
  ): Promise<TextEdit[] | null> {
    const provider = this._provider<DocumentRangeFormattingEditProvider>(
      handle,
      'documentRangeFormatting',
    )
    if (!provider) return null
    return (
      (await provider.provideDocumentRangeFormattingEdits(
        this._documents.getOrSynthesize(uri),
        range,
        options,
      )) ?? null
    )
  }

  async provideOnTypeFormattingEdits(
    handle: number,
    uri: UriComponents,
    position: Position,
    ch: string,
    options: IFormattingOptionsDto,
  ): Promise<TextEdit[] | null> {
    const provider = this._provider<OnTypeFormattingEditProvider>(handle, 'onTypeFormatting')
    if (!provider) return null
    return (
      (await provider.provideOnTypeFormattingEdits(
        this._documents.getOrSynthesize(uri),
        position,
        ch,
        options,
      )) ?? null
    )
  }

  async provideInlayHints(
    handle: number,
    uri: UriComponents,
    range: Range,
  ): Promise<IInlayHintDto[] | null> {
    const provider = this._provider<InlayHintsProvider>(handle, 'inlayHints')
    if (!provider) return null
    const hints =
      (await provider.provideInlayHints(this._documents.getOrSynthesize(uri), range)) ?? null
    if (!hints || !provider.resolveInlayHint) {
      this._inlayHintCache.delete(handle)
      return hints?.map(toInlayHintDto) ?? null
    }
    const cacheId = ++this._inlayHintCacheId
    this._inlayHintCache.set(handle, { cacheId, hints })
    return hints.map((hint, index) => ({
      ...toInlayHintDto(hint),
      resolveCacheId: cacheId,
      resolveIndex: index,
    }))
  }

  async resolveInlayHint(
    handle: number,
    cacheId: number,
    index: number,
  ): Promise<IInlayHintDto | null> {
    const provider = this._provider<InlayHintsProvider>(handle, 'inlayHints')
    if (!provider?.resolveInlayHint) return null
    const entry = this._inlayHintCache.get(handle)
    const hint = entry?.cacheId === cacheId ? entry.hints[index] : undefined
    if (!hint || !entry) return null
    const resolved = (await provider.resolveInlayHint(hint)) ?? hint
    // Re-resolving an already resolved hint must be a no-op for the provider,
    // so the cache tracks the resolved object (a stale cacheId still misses).
    if (this._inlayHintCache.get(handle) === entry) entry.hints[index] = resolved
    return toInlayHintDto(resolved)
  }

  async provideDocumentSemanticTokens(
    handle: number,
    uri: UriComponents,
  ): Promise<SemanticTokens | null> {
    const provider = this._provider<DocumentSemanticTokensProvider>(
      handle,
      'documentSemanticTokens',
    )
    if (!provider) return null
    return (
      (await provider.provideDocumentSemanticTokens(this._documents.getOrSynthesize(uri))) ?? null
    )
  }

  async provideCodeLenses(handle: number, uri: UriComponents): Promise<CodeLens[] | null> {
    const provider = this._provider<CodeLensProvider>(handle, 'codeLens')
    if (!provider) return null
    return (await provider.provideCodeLenses(this._documents.getOrSynthesize(uri))) ?? null
  }

  async resolveCodeLens(handle: number, lens: CodeLens): Promise<CodeLens | null> {
    const provider = this._provider<CodeLensProvider>(handle, 'codeLens')
    if (!provider?.resolveCodeLens) return null
    return (await provider.resolveCodeLens(lens)) ?? null
  }
}
