/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Owns every renderer link the scheduler routes through: hosts registered per window,
 *  the ready ack of the reverse TriggerRunHost channel, the window -> workspace folder
 *  map, host resolution (including opening a background window) and the reclamation of
 *  runs whose renderer reloaded / crashed / closed. Window ids are the only identity
 *  main has here (the forward IPC channel does not carry the calling window).
 *--------------------------------------------------------------------------------------------*/

import {
  localize,
  normalizeRemoteAuthority,
  REMOTE_SCHEME,
  type ILogger,
  type IOpenWindowInfo,
  type URI,
} from '@universe-editor/platform'
import type { ITriggerRunHost } from '../../../shared/ipc/triggerService.js'
import { parseWorkspaceUri } from '../../../shared/triggers/configParse.js'
import {
  findWorkspaceHost,
  isSameWorkspace,
  listWorkspaceWindows,
  waitForWorkspaceHost,
  type WorkspaceHostDirectory,
} from '../window/workspaceWindowRouting.js'
import { DeferredRunError } from './triggerErrors.js'
import { workspaceComparisonKey } from './triggerIdentity.js'
import type { RoutedTrigger } from './triggerTypes.js'

/** Subset of `WindowMainService` the scheduler needs; set after windows are built. */
export interface TriggerWindowProvider {
  getOpenWindowInfos(): readonly IOpenWindowInfo[]
  openWindowForFolderInBackground(folder: URI): Promise<void>
}

export interface TriggerWindowHubOptions {
  readonly logger: ILogger
  readonly hostWaitTimeoutMs: number
  readonly hostWaitPollMs: number | undefined
  /** Hard gate for remote reads; the hub never dials SSH itself. */
  readonly isRemoteIoAllowed: (authority: string) => boolean
  /** A window's renderer disappeared; its active runs must be failed. */
  readonly failRunsForWindow: (windowId: number, message: string) => void
  /** A window registered / switched folders; the catalog re-runs discovery. */
  readonly onWorkspaceFolder: (folder: URI | null) => void
  /** The first host ever registered starts the startup-grace deadline. */
  readonly onHostRegistered: () => void
  /** A renderer acknowledged the reverse channel; deferred events may replay. */
  readonly onHostReady: () => void
  /** The last window of a remote workspace went away (catalog may detach it). */
  readonly onWindowFoldersChanged: () => void
}

export class TriggerWindowHub {
  private readonly _logger: ILogger
  private readonly _hostWaitTimeoutMs: number
  private readonly _hostWaitPollMs: number | undefined
  private readonly _isRemoteIoAllowed: (authority: string) => boolean
  private readonly _failRunsForWindow: (windowId: number, message: string) => void
  private readonly _onWorkspaceFolder: (folder: URI | null) => void
  private readonly _onHostRegistered: () => void
  private readonly _onHostReady: () => void
  private readonly _onWindowFoldersChanged: () => void

  private readonly _hosts = new Map<number, ITriggerRunHost>()
  /** Windows whose renderer TriggerRunHost has acknowledged the reverse channel. */
  private readonly _readyWindows = new Set<number>()
  /** Windows currently holding a workspace folder; drives remote attach/detach. */
  private readonly _windowFolders = new Map<number, string>()
  private _windows: TriggerWindowProvider | undefined

  constructor(options: TriggerWindowHubOptions) {
    this._logger = options.logger
    this._hostWaitTimeoutMs = options.hostWaitTimeoutMs
    this._hostWaitPollMs = options.hostWaitPollMs
    this._isRemoteIoAllowed = options.isRemoteIoAllowed
    this._failRunsForWindow = options.failRunsForWindow
    this._onWorkspaceFolder = options.onWorkspaceFolder
    this._onHostRegistered = options.onHostRegistered
    this._onHostReady = options.onHostReady
    this._onWindowFoldersChanged = options.onWindowFoldersChanged
  }

  setProvider(provider: TriggerWindowProvider): void {
    this._windows = provider
  }

