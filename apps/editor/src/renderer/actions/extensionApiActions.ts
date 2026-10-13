/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Internal bridge commands that back the extension API. The extension host can
 *  invoke `_workbench.*` commands in the renderer plus the VSCode-compatible
 *  built-in ids allowlisted in MainThreadCommands (`setContext` lives here for
 *  that reason — extensions call it by the literal VSCode documents), so
 *  anything an extension needs from the renderer that isn't a dedicated RPC
 *  channel is surfaced here as a command.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ConfigurationTarget,
  IConfigurationService,
  IContextKeyService,
  IEditorGroupsService,
  IHostService,
  IInstantiationService,
  ILifecycleService,
  IUriIdentityService,
  IWindowsService,
  IWorkspaceService,
  REMOTE_SCHEME,
  ShutdownReason,
  URI,
  fsPathToWorkspaceUri,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import {
  findExistingFileEditor,
  revealSelectionInInput,
} from '../services/editor/revealEditorPosition.js'
import { openInLockAwareGroup } from '../services/editor/openInLockAwareGroup.js'
import { systemNotificationE2E } from '../services/extensions/systemNotificationE2E.js'
import { E2E_PROBE_ENABLED_KEY } from '../../shared/e2e/contract.js'

/**
 * Reattaches the current workspace's remote authority to a host fsPath, so
 * extension-host path strings open against the right workspace (local `file:` or
 * the workspace's `remote-ssh:` authority).
 */
function workspaceResourceUri(accessor: ServicesAccessor, fsPath: string): URI {
  const folder = accessor.get(IWorkspaceService).current?.folder
  const authority = folder?.scheme === REMOTE_SCHEME ? folder.authority : undefined
  return fsPathToWorkspaceUri(fsPath, authority)
}

/**
 * Backs `commands.executeCommand('setContext', key, value)` for extensions — the
 * documented VSCode way to publish a context key that `when` clauses (menu
 * visibility, keybinding gating) then evaluate. The id keeps VSCode's spelling
 * instead of a `_workbench.` prefix because that literal IS the extension-facing
 * API surface; MainThreadCommands allowlists it by name.
 *
 * The key is written to the root context service, so it survives until the window
 * is reloaded or something writes it again — there is no per-extension cleanup on
 * deactivate (VSCode behaves the same). An extension that means "off" must say so.
 */
/**
 * VSCode's `stringifyURIs` (its `_setContext` handler): `when` clauses compare
 * against strings (`key == 'file:///…'`), so a URI passed as the value is stored
 * in its string form, at any depth. Our IPC codec already revives `$mid:1`
 * components into `URI` instances on the way in, which is what this finds.
 */
function stringifyUris(value: unknown): unknown {
  if (value instanceof URI) return value.toString()
  if (Array.isArray(value)) return value.map(stringifyUris)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = stringifyUris(v)
    return out
  }
  return value
}

export class SetContextAction extends Action2 {
  static readonly ID = 'setContext'

  constructor() {
    super({
      id: SetContextAction.ID,
      title: localize2('action.extensionApi.setContext', 'Set Context'),
    })
  }

  override run(accessor: ServicesAccessor, key: string, value: unknown): void {
    if (typeof key !== 'string' || key.length === 0) return
    accessor.get(IContextKeyService).set(key, stringifyUris(value))
  }
}

/** Backs `workspace.getConfiguration(section).get(key, default)` for extensions. */
export class GetConfigurationAction extends Action2 {
  static readonly ID = '_workbench.getConfiguration'

  constructor() {
    super({
      id: GetConfigurationAction.ID,
      title: localize2('action.extensionApi.getConfiguration', 'Get Configuration'),
    })
  }

  override run(accessor: ServicesAccessor, key: string, defaultValue?: unknown): unknown {
    const value = accessor.get(IConfigurationService).get(key)
    return value === undefined ? defaultValue : value
  }
}

