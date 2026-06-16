/*---------------------------------------------------------------------------------------------
 *  E2E probe contract.
 *
 *  The probe is a renderer-side test hook exposed on `window.__E2E__` (main world)
 *  ONLY when the application is launched with the `UNIVERSE_E2E=1` environment
 *  variable. The main process forwards that signal to preload via
 *  `webPreferences.additionalArguments`, and the renderer installs the probe
 *  after the lifecycle reaches `Ready`.
 *
 *  See:
 *    - apps/editor/src/main/index.ts          (env → additionalArguments)
 *    - apps/editor/src/preload/index.ts       (argv → window.__UNIVERSE_E2E_ENABLED__)
 *    - apps/editor/src/renderer/e2e/probe.ts  (probe installation)
 *--------------------------------------------------------------------------------------------*/

export const E2E_PROBE_ARGV_FLAG = '--enable-e2e-probe'
export const E2E_PROBE_ENABLED_KEY = '__UNIVERSE_E2E_ENABLED__'
export const E2E_PROBE_KEY = '__E2E__'
export const DISPOSABLE_LEAK_REPORT_KEY = '__disposable_leak_report__'

export interface E2EDisposableLeakReport {
  readonly count: number
  readonly details: string
}

export type E2ELifecyclePhase = 'Starting' | 'Ready' | 'Restored' | 'Eventually'

export interface E2EStatusBarEntry {
  readonly id: string
  readonly text: string
  readonly alignment: 'left' | 'right'
  readonly icon?: string
  readonly tooltip?: string
}

export interface E2EUpdateState {
  readonly status: string
  readonly currentVersion: string
  readonly version?: string
  readonly percent?: number
  readonly error?: string
}

export interface E2ELayoutSizes {
  readonly sidebar: number
  readonly secondarySidebar: number
  readonly panel: number
}

export interface E2EOpenWindow {
  readonly id: number
  /** Workspace folder fsPath, or null for an empty window. */
  readonly folder: string | null
  readonly name: string | null
}

export interface E2EMarker {
  readonly message: string
  /** Monaco MarkerSeverity: 8 Error, 4 Warning, 2 Info, 1 Hint. */
  readonly severity: number
  readonly startLineNumber: number
}

