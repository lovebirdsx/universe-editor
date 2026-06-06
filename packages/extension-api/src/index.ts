/**
 * `@universe-editor/extension-api` — the surface plugin authors program against
 * (the Universe equivalent of `vscode.d.ts`). Its package version is the API
 * version: extensions declare a compatible range via `engines.universe`.
 *
 * This module is BUNDLED INTO each extension (esbuild inlines it). At run time
 * its namespaces delegate to a host-provided bridge installed on `globalThis`
 * by the extension host before any extension is imported — so plugins import
 * this module statically but every call is serviced by the host over RPC.
 */

import type { ScmApi, SourceControl } from './scm.js'

export * from './scm.js'

/** Semantic version of this API surface. The host checks `engines.universe`. */
export const version = '0.1.0'

export interface Disposable {
  dispose(): void
}

/** A subscribable signal: call with a listener, dispose to unsubscribe. */
export type Event<T> = (listener: (e: T) => void) => Disposable

/** Per-extension key/value store handed to `activate` via ExtensionContext. */
export interface Memento {
  get<T>(key: string): T | undefined
  get<T>(key: string, defaultValue: T): T
  update(key: string, value: unknown): Promise<void>
}

/** Passed to `activate`. Authors push disposables onto `subscriptions`. */
export interface ExtensionContext {
  readonly subscriptions: Disposable[]
  readonly extensionPath: string
  readonly globalState: Memento
  readonly workspaceState: Memento
}

export interface CommandsApi {
  /**
   * Register a handler for `command`. The returned Disposable unregisters it;
   * push it onto `context.subscriptions` so it is cleaned up on deactivate.
   */
  registerCommand(command: string, handler: (...args: unknown[]) => unknown): Disposable
  /** Execute any command (contributed or built-in) and await its result. */
  executeCommand<T = unknown>(command: string, ...args: unknown[]): Promise<T | undefined>
}

/** Where a status-bar item sits relative to the center. */
export enum StatusBarAlignment {
  Left = 0,
  Right = 1,
}

/**
 * A status-bar entry the extension owns. Property changes take effect once the
 * item is shown; call `show()` after setting `text`. Leading `$(icon)` syntax in
 * `text` renders an icon (e.g. `$(git-branch) main`).
 */
export interface StatusBarItem {
  text: string
  tooltip: string | undefined
  command: string | undefined
  /**
   * Render a spinner alongside the text while a background operation runs.
   * `true`/`'spinning'` → a loader; `'syncing'` → a rotating sync icon.
   */
  showProgress: boolean | 'spinning' | 'syncing' | undefined
  readonly alignment: StatusBarAlignment
  readonly priority: number
  show(): void
  hide(): void
  dispose(): void
}

export interface QuickPickOptions {
  placeHolder?: string
}

/** A richer quick-pick entry with secondary text. */
export interface QuickPickItem {
  label: string
  description?: string
  detail?: string
}

export interface InputBoxOptions {
  placeHolder?: string
  prompt?: string
  value?: string
}

/** The `window` namespace: UI surfaced through the host's renderer. */
export interface WindowApi {
  showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>
  showWarningMessage(message: string, ...items: string[]): Promise<string | undefined>
  showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>
  showQuickPick(items: readonly string[], options?: QuickPickOptions): Promise<string | undefined>
  showQuickPick<T extends QuickPickItem>(
    items: readonly T[],
    options?: QuickPickOptions,
  ): Promise<T | undefined>
  showInputBox(options?: InputBoxOptions): Promise<string | undefined>
  createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): StatusBarItem
}

/** The `workspace` namespace: the folder the editor currently has open. */
export interface WorkspaceApi {
  /**
   * Absolute filesystem path of the open workspace folder, or undefined when no
   * folder is open. Fixed at extension-host startup (single-folder only).
   */
  readonly rootPath: string | undefined
  /**
   * Gated filesystem access. Every call is routed through the host's path policy
   * (denies sensitive locations, forbids escaping the workspace root) before
   * touching disk — the only filesystem an external/restricted extension gets.
   */
  readonly fs: FileSystemApi
  /**
   * Read configuration values. `section` is an optional key prefix (e.g. `'git'`),
   * so `getConfiguration('git').get('autofetch', true)` reads `git.autofetch`.
   */
  getConfiguration(section?: string): WorkspaceConfiguration
}

/** Kind of a filesystem entry returned by {@link FileSystemApi}. */
export enum FileType {
  File = 1,
  Directory = 2,
}

