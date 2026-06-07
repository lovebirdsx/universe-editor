/**
 * Wire protocol between the main process (LSP client host) and the markdown
 * language server subprocess.
 *
 * Two channels ride one full-duplex stdio protocol (platform ChannelClient/
 * ChannelServer over StdioFramingProtocol):
 *   - MdServerChannels.server : main → server (language-feature requests)
 *   - MdServerChannels.client : server → main (filesystem callbacks the server's
 *     IWorkspace makes to read/scan files the renderer hasn't opened)
 *
 * This module is intentionally dependency-free (pure types + a constant object).
 * The main process imports it via `@universe-editor/markdown-language-server/protocol`,
 * so it must never transitively pull in the language service / markdown-it.
 *
 * Positions/ranges are 0-based (LSP convention); the renderer converts to/from
 * Monaco's 1-based coordinates.
 */

export const MdServerChannels = {
  /** main → server: language feature requests + document sync notifications. */
  server: 'mdServer',
  /** server → main: gated filesystem the server's IWorkspace calls back on. */
  client: 'mdClient',
} as const

export type MdServerChannelName = (typeof MdServerChannels)[keyof typeof MdServerChannels]

// #region shared data types (0-based, LSP-shaped)

export interface MdPosition {
  readonly line: number
  readonly character: number
}

export interface MdRange {
  readonly start: MdPosition
  readonly end: MdPosition
}

export interface MdLocation {
  /** Target document URI as a string (`URI.toString()`). */
  readonly uri: string
  readonly range: MdRange
}

export interface MdDocumentSymbol {
  readonly name: string
  readonly detail?: string
  /** LSP SymbolKind numeric value. */
  readonly kind: number
  readonly range: MdRange
  readonly selectionRange: MdRange
  readonly children?: readonly MdDocumentSymbol[]
}

export interface MdWorkspaceSymbol {
  readonly name: string
  readonly kind: number
  readonly location: MdLocation
  readonly containerName?: string
}

export interface MdDiagnostic {
  readonly range: MdRange
  readonly message: string
  /** LSP DiagnosticSeverity: 1 Error, 2 Warning, 3 Information, 4 Hint. */
  readonly severity: number
  readonly code?: string | number
  readonly source?: string
}

export interface MdDiagnosticsEvent {
  readonly uri: string
  readonly version?: number
  readonly diagnostics: readonly MdDiagnostic[]
}

// #endregion

// #region main → server (language requests + document sync)

export interface MdTextDocumentDto {
  readonly uri: string
  readonly version: number
  readonly text: string
}

/**
 * Implemented by the server, called by the main process. `$ping` validates the
 * pipeline; the `$did*` methods sync the renderer's open documents; the
 * `$provide*` / `$computeDiagnostics` methods back the language features.
 */
export interface IMdServer {
  /** Liveness probe; resolves to `'pong'`. */
  $ping(): Promise<string>
  /** Open (or re-open) a document; renderer's editor content takes precedence over disk. */
  $didOpen(doc: MdTextDocumentDto): Promise<void>
  /** Full-text update for an open document (markdown files are small; no incremental sync). */
  $didChange(doc: MdTextDocumentDto): Promise<void>
  /** Drop the editor overlay; subsequent reads fall back to disk. */
  $didClose(uri: string): Promise<void>
  $provideDocumentSymbols(uri: string): Promise<readonly MdDocumentSymbol[]>
  $provideDefinition(uri: string, position: MdPosition): Promise<readonly MdLocation[]>
  $provideReferences(
    uri: string,
    position: MdPosition,
    includeDeclaration: boolean,
  ): Promise<readonly MdLocation[]>
  $provideWorkspaceSymbols(query: string): Promise<readonly MdWorkspaceSymbol[]>
  $computeDiagnostics(uri: string): Promise<readonly MdDiagnostic[]>
}

// #endregion

// #region server → main (filesystem callbacks)

export type MdFileType = 'file' | 'dir'

export interface MdFileStat {
  readonly type: MdFileType
  readonly mtime: number
  readonly size: number
}

/**
 * Implemented by the main process, called by the server's IWorkspace. Backs
 * reading/scanning workspace files the renderer hasn't opened. All URIs cross
 * the wire as strings.
 */
export interface IMdClient {
  /** Read a UTF-8 text file; `undefined` if it doesn't exist / can't be read. */
  $readFile(uri: string): Promise<string | undefined>
  $stat(uri: string): Promise<MdFileStat | undefined>
  $readDirectory(uri: string): Promise<ReadonlyArray<readonly [string, MdFileType]>>
  /** All markdown file URIs under the workspace root (recursive, ignoring node_modules etc.). */
  $findMarkdownFiles(): Promise<readonly string[]>
}

// #endregion
