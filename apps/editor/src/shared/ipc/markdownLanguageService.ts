/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for the Markdown Language Server, exposed to the renderer.
 *
 *  Unlike the Extension Host (where the renderer owns the RPC and main is a byte
 *  pipe), here the MAIN process is the LSP client host: it spawns the server,
 *  owns the ChannelClient/Server over stdio, and exposes this clean service to
 *  the renderer via ProxyChannel. The renderer's Monaco providers / Outline /
 *  diagnostics consume it.
 *
 *  Data types are re-exported from the server package's dependency-free protocol
 *  module so both ends share one definition; importing them never pulls the
 *  language service into the renderer/main bundle.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event, UriComponents } from '@universe-editor/platform'
import type {
  MdDiagnostic,
  MdDocumentSymbol,
  MdLocation,
  MdPosition,
  MdWorkspaceSymbol,
} from '@universe-editor/markdown-language-server/protocol'

export type {
  MdPosition,
  MdRange,
  MdLocation,
  MdDocumentSymbol,
  MdWorkspaceSymbol,
  MdDiagnostic,
  MdDiagnosticsEvent,
} from '@universe-editor/markdown-language-server/protocol'

/**
 * Renderer-facing facade over the markdown language server subprocess.
 *
 * Document sync (`didOpen`/`didChange`/`didClose`) pushes the renderer's open
 * Monaco models to the server; the `provide*` methods back the Monaco providers
 * (document symbols / definition / references) and the Ctrl+T workspace symbol
 * picker. URIs cross the wire as `UriComponents` (monaco.Uri serializes to that).
 */
export interface IMarkdownLanguageService {
  readonly _serviceBrand: undefined

  /** Fired after the server is respawned (crash recovery or workspace change).
   *  Listeners must re-push their open documents — main keeps no document text. */
  readonly onDidRestart: Event<void>

  /** Lazily spawn the server (idempotent). The optional root scopes workspace scans. */
  ensureStarted(workspaceRoot?: string): Promise<void>

  didOpen(uri: UriComponents, version: number, text: string): Promise<void>
  didChange(uri: UriComponents, version: number, text: string): Promise<void>
  didClose(uri: UriComponents): Promise<void>

  provideDocumentSymbols(uri: UriComponents): Promise<readonly MdDocumentSymbol[]>
  provideDefinition(uri: UriComponents, position: MdPosition): Promise<readonly MdLocation[]>
  provideReferences(
    uri: UriComponents,
    position: MdPosition,
    includeDeclaration: boolean,
  ): Promise<readonly MdLocation[]>
  provideWorkspaceSymbols(query: string): Promise<readonly MdWorkspaceSymbol[]>
  /** Compute broken-link (and related) diagnostics for an open document. */
  provideDiagnostics(uri: UriComponents): Promise<readonly MdDiagnostic[]>
}

export const IMarkdownLanguageService =
  createDecorator<IMarkdownLanguageService>('markdownLanguageService')