export interface FileStat {
  readonly type: FileType
  readonly size: number
  /** Last-modified time, epoch milliseconds. */
  readonly mtime: number
}

/** A minimal, gated filesystem — the subset of `vscode.workspace.fs` we support. */
export interface FileSystemApi {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, content: Uint8Array): Promise<void>
  stat(path: string): Promise<FileStat>
  readDirectory(path: string): Promise<[string, FileType][]>
  createDirectory(path: string): Promise<void>
  delete(path: string, options?: { recursive?: boolean }): Promise<void>
}

/** Read-only view over a configuration section (async — values live in the renderer). */
export interface WorkspaceConfiguration {
  get<T>(key: string, defaultValue: T): Promise<T>
}

/**
 * The host bridge contract installed on globalThis. KEEP IN SYNC with the
 * producer in `extension-host/src/apiFactory.ts` (same key, same shapes).
 */
interface IExtensionHostBridge {
  registerCommand(command: string, handler: (...args: unknown[]) => unknown): Disposable
  executeCommand(command: string, args: unknown[]): Promise<unknown>
  showMessage(
    severity: 'info' | 'warning' | 'error',
    message: string,
    items: string[],
  ): Promise<string | undefined>
  showQuickPick(
    items: readonly (string | QuickPickItem)[],
    options?: QuickPickOptions,
  ): Promise<string | QuickPickItem | undefined>
  showInputBox(options?: InputBoxOptions): Promise<string | undefined>
  createStatusBarItem(alignment: StatusBarAlignment, priority: number): StatusBarItem
  createSourceControl(id: string, label: string, rootUri?: string): SourceControl
  getWorkspaceRoot(): string | undefined
  fsReadFile(path: string): Promise<Uint8Array>
  fsWriteFile(path: string, content: Uint8Array): Promise<void>
  fsStat(path: string): Promise<FileStat>
  fsReadDirectory(path: string): Promise<[string, FileType][]>
  fsCreateDirectory(path: string): Promise<void>
  fsDelete(path: string, recursive: boolean): Promise<void>
  getConfiguration(
    section: string | undefined,
    key: string,
    defaultValue: unknown,
  ): Promise<unknown>
}

/** Global key the host installs the bridge under. KEEP IN SYNC with the host. */
const BRIDGE_KEY = '__universeExtensionHostBridge__'

function bridge(): IExtensionHostBridge {
  const b = (globalThis as Record<string, unknown>)[BRIDGE_KEY] as IExtensionHostBridge | undefined
  if (!b) {
    throw new Error('Universe extension API used outside the extension host')
  }
  return b
}

export const commands: CommandsApi = {
  registerCommand: (command, handler) => bridge().registerCommand(command, handler),
  executeCommand: <T = unknown>(command: string, ...args: unknown[]) =>
    bridge().executeCommand(command, args) as Promise<T | undefined>,
}

export const window: WindowApi = {
  showInformationMessage: (message, ...items) => bridge().showMessage('info', message, items),
  showWarningMessage: (message, ...items) => bridge().showMessage('warning', message, items),
  showErrorMessage: (message, ...items) => bridge().showMessage('error', message, items),
  showQuickPick: ((items: readonly (string | QuickPickItem)[], options?: QuickPickOptions) =>
    bridge().showQuickPick(items, options)) as WindowApi['showQuickPick'],
  showInputBox: (options) => bridge().showInputBox(options),
  createStatusBarItem: (alignment = StatusBarAlignment.Left, priority = 0) =>
    bridge().createStatusBarItem(alignment, priority),
}

export const scm: ScmApi = {
  createSourceControl: (id, label, rootUri) => bridge().createSourceControl(id, label, rootUri),
}

export const workspace: WorkspaceApi = {
  get rootPath() {
    return bridge().getWorkspaceRoot()
  },
  fs: {
    readFile: (path) => bridge().fsReadFile(path),
    writeFile: (path, content) => bridge().fsWriteFile(path, content),
    stat: (path) => bridge().fsStat(path),
    readDirectory: (path) => bridge().fsReadDirectory(path),
    createDirectory: (path) => bridge().fsCreateDirectory(path),
    delete: (path, options) => bridge().fsDelete(path, options?.recursive ?? false),
  },
  getConfiguration: (section) => ({
    get: <T>(key: string, defaultValue: T): Promise<T> =>
      bridge().getConfiguration(section, key, defaultValue) as Promise<T>,
  }),
}
