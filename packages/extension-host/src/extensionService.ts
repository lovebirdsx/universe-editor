/**
 * Orchestrates the host's extensions: stores their command handlers, drives
 * lazy activation by event, and answers the renderer's RPC (contributions,
 * activate-by-event, execute-command). It also backs the global API bridge so
 * `commands.registerCommand` / `executeCommand` from inside an extension route
 * here.
 *
 * Errors are isolated per extension: a failed `activate` or a throwing handler
 * is logged to stderr and never tears down the host or other extensions.
 */
import { pathToFileURL } from 'node:url'
import {
  FileType,
  type Disposable,
  type ExtensionContext,
  type FileStat,
  type InputBoxOptions,
  type QuickPickOptions,
  type SourceControl,
  type StatusBarAlignment,
  type StatusBarItem,
} from '@universe-editor/extension-api'
import {
  base64ToBytes,
  bytesToBase64,
  matchesActivationEvent,
  type ExtHostFileType,
  type IExtHostFileStatDto,
  type IExtensionDescriptionDto,
  type IMainThreadCommands,
  type IMainThreadFs,
  type IMainThreadScm,
  type IMainThreadWindow,
} from '@universe-editor/extensions-common'
import type { IScannedExtension } from './extensionScanner.js'
import {
  createExtensionContext,
  installApiBridge,
  type IExtensionHostBridge,
} from './apiFactory.js'
import { HostSourceControl } from './hostScm.js'

type CommandHandler = (...args: unknown[]) => unknown

function toFileType(type: ExtHostFileType): FileType {
  return type === 'dir' ? FileType.Directory : FileType.File
}

function toFileStat(dto: IExtHostFileStatDto): FileStat {
  return { type: toFileType(dto.type), size: dto.size, mtime: dto.mtime }
}

interface ActivatedExtension {
  readonly context: ExtensionContext
  readonly deactivate?: () => unknown
}

interface ExtensionModule {
  activate?: (context: ExtensionContext) => unknown
  deactivate?: () => unknown
}

/**
 * Host-side StatusBarItem. Mutations are pushed to the renderer only while the
 * item is shown; hiding/disposing removes its renderer entry. Keyed by `handle`.
 */
class HostStatusBarItem implements StatusBarItem {
  private _text = ''
  private _tooltip: string | undefined
  private _command: string | undefined
  private _visible = false

  constructor(
    private readonly _handle: number,
    readonly alignment: StatusBarAlignment,
    readonly priority: number,
    private readonly _window: IMainThreadWindow,
  ) {}

  get text(): string {
    return this._text
  }
  set text(value: string) {
    this._text = value
    this._sync()
  }
  get tooltip(): string | undefined {
    return this._tooltip
  }
  set tooltip(value: string | undefined) {
    this._tooltip = value
    this._sync()
  }
  get command(): string | undefined {
    return this._command
  }
  set command(value: string | undefined) {
    this._command = value
    this._sync()
  }

  show(): void {
    this._visible = true
    this._sync()
  }
  hide(): void {
    this._visible = false
    void this._window.$disposeStatusBarEntry(this._handle)
  }
  dispose(): void {
    this.hide()
  }

  private _sync(): void {
    if (!this._visible) return
    void this._window.$setStatusBarEntry(this._handle, {
      text: this._text,
      alignment: this.alignment,
      priority: this.priority,
      ...(this._tooltip !== undefined ? { tooltip: this._tooltip } : {}),
      ...(this._command !== undefined ? { command: this._command } : {}),
    })
  }
}

export class ExtensionService implements IExtensionHostBridge {
  private readonly _commands = new Map<string, CommandHandler>()
  private readonly _activated = new Map<string, ActivatedExtension>()
  private readonly _activating = new Map<string, Promise<void>>()
  private _statusBarHandle = 0
  private readonly _sourceControls = new Map<number, HostSourceControl>()
  private _scmHandle = 0

  constructor(
    private readonly _extensions: readonly IScannedExtension[],
    private readonly _mainThreadCommands: IMainThreadCommands,
    private readonly _mainThreadWindow: IMainThreadWindow,
    private readonly _mainThreadScm: IMainThreadScm,
    private readonly _workspaceRoot?: string,
    private readonly _mainThreadFs?: IMainThreadFs,
    private readonly _kind: 'trusted' | 'restricted' = 'trusted',
  ) {
    installApiBridge(this)
  }

  // --- IExtensionHostBridge (called from inside extensions via the API) ---

  registerCommand(command: string, handler: CommandHandler): Disposable {
    if (this._commands.has(command)) {
      throw new Error(`command already registered: ${command}`)
    }
    this._commands.set(command, handler)
    void this._mainThreadCommands.$registerCommand(command)
    return {
      dispose: () => {
        if (this._commands.delete(command)) {
          void this._mainThreadCommands.$unregisterCommand(command)
        }
      },
    }
  }

  executeCommand(command: string, args: unknown[]): Promise<unknown> {
    const handler = this._commands.get(command)
    if (handler) {
      return Promise.resolve(handler(...args))
    }
    // Not one of this host's commands — forward to a renderer built-in (e.g.
    // `_workbench.openDiff`). The renderer rejects anything outside its
    // host-invokable namespace, so this can't loop back into extension commands.
    return this._mainThreadCommands.$executeCommand(command, args)
  }