/** Backs `workspace.getConfiguration(section).update(key, value)` for extensions. */
export class UpdateConfigurationAction extends Action2 {
  static readonly ID = '_workbench.updateConfiguration'

  constructor() {
    super({
      id: UpdateConfigurationAction.ID,
      title: localize2('action.extensionApi.updateConfiguration', 'Update Configuration'),
    })
  }

  override async run(accessor: ServicesAccessor, key: string, value: unknown): Promise<void> {
    await accessor.get(IConfigurationService).update(key, value, ConfigurationTarget.User)
  }
}

/**
 * Returns the fsPath of the file backing the active editor — the source file for
 * a FileEditorInput, or the original side of a DiffEditorInput. Lets the Git
 * extension resolve "the current file" for git.openChange / git.openFile, which
 * the extension host can't read directly (no activeTextEditor API).
 */
export class GetActiveEditorFileAction extends Action2 {
  static readonly ID = '_workbench.getActiveEditorFile'

  constructor() {
    super({
      id: GetActiveEditorFileAction.ID,
      title: localize2('action.extensionApi.getActiveEditorFile', 'Get Active Editor File'),
    })
  }

  override run(accessor: ServicesAccessor): string | undefined {
    const active = accessor.get(IEditorGroupsService).activeGroup.activeEditor
    // 本机路径，不随远端工作区变化：返回给扩展主机的 `file:` 资源本机路径。
    if (active instanceof FileEditorInput) return active.resource.fsPath
    if (active instanceof DiffEditorInput) return active.originalUri.fsPath
    return undefined
  }
}

/** Opens a plain file editor for the given fsPath. Backs the Git extension's git.openFile. */
export class OpenFileAction extends Action2 {
  static readonly ID = '_workbench.openFile'

  constructor() {
    super({ id: OpenFileAction.ID, title: localize2('action.extensionApi.openFile', 'Open File') })
  }

  override run(accessor: ServicesAccessor, fsPath: string): void {
    if (!fsPath) return
    const group = accessor.get(IEditorGroupsService).activeGroup
    const input = accessor
      .get(IInstantiationService)
      .createInstance(FileEditorInput, workspaceResourceUri(accessor, fsPath))
    group.openEditor(input, { activate: true, pinned: true })
  }
}

function revealExistingOrOpen(
  accessor: ServicesAccessor,
  groups: IEditorGroupsService,
  uri: URI,
): FileEditorInput {
  const existing = findExistingFileEditor(groups, accessor.get(IUriIdentityService), uri)
  if (existing) {
    groups.activateGroup(existing.group)
    existing.group.setActive(existing.editor)
    return existing.editor
  }
  const input = accessor.get(IInstantiationService).createInstance(FileEditorInput, uri)
  openInLockAwareGroup(groups, input, { activate: true, pinned: true })
  return input
}

/**
 * Opens a file editor and reveals a specific position. Backs cross-file jumps for
 * extensions (e.g. numbered-bookmarks). `line`/`column` are 0-based to match the
 * extension API's Position; Monaco lines/columns are 1-based, hence the `+ 1`.
 */
export class OpenFileAtAction extends Action2 {
  static readonly ID = '_workbench.openFileAt'

  constructor() {
    super({
      id: OpenFileAtAction.ID,
      title: localize2('action.extensionApi.openFileAt', 'Open File At Position'),
    })
  }

  override run(accessor: ServicesAccessor, fsPath: string, line: number, column = 0): void {
    if (!fsPath) return
    const groups = accessor.get(IEditorGroupsService)
    const uri = workspaceResourceUri(accessor, fsPath)
    const input = revealExistingOrOpen(accessor, groups, uri)
    void revealSelectionInInput(input, { startLineNumber: line + 1, startColumn: column + 1 })
  }
}

/**
 * Writes text to the OS clipboard. Backs extension "copy" commands (e.g. the Git
 * extension's timeline Copy Commit ID / Message) — the extension host has no
 * clipboard API, so it routes through this renderer command.
 */
