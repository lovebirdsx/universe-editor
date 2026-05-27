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
}

export interface E2ELayoutSizes {
  readonly sidebar: number
  readonly secondarySidebar: number
  readonly panel: number
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
  /** Snapshot of currently visible status bar entries. */
  getStatusBarEntries(): E2EStatusBarEntry[]
  /**
   * Opens a workspace by file-system path, bypassing the native folder dialog.
   * Use this in E2E tests instead of triggering the real dialog.
   */
  openWorkspace(fsPath: string): Promise<void>
  /** Returns the current workspace folder's fsPath, or undefined if none is open. */
  getCurrentWorkspacePath(): string | undefined
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
  openFileUri(fsPath: string): Promise<void>
  /** Returns the number of editor groups currently open. */
  getEditorGroupCount(): number
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
  getAcpToolCalls(): ReadonlyArray<{ id: string; title: string; status: string; text: string }>
  // -- Output probe --------------------------------------------------------
  /** Name of the currently active output channel, or undefined if none. */
  getActiveOutputChannelName(): string | undefined
  /** Snapshot of all currently registered output channel names. */
  getOutputChannelNames(): readonly string[]
  /** Create a named output channel (for testing restore without ACP). */
  createOutputChannel(name: string): void
  /**
   * Read the Disposable leak report stored in sessionStorage by the previous
   * session's beforeunload handler. Returns null if no leaks were detected
   * (or if the tracker was not installed, e.g. in production builds).
   */
  getStoredLeakReport(): E2EDisposableLeakReport | null
}

declare global {
  interface Window {
    [E2E_PROBE_ENABLED_KEY]?: boolean
    [E2E_PROBE_KEY]?: E2EProbe
  }
}