  showMessage(
    severity: 'info' | 'warning' | 'error',
    message: string,
    items: string[],
  ): Promise<string | undefined> {
    return this._mainThreadWindow.$showMessage(severity, message, items)
  }

  showQuickPick(items: readonly string[], options?: QuickPickOptions): Promise<string | undefined> {
    return this._mainThreadWindow.$showQuickPick([...items], options)
  }

  showInputBox(options?: InputBoxOptions): Promise<string | undefined> {
    return this._mainThreadWindow.$showInputBox(options)
  }

  createStatusBarItem(alignment: StatusBarAlignment, priority: number): StatusBarItem {
    return new HostStatusBarItem(
      this._statusBarHandle++,
      alignment,
      priority,
      this._mainThreadWindow,
    )
  }

  createSourceControl(id: string, label: string, rootUri?: string): SourceControl {
    if (this._kind === 'restricted') {
      throw new Error(
        'scm.createSourceControl is not available to restricted (external) extensions',
      )
    }
    const handle = this._scmHandle++
    const sc = new HostSourceControl(
      handle,
      id,
      label,
      rootUri,
      this._mainThreadScm,
      () => this._scmHandle++,
      () => this._sourceControls.delete(handle),
    )
    this._sourceControls.set(handle, sc)
    void this._mainThreadScm.$registerSourceControl(handle, id, label, rootUri)
    return sc
  }

  getWorkspaceRoot(): string | undefined {
    return this._workspaceRoot
  }

  private _fs(): IMainThreadFs {
    if (!this._mainThreadFs) {
      throw new Error('filesystem access is not available in this extension host')
    }
    return this._mainThreadFs
  }

  fsReadFile(path: string): Promise<Uint8Array> {
    return this._fs()
      .$readFile(path)
      .then((base64) => base64ToBytes(base64))
  }

  fsWriteFile(path: string, content: Uint8Array): Promise<void> {
    return this._fs().$writeFile(path, bytesToBase64(content))
  }

  fsStat(path: string): Promise<FileStat> {
    return this._fs()
      .$stat(path)
      .then((dto) => toFileStat(dto))
  }

  fsReadDirectory(path: string): Promise<[string, FileType][]> {
    return this._fs()
      .$readDirectory(path)
      .then((entries) => entries.map(([name, type]) => [name, toFileType(type)]))
  }

  fsCreateDirectory(path: string): Promise<void> {
    return this._fs().$createDirectory(path)
  }

  fsDelete(path: string, recursive: boolean): Promise<void> {
    return this._fs().$delete(path, recursive)
  }

  // --- RPC surface (called from the renderer) ---

  /** IExtHostScm.$onInputBoxValueChange */
  onInputBoxValueChange(handle: number, value: string): void {
    this._sourceControls.get(handle)?.inputBox.acceptRendererValue(value)
  }

  /** IExtHostCommands.$executeContributedCommand */
  executeContributedCommand(id: string, args: unknown[]): Promise<unknown> {
    return this.executeCommand(id, args)
  }

  /** IExtHostExtensions.$getContributions */
  getContributions(): IExtensionDescriptionDto[] {
    return this._extensions.map((ext) => ({
      id: ext.id,
      name: ext.manifest.name,
      ...(ext.manifest.displayName !== undefined ? { displayName: ext.manifest.displayName } : {}),
      activationEvents: ext.manifest.activationEvents ?? [],
      contributes: ext.manifest.contributes ?? {},
    }))
  }

  /** IExtHostExtensions.$activateByEvent */
  async activateByEvent(event: string): Promise<void> {
    const pending: Promise<void>[] = []
    for (const ext of this._extensions) {
      if (matchesActivationEvent(ext.manifest.activationEvents ?? [], event)) {
        pending.push(this._activate(ext))
      }
    }
    await Promise.all(pending)
  }

  private _activate(ext: IScannedExtension): Promise<void> {
    if (this._activated.has(ext.id)) return Promise.resolve()
    const inFlight = this._activating.get(ext.id)
    if (inFlight) return inFlight

    const promise = this._doActivate(ext).finally(() => {
      this._activating.delete(ext.id)
    })
    this._activating.set(ext.id, promise)
    return promise
  }

  private async _doActivate(ext: IScannedExtension): Promise<void> {
    const context = createExtensionContext(ext)
    try {
      let deactivate: (() => unknown) | undefined
      if (ext.mainPath) {
        const mod = (await import(pathToFileURL(ext.mainPath).href)) as ExtensionModule
        await mod.activate?.(context)
        deactivate = mod.deactivate
      }
      this._activated.set(ext.id, {
        context,
        ...(deactivate !== undefined ? { deactivate } : {}),
      })
      console.error(`[ext-host] activated ${ext.id}`)
    } catch (err) {
      console.error(`[ext-host] activate failed ${ext.id}: ${(err as Error).stack ?? String(err)}`)
    }
  }
}
