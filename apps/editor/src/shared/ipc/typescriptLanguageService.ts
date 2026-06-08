/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for the TS/JS language service, exposed to the renderer.
 *
 *  The MAIN process is the LSP client host: it spawns the vendored
 *  `typescript-language-server` (which drives TypeScript's bundled tsserver),
 *  owns the standard-LSP connection (vscode-jsonrpc over stdio) and exposes this
 *  clean service to the renderer via ProxyChannel. The renderer's Monaco
 *  providers / Outline / diagnostics consume it and never touch raw LSP.
 *
 *  Data types are re-exported straight from `vscode-languageserver-types` so both
 *  ends share one definition. They are type-only (the package contributes a tiny
 *  amount of runtime, but we import `type`s exclusively here) and every LSP
 *  payload is plain-JSON serializable, so it crosses the ProxyChannel verbatim —
 *  no hand-written DTOs, no field drift. Positions are LSP 0-based; the renderer
 *  conversion layer (`lspMonacoConvert.ts`) maps to/from Monaco's 1-based model.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event, UriComponents } from '@universe-editor/platform'
import type {
  CompletionItem,
  CompletionList,
  Definition,
  DefinitionLink,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  Position,
  SignatureHelp,
  SymbolInformation,
  WorkspaceEdit,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'

export type {
  CompletionItem,
  CompletionList,
  Definition,
  DefinitionLink,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  MarkupContent,
  Position,
  Range,
  SignatureHelp,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'

/** Payload of {@link ITypescriptLanguageService.onDidPublishDiagnostics}. */
export interface TsPublishDiagnosticsEvent {
  readonly uri: UriComponents
  readonly version?: number
  readonly diagnostics: readonly Diagnostic[]
}

/** How a completion was triggered (mirrors LSP `CompletionTriggerKind`). */
export interface TsCompletionContext {
  readonly triggerKind: 1 | 2 | 3
  readonly triggerCharacter?: string
}

/** How a signature help session was triggered (mirrors LSP `SignatureHelpTriggerKind`). */
export interface TsSignatureHelpContext {
  readonly triggerKind: 1 | 2 | 3
  readonly triggerCharacter?: string
  readonly isRetrigger: boolean
}

/**
 * Renderer-facing facade over the typescript-language-server subprocess.
 *
 * Document sync (`didOpen`/`didChange`/`didClose`) pushes the renderer's open
 * Monaco models to the server; the `provide*` methods back the Monaco providers
 * (definition / references / implementation / type-definition / hover /
 * completion / signature help / document symbols / rename) and the Ctrl+T
 * workspace symbol picker. Diagnostics are PUSH (server-initiated
 * `publishDiagnostics`), surfaced via {@link onDidPublishDiagnostics}.
 *
 * URIs cross the wire as `UriComponents` (monaco.Uri serializes to that);
 * positions are LSP 0-based.
 */
export interface ITypescriptLanguageService {
  readonly _serviceBrand: undefined

  /** Fired after the server is respawned (crash recovery or workspace change).
   *  Listeners must re-push their open documents — main keeps no document text. */
  readonly onDidRestart: Event<void>

  /** Server-pushed diagnostics for an open document (red squiggles). */
  readonly onDidPublishDiagnostics: Event<TsPublishDiagnosticsEvent>

  /** Lazily spawn the server and complete the LSP initialize handshake
   *  (idempotent). The optional root scopes the project / workspace folders. */
  ensureStarted(workspaceRoot?: string): Promise<void>

  didOpen(uri: UriComponents, languageId: string, version: number, text: string): Promise<void>
  didChange(uri: UriComponents, version: number, text: string): Promise<void>
  didClose(uri: UriComponents): Promise<void>

  provideDefinition(
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null>
  provideReferences(
    uri: UriComponents,
    position: Position,
    includeDeclaration: boolean,
  ): Promise<Location[] | null>
  provideImplementation(
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null>
  provideTypeDefinition(
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null>

  provideHover(uri: UriComponents, position: Position): Promise<Hover | null>

  provideCompletion(
    uri: UriComponents,
    position: Position,
    context: TsCompletionContext,
  ): Promise<CompletionItem[] | CompletionList | null>
  resolveCompletion(item: CompletionItem): Promise<CompletionItem>

  provideSignatureHelp(
    uri: UriComponents,
    position: Position,
    context: TsSignatureHelpContext,
  ): Promise<SignatureHelp | null>

  provideDocumentSymbols(uri: UriComponents): Promise<DocumentSymbol[] | SymbolInformation[] | null>
  provideWorkspaceSymbols(query: string): Promise<WorkspaceSymbol[] | SymbolInformation[] | null>

  provideRenameEdits(
    uri: UriComponents,
    position: Position,
    newName: string,
  ): Promise<WorkspaceEdit | null>
}

export const ITypescriptLanguageService = createDecorator<ITypescriptLanguageService>(
  'typescriptLanguageService',
)
