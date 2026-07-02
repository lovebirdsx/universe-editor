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
  CodeAction,
  CompletionItem,
  Diagnostic,
  DocumentHighlight,
  DocumentLink,
  DocumentSymbol,
  FoldingRange,
  Hover,
  Location,
  Position,
  Range,
  SelectionRange,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'

export interface MdTextDocumentDto {
  readonly uri: string
  readonly version: number
  readonly text: string
}

/** A single file rename/move, URIs as strings (already applied on disk). */
export interface MdFileRenameDto {
  readonly oldUri: string
  readonly newUri: string
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
  /**
   * Notify the service that files changed on disk out-of-band (e.g. a bulk edit
   * rewrote closed files' links). We have no filesystem watcher, so without this
   * the language-service caches keep the stale text and report broken links for
   * the pre-edit paths. URIs already open in an editor are ignored (their content
   * syncs via `$didChange`).
   */
  $didChangeFiles(uris: readonly string[]): Promise<void>
  $provideDocumentSymbols(uri: string): Promise<DocumentSymbol[]>
  $provideDefinition(uri: string, position: Position): Promise<Location[]>
  $provideReferences(
    uri: string,
    position: Position,
    includeDeclaration: boolean,
  ): Promise<Location[]>
  $provideWorkspaceSymbols(query: string): Promise<WorkspaceSymbol[]>
  $provideFoldingRanges(uri: string): Promise<FoldingRange[]>
  $provideHover(uri: string, position: Position): Promise<Hover | null>
  /** Path/fragment/reference completions (`[](`, `#`, `[ref]`); markdown-specific. */
  $provideCompletion(uri: string, position: Position): Promise<CompletionItem[]>
  /** Renaming a header rewrites every link that targets it; `null` if not renameable here. */
  $provideRenameEdits(
    uri: string,
    position: Position,
    newName: string,
  ): Promise<WorkspaceEdit | null>
  /** All links in the document; targets are filled in lazily by `$resolveDocumentLink`. */
  $provideDocumentLinks(uri: string): Promise<DocumentLink[]>
  /** Fill in a link's `target`; `null` to keep the link as-is. */
  $resolveDocumentLink(link: DocumentLink): Promise<DocumentLink | null>
  /** Occurrences of the header/link at `position` within the document. */
  $provideDocumentHighlights(uri: string, position: Position): Promise<DocumentHighlight[]>
  /** Smart-select ranges (one chain per requested position). */
  $provideSelectionRanges(uri: string, positions: Position[]): Promise<SelectionRange[]>
  /** Quick-fixes / refactors for `range`; the server recomputes diagnostics itself. */
  $provideCodeActions(uri: string, range: Range, only: readonly string[]): Promise<CodeAction[]>
  /** Text edits that group/sort link definitions at the bottom (optionally drop unused). */
  $organizeLinkDefinitions(uri: string): Promise<TextEdit[]>
  /** All links across the workspace that point at `uri` ("find references to this file"). */
  $getFileReferences(uri: string): Promise<Location[]>
  /**
   * Edits that update every link affected by moving files: links across the
   * workspace pointing at the moved files, plus the moved markdown files' own
   * relative links. Must be called *after* the filesystem rename has happened
   * (the language service assumes the new paths already exist on disk). `null`
   * when no link needs updating.
   */
  $getRenameFileEdits(renames: readonly MdFileRenameDto[]): Promise<WorkspaceEdit | null>
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
