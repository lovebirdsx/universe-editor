/**
 * The `webview` / custom-editor surface — the Universe equivalent of VSCode's
 * webview + `CustomReadonlyEditorProvider` API. An extension registers a custom
 * editor for a `viewType` (bound to files by the manifest's
 * `contributes.customEditors`); when the user opens a matching file the host
 * calls `resolveCustomEditor` with a {@link WebviewPanel} whose {@link Webview}
 * renders arbitrary HTML in a sandboxed iframe owned by the workbench.
 *
 * Every object here is a host-side handle mirrored to the renderer over RPC:
 * `webview.html`/`options` writes flow host → renderer; `postMessage` flows both
 * ways; the iframe and its lifecycle are owned by the editor (extensions only
 * provide the content, exactly like VSCode).
 */
import type { Event, UriComponents } from './index.js'

/** What a webview is allowed to do. Mirrors VSCode's `WebviewOptions` subset. */
export interface WebviewOptions {
  /** Allow `<script>` execution inside the iframe. Off → static content only. */
  readonly enableScripts?: boolean
  /**
   * Directories the webview may load local resources from via
   * {@link Webview.asWebviewUri}. The extension's own directory is always allowed;
   * these extend the allow-list (e.g. the opened document's folder). Paths outside
   * every root are refused by the resource protocol handler.
   */
  readonly localResourceRoots?: readonly UriComponents[]
}

/**
 * The content surface of a {@link WebviewPanel}. `html` and `options` are
 * write-through to the renderer's iframe; `postMessage` / `onDidReceiveMessage`
 * are the two-way channel to the scripts running inside it.
 */
export interface Webview {
  /** Capabilities + resource roots. Set before assigning `html`. */
  options: WebviewOptions
  /** The iframe's document. Assigning re-renders the webview. */
  html: string
  /**
   * The origin to allow in a `Content-Security-Policy` meta tag so the webview
   * can load resources returned by {@link asWebviewUri} (our `universe-app://root`).
   */
  readonly cspSource: string
  /**
   * Rewrite a local `file:` resource into a URL the sandboxed iframe can load
   * (`universe-app://root/_resource_/<abs-path>`), the equivalent of VSCode's
   * `asWebviewUri`. Only resources under an allowed root actually resolve.
   * Returns the URL as a string (there is no `Uri` class in this API surface).
   */
  asWebviewUri(resource: UriComponents): string
  /** Send a message to the scripts in the webview. Resolves false if it's gone. */
  postMessage(message: unknown): Promise<boolean>
  /** Fires with messages the webview scripts post back via `postMessage`. */
  readonly onDidReceiveMessage: Event<unknown>
}

/**
 * Two versions of a resource to compare, carried on a {@link WebviewPanel} when
 * the workbench opened it as a webview diff (via the internal
 * `_workbench.openWebviewDiff` command) rather than for a single file. Content is
 * passed by value as raw bytes — the "left"/"right" sides may not exist on disk
 * (a Git HEAD blob, a Perforce have-revision), so a provider that renders a diff
 * reads these instead of reading `document.uri`.
 */
export interface WebviewDiffContext {
  /** The left-hand (original / baseline) side's resource, for labels. */
  readonly leftUri: UriComponents
  /** The right-hand (modified) side's resource, for labels. */
  readonly rightUri: UriComponents
  /** Raw bytes of the left-hand side. */
  readonly left: Uint8Array
  /** Raw bytes of the right-hand side. */
  readonly right: Uint8Array
  /** A human-readable title for the comparison (e.g. `book.xlsx (Working Tree)`). */
  readonly title: string
}

/**
 * A webview hosted as an editor. For a custom editor the workbench creates and
 * owns the panel; the extension fills it in `resolveCustomEditor`.
 */
export interface WebviewPanel {
  /** The custom-editor `viewType` this panel was created for. */
  readonly viewType: string
  /** The content surface. */
  readonly webview: Webview
  /**
   * Present when the workbench opened this panel as a diff (two versions of a
   * resource) rather than a single file. A provider that supports diffing checks
   * this in `resolveCustomEditor`: when set, render `left` vs `right`; when
   * undefined, render the single document at `document.uri`.
   */
  readonly diffContext?: WebviewDiffContext
  /** Focus the editor tab hosting this panel. */
  reveal(): void
  /** Close the panel (and its editor tab). */
  dispose(): void
  /** Fires once when the panel is disposed (tab closed by the user or by code). */
  readonly onDidDispose: Event<void>
}

/**
 * The data model for one open custom-editor document. The default carries only
 * the resource; a provider may extend it (vscode-pdf watches the file for change).
 */
export interface CustomDocument {
  readonly uri: UriComponents
  dispose(): void
}

/** Options passed to {@link WindowApi.registerCustomEditorProvider}. */
export interface CustomEditorOptions {
  /** Whether the same document can back multiple editor tabs. Default false. */
  readonly supportsMultipleEditorsPerDocument?: boolean
}

/**
 * A read-only custom editor: renders a resource in a webview but never writes it
 * back. Mirrors VSCode's `CustomReadonlyEditorProvider`. (Editable custom editors
 * — save/backup/edit — are a later phase.)
 */
export interface CustomReadonlyEditorProvider<T extends CustomDocument = CustomDocument> {
  /** Create the document model for `uri` (called once per opened resource). */
  openCustomDocument(uri: UriComponents): T | Promise<T>
  /** Wire up the webview panel for a document (set html/options, listen for messages). */
  resolveCustomEditor(document: T, webviewPanel: WebviewPanel): void | Promise<void>
}