export interface E2EProbe {
  /** Resolves once the workbench has reached LifecyclePhase.Ready. */
  whenReady(): Promise<void>
  /** Resolves once React has mounted and the workbench reached LifecyclePhase.Restored. */
  whenRestored(): Promise<void>
  /** Returns the current lifecycle phase name. */
  getLifecyclePhase(): E2ELifecyclePhase
  /** Looks up a ContextKey value (falls back through scopes). */
  getContextKey(key: string): unknown
  /** Executes a command via ICommandService.executeCommand. */
  runCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T | undefined>
  /** Active editor URI string, or undefined if none. */
  getActiveEditorUri(): string | undefined
  /**
   * True when the references peek (Peek Definition / References) tree currently
   * holds DOM focus — the precondition for Enter to follow a reference. Mirrors
   * how PeekNavigationContribution detects the focused tree. Lets specs gate the
   * Enter press on the peek being open + focused instead of blindly poll-pressing
   * into the editor (which would corrupt the doc before the peek mounts).
   */
  isReferencePeekFocused(): boolean
  /** Snapshot of currently visible status bar entries. */
  getStatusBarEntries(): E2EStatusBarEntry[]
  /** Current auto-update state (status machine + versions). */
  getUpdateState(): Promise<E2EUpdateState>
  /**
   * Opens a workspace by file-system path, bypassing the native folder dialog.
   * Use this in E2E tests instead of triggering the real dialog.
   */
  openWorkspace(fsPath: string): Promise<void>
  /** Returns the current workspace folder's fsPath, or undefined if none is open. */
  getCurrentWorkspacePath(): string | undefined
  /**
   * Snapshot of all open application windows (id + workspace folder fsPath + name).
   * Backs Switch Window and the "已打开" markers in Open Recent.
   */
  getOpenWindows(): Promise<readonly E2EOpenWindow[]>
  /**
   * Open a folder in a NEW window by file-system path, bypassing the native
   * folder dialog. If the folder is already open in some window, that window is
   * focused instead (single-writer constraint).
   */
  openFolderInNewWindow(fsPath: string): Promise<void>
  /** fsPaths of the recent-workspaces list, most-recent first. */
  getRecentWorkspacePaths(): readonly string[]
  /** Remove a folder from the recent-workspaces list by fsPath. */
  removeRecentWorkspace(fsPath: string): Promise<void>
  /** Returns current layout sizes (sidebar/secondarySidebar/panel in px). */
  getLayoutSizes(): E2ELayoutSizes
  /** Programmatically set a layout size (triggers debounced persist). */
  setLayoutSize(key: 'sidebar' | 'secondarySidebar' | 'panel', value: number): void
  /** Force-flush any pending layout save. Resolves when data is on disk. */
  flushLayoutSave(): Promise<void>
  /**
   * Throws an error inside the renderer. Used by smoke.errorBoundary to test
   * that WorkbenchErrorBoundary catches and shows the fallback UI.
   */
  triggerError(message?: string): Promise<void>
  /**
   * Calls onUnexpectedError() inside the renderer, which routes through the
   * registered unexpected error handler (sticky Error toast). Unlike triggerError,
   * this does not throw — the error is handled in-place.
   */
  triggerUnexpectedError(message?: string): void
  /**
   * Register a dummy EditorInput + resolver binding for E2E testing purposes.
   * Opens files matching `glob` with a minimal no-op editor whose typeId is
   * `typeId`. Allows E2E specs to verify resolver dispatch without shipping real
   * editor implementations.
   */
  registerDummyEditor(glob: string, typeId: string): void
  /**
   * Returns the typeId of the currently active editor input, or undefined if
   * no editor is active. Used by E2E specs to verify resolver dispatch results.
   */
  getActiveEditorTypeId(): string | undefined
  /**
   * Open a file by absolute file-system path via EditorResolverService, bypassing
   * the native file picker dialog. Used by E2E specs that need to open a specific
   * file for resolver testing.
   */
  openFileUri(fsPath: string, options?: { pinned?: boolean }): Promise<void>
  /** Returns the number of editor groups currently open. */
  getEditorGroupCount(): number
  /** Number of editors in the active group. */
  getActiveGroupEditorCount(): number
  /** URIs of every editor in the active group, in tab order. */
  getActiveGroupEditorUris(): readonly string[]
  /**
   * Move the active Monaco editor's cursor to the given (1-based) line/column
   * and synchronously emit cursor + selection events. Used by E2E specs to
   * exercise HistoryContribution's debounced cursor recorder without typing.
   */
  setActiveEditorCursor(lineNumber: number, column: number): boolean
  /**
   * The active Monaco editor's 1-based cursor position, or undefined when the
   * active editor isn't a file editor (or its Monaco instance isn't mounted).
   * Used by Go to Symbol specs to assert the picker moved the cursor.
   */
  getActiveEditorCursor(): { lineNumber: number; column: number } | undefined
  /**
   * Full text of the active Monaco editor's model, or undefined when the active
   * editor isn't a file editor (or its Monaco instance isn't mounted). Used by
   * the markdown-editing spec to assert the result of each editing command.
   */
  getActiveEditorText(): string | undefined
  /**
   * Replace the active Monaco editor's whole text and reset the cursor to the
   * top. Returns false when no file editor is active. Lets the markdown-editing
   * spec seed a known document before each editing command.
   */
  setActiveEditorText(text: string): boolean
  /**
   * Set the active Monaco editor's single selection (1-based, inclusive of the
   * anchor, exclusive of the active column as Monaco models it). When the four
   * coordinates collapse, places an empty cursor. Returns false when no file
   * editor is active. Backs the markdown-editing spec's per-command setup.
   */
  setActiveEditorSelection(
    startLineNumber: number,
    startColumn: number,
    endLineNumber: number,
    endColumn: number,
  ): boolean
  /**
   * Snapshot of the active diff editor's modified-side view state: the cursor
   * line and the first visible line. Used by diff auto-reveal specs to assert
   * the view scrolled to the first change. Undefined when the active editor is
   * not a diff editor (or its Monaco instance is not yet mounted).
   */
  getActiveDiffViewState():
    | {
        cursorLine: number
        firstVisibleLine: number
        lineChanges: number
        scrollTop: number
        layoutHeight: number
      }
    | undefined
  // -- ACP probe -----------------------------------------------------------
  /**
   * Inject a test ACP agent that runs `node <jsPath>`. Writes into the Memory
   * layer of `acp.agents` so AcpAgentRegistry picks it up, and sets
   * `acp.defaultAgentId` to the same id. Returns once both configuration
   * updates are visible.
   */
  installAcpEchoAgent(agentId: string, jsPath: string): void
  /** Number of open ACP sessions. */
  getAcpSessionCount(): number
  /** Active ACP session id (the local one assigned by AcpSessionService), if any. */
  getActiveAcpSessionId(): string | undefined
  /**
   * Send a prompt on the active ACP session. Fire-and-forget — the promise
   * resolves once the prompt request resolves on the agent side (one full
   * turn). Specs that don't want to wait should not await this call.
   */
  sendAcpPrompt(text: string): Promise<void>
  /** Snapshot of the active session's messages (role + text). */
  getAcpMessages(): ReadonlyArray<{ role: string; text: string }>
  /** Snapshot of the active session's tool calls (id, title, status, text). */
  getAcpToolCalls(): ReadonlyArray<{
    id: string
    title: string
    status: string
    text: string
    mcpServer?: string
  }>
  /**
   * Snapshot of the active session's MCP servers (name, connection status, and
   * transport when known). Backs the MCP Servers view and the Agents status-bar
   * tooltip. Empty when no session is active or no MCP servers are involved.
   */
  getAcpMcpServers(): ReadonlyArray<{ name: string; status: string; transport?: string }>
  /**
   * Snapshot of the active session's pending `AskUserQuestion` carousel, or
   * undefined when none is awaiting an answer.
   */
  getAcpPendingQuestion():
    | { toolCallId: string; questions: ReadonlyArray<{ question: string; header: string }> }
    | undefined
  /** Answer the active session's pending AskUserQuestion (keyed by question text). */
  resolveAcpQuestion(answers: Record<string, string>): void
  /** Dismiss the active session's pending AskUserQuestion. */
  cancelAcpQuestion(): void
  // -- Output probe --------------------------------------------------------
  /** Name of the currently active output channel, or undefined if none. */
  getActiveOutputChannelName(): string | undefined
  /** Snapshot of all currently registered output channel names. */
  getOutputChannelNames(): readonly string[]
  /** Create a named output channel (for testing restore without ACP). */
  createOutputChannel(name: string): void
  // -- Terminal probe ------------------------------------------------------
  /**
   * Create an integrated terminal directly via ITerminalService and return its
   * id. The probe begins accumulating its output immediately. This exercises the
   * full cross-process path (renderer → main → node-pty), which is the highest-
   * signal check that the native PTY actually spawns in the packaged build.
   */
  terminalCreate(): Promise<string>
  /** Write input to a terminal created via `terminalCreate`. */
  terminalInput(id: string, data: string): Promise<void>
  /** All output observed for a terminal id since creation. */
  terminalReadBuffer(id: string): string
  /**
   * Read the Disposable leak report stored in sessionStorage by the previous
   * session's beforeunload handler. Returns null if no leaks were detected
   * (or if the tracker was not installed, e.g. in production builds).
   */
  getStoredLeakReport(): E2EDisposableLeakReport | null
  /**
   * Tear down React and compute the live Disposable leak report for the current
   * session WITHOUT waiting for unload. Replicates the beforeunload handler
   * (unmount React so useEffect cleanups run, then snapshot the tracker), so the
   * E2E fixture can assert "no leaks" at teardown for every spec — not just the
   * dedicated restart spec. Destructive: unmounts the workbench, so it must only
   * be called once, in fixture teardown, after the test body has finished.
   * Returns null when the tracker is not installed or no leaks were found.
   */
  computeTeardownLeakReport(): E2EDisposableLeakReport | null
  /** Number of currently registered SCM source controls. */
  getScmSourceControlCount(): number
  /** Commit input box value of the first SCM source control (undefined if none). */
  getScmInputBoxValue(): string | undefined
  // -- Markdown language server probe ---------------------------------------
  /**
   * Flattened document-symbol names for an open markdown file, via the markdown
   * language server (the same path that drives the Outline / Breadcrumbs).
   */
  getMarkdownDocumentSymbols(uri: string): Promise<readonly string[]>
  /** Workspace-symbol names matching a query (backs the Ctrl+T picker). */
  queryMarkdownWorkspaceSymbols(query: string): Promise<readonly string[]>
  /**
   * Definition target URIs at a 1-based position (F12). Cross-file targets
   * resolve to other documents' URIs.
   */
  getMarkdownDefinition(uri: string, lineNumber: number, column: number): Promise<readonly string[]>
  /**
   * Folding ranges for an open markdown file as `[startLine, endLine]` pairs
   * (1-based), via the markdown language server's folding provider.
   */
  getMarkdownFoldingRanges(uri: string): Promise<ReadonlyArray<readonly [number, number]>>
  /** Markdown diagnostics currently set as Monaco markers (owner `markdown`). */
  getMarkdownMarkers(uri: string): readonly E2EMarker[]
  // -- Outline probe --------------------------------------------------------
  /**
   * Flattened symbol names from `IOutlineService.outline` — the SAME observable the
   * Outline view renders, after going through OutlineService's attach/re-pull
   * logic. Differs from getMarkdownDocumentSymbols (which pulls the provider
   * directly): this catches the "Outline empties after switching files" bug.
   */
  getOutlineSymbols(): readonly string[]
  /** The URI the current outline was computed for, or undefined when empty. */
  getOutlineUri(): string | undefined
  // -- Keybindings probe ----------------------------------------------------
  /**
   * Resolve a single keystroke against KeybindingsRegistry (no when-clause
   * context). `no-match` means no binding for that key is registered at all —
   * the same condition the in-app key handler reports as "no binding registered
   * for this key". Backs the VSCode-compat keybinding reproduction spec.
   */
  resolveKeybinding(key: string): { kind: string; command?: string }
  /**
   * True once a command id is present in CommandsRegistry. Used to await the
   * extension host boot (e.g. `git.commit` from the built-in Git extension) so
   * the one-shot ExtensionsContribution keybinding reload has already run.
   */
  hasCommand(id: string): boolean
  /**
   * Command ids of every keybinding whose first chord equals `key`, ignoring the
   * `when` clause (so a binding present-but-context-gated still shows up). This is
   * the registration-level check: a binding to a lazily-registered monaco command
   * (e.g. editor.action.copyLinesDownAction) must end up here once the monaco
   * action bridge has run. resolveKeybinding() can't be used for when-claused
   * bindings since it evaluates `when` against the (unfocused) current context.
   */
  getKeybindingCommandsForKey(key: string): string[]
  /**
   * Write a configuration value at Memory scope, bypassing settings.json. Lets
   * specs flip runtime knobs (e.g. lowering
   * `workbench.chat.virtualizationThreshold` so a short timeline still exercises
   * the virtual-scroll path) without shipping fixtures of thousands of items.
   */
  updateConfigValue(key: string, value: unknown): void
}

declare global {
  interface Window {
    [E2E_PROBE_ENABLED_KEY]?: boolean
    [E2E_PROBE_KEY]?: E2EProbe
  }
}