  registerHost(windowId: number, host: ITriggerRunHost, workspaceFolder: URI | null = null): void {
    // A renderer reload re-registers on the same window id; its previous sessions
    // are gone, so nobody will ever report their end. Fail them instead of leaking
    // the slot (a fresh app-level window registration has no previous host).
    const reloaded = this._hosts.has(windowId)
    this._hosts.set(windowId, host)
    // Main's proxy exists before the renderer service does, so a host counts as
    // routable only after the renderer's TriggerRunHost acknowledges.
    this._readyWindows.delete(windowId)
    this._noteWindowFolder(windowId, workspaceFolder)
    this._logger.info(`window host registered id=${windowId}`)
    if (reloaded) {
      this._failRunsForWindow(
        windowId,
        localize('triggers.error.windowReloaded', 'The window running this trigger reloaded'),
      )
    }
    this._onHostRegistered()
    this._onWorkspaceFolder(workspaceFolder)
  }

  /**
   * The renderer's TriggerRunHost acknowledged its reverse channel. Runs are only
   * routed to acknowledged windows: before this, `startRun` / `isWorkspaceTrusted`
   * can hang on a channel the renderer has not served yet. The per-window IPC
   * wrapper stamps `windowId`; readiness is a property of that window's channel,
   * so it is marked directly and never broadcast to a same-workspace sibling.
   */
  markHostReady(workspaceFolder: string, windowId?: number): void {
    const folder = parseWorkspaceUri(workspaceFolder)
    if (folder === undefined) return
    const key = workspaceComparisonKey(folder.toString())
    if (windowId !== undefined) {
      if (!this._hosts.has(windowId)) return
      this._readyWindows.add(windowId)
      this._logger.info(`window host ready id=${windowId}: ${folder.toString()}`)
      this._onHostReady()
      return
    }
    // Direct callers predate the per-window wrapper and cannot identify their
    // window. Mark only an unambiguous sole holder; never mark a sibling window
    // whose reverse channel may still be unserved.
    const matches: number[] = []
    for (const [candidate, workspace] of this._windowFolders) {
      if (workspaceComparisonKey(workspace) === key) matches.push(candidate)
    }
    if (matches.length === 0) return
    if (matches.length > 1) {
      this._logger.warn(
        `window host ready ignored: ${matches.length} windows hold the workspace and the caller is unknown`,
      )
      return
    }
    const sole = matches[0]!
    this._readyWindows.add(sole)
    this._logger.info(`window host ready id=${sole}: ${folder.toString()}`)
    this._onHostReady()
  }

  /** Test / diagnostic seam: whether runs may be routed to this window. */
  isHostReady(windowId: number): boolean {
    return this._hosts.has(windowId) && this._readyWindows.has(windowId)
  }

  /**
   * Fail every active run bound to a renderer that went away (reload / crash) and
   * keep the window's host registration: the reloaded renderer serves the same
   * channel. Window close uses `unregisterHost`, which also drops the host.
   */
  failActiveRunsForWindow(windowId: number, reason: 'reloaded' | 'crashed'): void {
    this._readyWindows.delete(windowId)
    this._failRunsForWindow(
      windowId,
      reason === 'crashed'
        ? localize('triggers.error.windowCrashed', 'The window running this trigger crashed')
        : localize('triggers.error.windowReloaded', 'The window running this trigger reloaded'),
    )
  }

  /**
   * A window opened (or switched to) `folder`. `windowId` is optional for backward
   * compatibility, but remote attach/detach needs it to know when the last window
   * for a workspace went away.
   */
  noteWindowWorkspace(folder: URI | null, windowId?: number): void {
    if (windowId !== undefined) {
      this._noteWindowFolder(windowId, folder)
      this._onWindowFoldersChanged()
    }
    this._onWorkspaceFolder(folder)
  }

  unregisterHost(windowId: number): void {
    this._hosts.delete(windowId)
    this._readyWindows.delete(windowId)
    this._windowFolders.delete(windowId)
    this._logger.info(`window host unregistered id=${windowId}`)
    this._failRunsForWindow(
      windowId,
      localize('triggers.error.windowClosed', 'The window running this trigger closed'),
    )
    // Remote workspaces are only scheduled while one of their windows is open.
    this._onWindowFoldersChanged()
  }

  getHost(windowId: number): ITriggerRunHost | undefined {
    return this._hosts.get(windowId)
  }

