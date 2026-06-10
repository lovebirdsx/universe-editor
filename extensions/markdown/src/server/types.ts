/**
 * Types shared between the in-process markdown language server and the plugin
 * that drives it. The server runs directly in the extension host (plain Node),
 * so there is no wire / subprocess: `IMdServer` returns standard LSP types
 * (`vscode-languageserver-types`) verbatim, and the plugin hands them straight
 * to the language-feature handle routing.
 *
 * `IMdClient` is the filesystem port the server's IWorkspace calls back on to
 * read/scan files the renderer hasn't opened; the plugin backs it with the gated
 * `workspace.fs`. Keeping it an interface lets the server be unit-tested with a
 * stub client.
 *
 * Positions/ranges are 0-based (LSP convention); the renderer converts to/from
 * Monaco's 1-based coordinates.
 */
import type {
  Diagnostic,
  DocumentSymbol,
  Location,
  Position,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'

export interface MdTextDocumentDto {
  readonly uri: string
  readonly version: number
  readonly text: string
}

/**
 * The language-feature surface, implemented by the server. The `$did*` methods
 * sync the renderer's open documents; the `$provide*` / `$computeDiagnostics`
 * methods back the language features and return standard LSP types.
 */
export interface IMdServer {
  /** Open (or re-open) a document; renderer's editor content takes precedence over disk. */
  $didOpen(doc: MdTextDocumentDto): Promise<void>
  /** Full-text update for an open document (markdown files are small; no incremental sync). */
  $didChange(doc: MdTextDocumentDto): Promise<void>
  /** Drop the editor overlay; subsequent reads fall back to disk. */
  $didClose(uri: string): Promise<void>
  $provideDocumentSymbols(uri: string): Promise<DocumentSymbol[]>
  $provideDefinition(uri: string, position: Position): Promise<Location[]>
  $provideReferences(
    uri: string,
    position: Position,
    includeDeclaration: boolean,
  ): Promise<Location[]>
  $provideWorkspaceSymbols(query: string): Promise<WorkspaceSymbol[]>
  $computeDiagnostics(uri: string): Promise<Diagnostic[]>
}

export type MdFileType = 'file' | 'dir'

export interface MdFileStat {
  readonly type: MdFileType
  readonly mtime: number
  readonly size: number
}

/**
 * Filesystem port the server's IWorkspace calls back on, backed by the plugin's
 * gated `workspace.fs`. All URIs are strings.
 */
export interface IMdClient {
  /** Read a UTF-8 text file; `undefined` if it doesn't exist / can't be read. */
  $readFile(uri: string): Promise<string | undefined>
  $stat(uri: string): Promise<MdFileStat | undefined>
  $readDirectory(uri: string): Promise<ReadonlyArray<readonly [string, MdFileType]>>
  /** All markdown file URIs under the workspace root (recursive, ignoring node_modules etc.). */
  $findMarkdownFiles(): Promise<readonly string[]>
}
