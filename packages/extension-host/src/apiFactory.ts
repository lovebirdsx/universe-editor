/**
 * Builds the runtime API injected into extensions. The single global bridge
 * (installed before any extension is imported) backs the `commands` namespace
 * of `@universe-editor/extension-api`; per-extension `ExtensionContext` objects
 * are created at activation time.
 */
import type {
  Disposable,
  ExtensionContext,
  FileStat,
  FileType,
  InputBoxOptions,
  Memento,
  QuickPickItem,
  QuickPickOptions,
  SourceControl,
  StatusBarAlignment,
  StatusBarItem,
} from '@universe-editor/extension-api'
import type { IScannedExtension } from './extensionScanner.js'

/**
 * Global key the bridge is installed under. KEEP IN SYNC with the consumer in
 * `packages/extension-api/src/index.ts` (same key, same method shapes).
 */
const BRIDGE_KEY = '__universeExtensionHostBridge__'

/** The bridge the extension-api delegates to. Matches `IExtensionHostBridge` there. */
export interface IExtensionHostBridge {
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

export function installApiBridge(bridge: IExtensionHostBridge): void {
  ;(globalThis as Record<string, unknown>)[BRIDGE_KEY] = bridge
}

function createInMemoryMemento(): Memento {
  const store = new Map<string, unknown>()
  const get = <T>(key: string, defaultValue?: T): T | undefined => {
    const value = store.get(key)
    return value === undefined ? defaultValue : (value as T)
  }
  return {
    get: get as Memento['get'],
    update: (key, value) => {
      store.set(key, value)
      return Promise.resolve()
    },
  }
}

/**
 * Phase 2 context: subscriptions + path + in-memory mementos. Persistence of
 * global/workspace state lands in a later phase.
 */
export function createExtensionContext(ext: IScannedExtension): ExtensionContext {
  return {
    subscriptions: [],
    extensionPath: ext.extensionPath,
    globalState: createInMemoryMemento(),
    workspaceState: createInMemoryMemento(),
  }
}