  /** Whether any window currently holds `key` (remote scheduling needs one). */
  hasOpenWindowFor(key: string): boolean {
    for (const folder of this._windowFolders.values()) {
      if (workspaceComparisonKey(folder) === key) return true
    }
    return false
  }

  /** Remote workspaces of `authority` that a currently open window holds. */
  remoteWorkspacesForAuthority(authority: string): readonly string[] {
    const workspaces = new Map<string, string>()
    for (const folder of this._windowFolders.values()) {
      const uri = parseWorkspaceUri(folder)
      if (uri === undefined || uri.scheme !== REMOTE_SCHEME) continue
      if (normalizeRemoteAuthority(uri.authority) !== authority) continue
      workspaces.set(workspaceComparisonKey(folder), folder)
    }
    return [...workspaces.values()]
  }

  /**
   * Find a routable host for the trigger's workspace. Local workspaces may get a
   * background window opened and wait for its host; remote workspaces never wake
   * anything up and never dial SSH — without a live connection and an already open
   * window the run is deferred, not retried with an unbounded wait.
   */
  async resolveHost(trigger: RoutedTrigger): Promise<{ host: ITriggerRunHost; windowId: number }> {
    const target = { folder: trigger.workspace }
    const directory = this.hostDirectory()
    const immediate = findWorkspaceHost(directory, target)
    if (immediate !== undefined) {
      const host = this._hosts.get(immediate)
      if (host !== undefined) return { host, windowId: immediate }
    }

    if (trigger.workspaceUri.scheme === REMOTE_SCHEME) {
      const authority = normalizeRemoteAuthority(trigger.workspaceUri.authority)
      if (!this._isRemoteIoAllowed(authority)) {
        throw new DeferredRunError(`remote '${authority}' is not connected`)
      }
      throw new DeferredRunError('no open window holds this remote workspace')
    }

    const provider = this._windows
    if (provider === undefined) {
      throw new Error(
        localize(
          'triggers.error.windowUnavailable',
          'No editor window is available to run the trigger',
        ),
      )
    }
    const alreadyOpen = listWorkspaceWindows(provider.getOpenWindowInfos()).some((workspace) =>
      isSameWorkspace(workspace, target),
    )
    if (!alreadyOpen) {
      this._logger.info(`trigger ${trigger.id}: opening a background window for its workspace`)
      try {
        await provider.openWindowForFolderInBackground(trigger.workspaceUri)
      } catch (err) {
        throw new Error(
          localize(
            'triggers.error.windowOpenFailed',
            'Could not open an editor window for the workspace: {reason}',
            { reason: describeError(err) },
          ),
        )
      }
    }

    const windowId = await waitForWorkspaceHost(directory, {
      target,
      timeoutMs: this._hostWaitTimeoutMs,
      ...(this._hostWaitPollMs === undefined ? {} : { pollIntervalMs: this._hostWaitPollMs }),
    })
    if (windowId === undefined) {
      throw new Error(
        localize(
          'triggers.error.hostTimeout',
          'Timed out waiting for an editor window to accept the run',
        ),
      )
    }
    const host = this._hosts.get(windowId)
    if (host === undefined) {
      throw new Error(
        localize('triggers.error.hostMissing', 'The editor window did not expose its run host'),
      )
    }
    return { host, windowId }
  }

  dispose(): void {
    this._hosts.clear()
    this._readyWindows.clear()
    this._windowFolders.clear()
  }

  private _noteWindowFolder(windowId: number, folder: URI | null): void {
    const workspace = folder === null ? undefined : parseWorkspaceUri(folder.toString())?.toString()
    if (workspace === undefined) this._windowFolders.delete(windowId)
    else this._windowFolders.set(windowId, workspace)
  }

  private hostDirectory(): WorkspaceHostDirectory {
    return {
      listOpenWorkspaces: () => listWorkspaceWindows(this._windows?.getOpenWindowInfos() ?? []),
      // A proxy registered at window creation is not a usable host yet: the
      // renderer's TriggerRunHost must have acknowledged the reverse channel.
      hasHost: (windowId) => this._hosts.has(windowId) && this._readyWindows.has(windowId),
    }
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