export class WriteClipboardAction extends Action2 {
  static readonly ID = '_workbench.writeClipboard'

  constructor() {
    super({
      id: WriteClipboardAction.ID,
      title: localize2('action.extensionApi.writeClipboard', 'Write Clipboard'),
    })
  }

  override async run(_accessor: ServicesAccessor, text: unknown): Promise<void> {
    if (typeof text !== 'string' || text === '') return
    await navigator.clipboard.writeText(text)
  }
}

/**
 * Raises an OS desktop notification for an extension. An extension runs in a
 * child process with no `IHostService`, and `window.showInformationMessage` only
 * reaches the in-app toast — so this is the one channel that can put a result in
 * front of a user who has switched to another window (e.g. a long p4 get).
 *
 * Deliberately fire-and-forget on BOTH ends: `notify()` settles only when the
 * toast is clicked, closed, or the main side's click grace expires — awaiting it
 * here would hold this RPC (and the caller's `executeCommand`) open for minutes.
 * The click needs no round trip: the main process focuses the window inside its
 * own click handler. The main side also refuses to show anything while the window
 * is focused and the user is present, so a caller that stays on screen keeps its
 * own in-app reporting and must not rely on this action for a fallback.
 */
export class ShowSystemNotificationAction extends Action2 {
  static readonly ID = '_workbench.showSystemNotification'

  constructor() {
    super({
      id: ShowSystemNotificationAction.ID,
      title: localize2('action.extensionApi.showSystemNotification', 'Show System Notification'),
    })
  }

  override run(accessor: ServicesAccessor, options?: unknown): void {
    const opts = options as { title?: unknown; body?: unknown } | undefined
    const title = typeof opts?.title === 'string' ? opts.title.trim() : ''
    // A headline-less toast is a bug on the caller's side; guessing one would
    // ship the guess to every user of the extension.
    if (title.length === 0) return
    const body = typeof opts?.body === 'string' ? opts.body : ''
    // Read synchronously: the accessor dies at the first await, so `run` stays
    // sync and never has to answer that question.
    const host = accessor.get(IHostService)
    if (typeof window !== 'undefined' && window[E2E_PROBE_ENABLED_KEY] === true) {
      systemNotificationE2E.notified.push({ title, body })
    }
    void host.notify({ title, body }).catch(() => undefined)
  }
}

/**
 * Switches this window to the given folder. Backs the Git extension's
 * git.openWorktree (current-window variant). Confirms before interrupting any
 * running session, mirroring OpenFolderAction.
 */
export class OpenFolderFromExtensionAction extends Action2 {
  static readonly ID = '_workbench.openFolder'

  constructor() {
    super({
      id: OpenFolderFromExtensionAction.ID,
      title: localize2('action.extensionApi.openFolder', 'Open Folder'),
    })
  }

  override async run(accessor: ServicesAccessor, fsPath: string): Promise<void> {
    if (!fsPath) return
    const lifecycle = accessor.get(ILifecycleService)
    const workspace = accessor.get(IWorkspaceService)
    const uri = workspaceResourceUri(accessor, fsPath)
    if (await lifecycle.confirmBeforeShutdown(ShutdownReason.SwitchWorkspace)) return
    await workspace.openFolder(uri)
  }
}

/**
 * Opens the given folder in a new window. Backs the Git extension's
 * git.openWorktreeInNewWindow.
 */
export class OpenFolderInNewWindowFromExtensionAction extends Action2 {
  static readonly ID = '_workbench.openFolderInNewWindow'

  constructor() {
    super({
      id: OpenFolderInNewWindowFromExtensionAction.ID,
      title: localize2('action.extensionApi.openFolderInNewWindow', 'Open Folder in New Window'),
    })
  }

  override async run(accessor: ServicesAccessor, fsPath: string): Promise<void> {
    if (!fsPath) return
    await accessor.get(IWindowsService).openWindow(workspaceResourceUri(accessor, fsPath))
  }
}
