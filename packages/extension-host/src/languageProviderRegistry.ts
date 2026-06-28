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
  CompletionItemProvider,
  DefinitionProvider,
  DiagnosticCollection,
  Disposable,
  DocumentSelector,
  DocumentSymbolProvider,
  FoldingRangeProvider,
  HoverProvider,
  ImplementationProvider,
  ReferenceProvider,
  RenameProvider,
  SignatureHelpProvider,
  SignatureHelpProviderMetadata,
  TypeDefinitionProvider,
  UriComponents,
  WorkspaceSymbolProvider,
} from '@universe-editor/extension-api'
import {
  type ICompletionContext,
  type ILanguageProviderMetadata,
  type IMainThreadLanguages,
  type IReferenceContext,
  type ISignatureHelpContext,
  type LanguageProviderType,
} from '@universe-editor/extensions-common'
import type {
  CompletionItem,
  CompletionList,
  Definition,
  DefinitionLink,
  Diagnostic,
  DocumentSymbol,
  FoldingRange,
  Hover,
  Location,
  Position,
  SignatureHelp,
  SymbolInformation,
  WorkspaceEdit,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'
import type { ExtHostDocuments } from './hostDocuments.js'

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

interface RegisteredProvider {
  readonly type: LanguageProviderType
  readonly provider: AnyLanguageProvider
}

function toSelector(selector: DocumentSelector): readonly string[] {
  return typeof selector === 'string' ? [selector] : selector
}

/**
 * Host-side DiagnosticCollection. `set`/`clear` push markers to the renderer
 * over `mainThreadLanguages`, keyed by the collection name (the marker owner).
 */
class HostDiagnosticCollection implements DiagnosticCollection {
  constructor(
    readonly name: string,
    private readonly _languages: IMainThreadLanguages,
  ) {}

  set(uri: UriComponents, diagnostics: readonly Diagnostic[] | undefined): void {
    if (diagnostics === undefined) {
      void this._languages.$clearDiagnostics(this.name, uri)
    } else {
      void this._languages.$publishDiagnostics(this.name, uri, diagnostics)
    }
  }

  delete(uri: UriComponents): void {
    void this._languages.$clearDiagnostics(this.name, uri)
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
    const provider = this._provider<WorkspaceSymbolProvider>(handle, 'workspaceSymbol')
    if (!provider) return null
    return (await provider.provideWorkspaceSymbols(query)) ?? null
  }

  async provideFoldingRanges(handle: number, uri: UriComponents): Promise<FoldingRange[] | null> {
    const provider = this._provider<FoldingRangeProvider>(handle, 'foldingRange')
    if (!provider) return null
    return (await provider.provideFoldingRanges(this._documents.getOrSynthesize(uri))) ?? null
  }
}
