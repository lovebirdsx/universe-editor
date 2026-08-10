/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExtensionDevelopmentAutoReloadContribution — watches the build output of
 *  every extension loaded via --extension-development-path and restarts the
 *  extension host automatically when it changes, replacing the manual
 *  "Restart Extension Host" step of the `npm run watch` iteration loop.
 *
 *  Only the manifest `main` entry's directory is watched (the out-of-workspace
 *  watcher pins a non-recursive handle on the entry's dirname, which covers the
 *  flat dist/ writes of esbuild-style bundlers). A trailing debounce collapses
 *  a multi-file rebuild into one restart, an mtime stat-confirm skips the
 *  watcher-warmup write right after arming, and restarts are strictly serial
 *  with at most one queued re-run. The whole contribution is a no-op outside
 *  extension-development mode.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IConfigurationService,
  IFileService,
  IFileWatcherService,
  ILoggerService,
  INotificationService,
  IStatusBarService,
  IUriIdentityService,
  NullLogger,
  Severity,
  StatusBarAlignment,
  URI,
  createNamedLogger,
  localize,
  markAsSingleton,
  type IFileChangeEvent,
  type ILogger,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import type { IExtensionDescriptionDto } from '@universe-editor/extensions-common'
import { EXTENSION_DEVELOPMENT_ENABLED_KEY } from '../../shared/extensionDevelopment.js'
import { IExtensionHostClientService } from '../services/extensions/ExtensionHostClientService.js'
import { IOutOfWorkspaceWatchService } from '../services/files/outOfWorkspaceWatchService.js'

export const AUTO_RESTART_ON_CHANGE_SETTING = 'extensions.autoRestartOnChange'

const DEBOUNCE_MS = 500

// Shared fallback for non-dev windows, where the constructor early-returns
// before wiring a real logger — a per-instance NullLogger would trip the
// disposable-leak gate in every window.
const NULL_LOGGER = markAsSingleton(new NullLogger())

interface WatchedEntry {
  readonly uri: URI
  /** Comparison key of the entry file itself. */
  readonly key: string
  /** Comparison key of the entry's directory — the watcher's actual granularity. */
  readonly dirKey: string
}

export class ExtensionDevelopmentAutoReloadContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private _logger: ILogger = NULL_LOGGER
  private _entries: readonly WatchedEntry[] = []
  private _armTime = 0
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined
  private _inFlight = false
  private _restartAgain = false
  private _notifiedDebuggerDetach = false
  private _disposed = false

  /** Trailing debounce window between a matching event batch and the restart. Test override. */
  debounceMs = DEBOUNCE_MS

  constructor(
    @IExtensionHostClientService private readonly _hostClient: IExtensionHostClientService,
    @IFileWatcherService watcher: IFileWatcherService,
    @IOutOfWorkspaceWatchService outOfWorkspaceWatch: IOutOfWorkspaceWatchService,
    @IFileService private readonly _files: IFileService,
    @IConfigurationService private readonly _config: IConfigurationService,
    @IStatusBarService private readonly _statusBar: IStatusBarService,
    @INotificationService private readonly _notifications: INotificationService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    // The typeof guard keeps this constructible in a DOM-less (node) test env.
    if (typeof window === 'undefined' || window[EXTENSION_DEVELOPMENT_ENABLED_KEY] !== true) return
    this._logger = createNamedLogger(loggerService, {
      id: 'extensionDevelopmentAutoReload',
      name: 'Extension Development Auto Reload',
    })
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'extensions',
        title: localize('settings.extensions', 'Extensions'),
        properties: {
          [AUTO_RESTART_ON_CHANGE_SETTING]: {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.extensions.autoRestartOnChange',
              'Automatically restart the extension host when the build output of an extension under development changes. Only effective in an Extension Development Host window.',
            ),
          },
        },
      }),
    )
    void this._arm(watcher, outOfWorkspaceWatch)
  }

  override dispose(): void {
    this._disposed = true
    if (this._debounceTimer !== undefined) {
      clearTimeout(this._debounceTimer)
      this._debounceTimer = undefined
    }
    super.dispose()
  }

  /**
   * One-time setup: the dev path set is fixed for the window's lifetime (a host
   * restart re-scans the same roots), so there is no re-arm on
   * onDidChangeContributions.
   */
  private async _arm(
    watcher: IFileWatcherService,
    outOfWorkspaceWatch: IOutOfWorkspaceWatchService,
  ): Promise<void> {
    const dtos = await this._hostClient.getContributions()
    const entries: WatchedEntry[] = []
    for (const dto of dtos) {
      if (dto.extensionIsUnderDevelopment !== true || !dto.hasMain) continue
      const entry = await this._resolveEntry(dto)
      if (entry) entries.push(entry)
    }
    if (this._disposed) return
    if (entries.length === 0) {
      this._logger.debug('no development extension with a resolvable main entry; disarmed')
      return
    }
    this._entries = entries
    // Captured after manifest resolution so the stat-confirm rejects every write
    // that predates the watch (esbuild watch rewrites outputs once on startup).
    this._armTime = Date.now()
    this._register(outOfWorkspaceWatch.watch(entries.map((e) => e.uri)))
    this._register(watcher.onDidChangeFiles((events) => this._onFiles(events)))
    this._logger.info(
      `watching ${entries.length} development extension entrie(s): ${entries
        .map((e) => e.uri.fsPath)
        .join(', ')}`,
    )
  }

  private async _resolveEntry(dto: IExtensionDescriptionDto): Promise<WatchedEntry | undefined> {
    try {
      const root = URI.file(dto.extensionLocation)
      const raw = await this._files.readFileText(URI.joinPath(root, 'package.json'))
      const main: unknown = (JSON.parse(raw) as { main?: unknown }).main
      if (typeof main !== 'string' || main.length === 0) {
        this._logger.warn(`development extension ${dto.id} has no manifest main; skipping watch`)
        return undefined
      }
      const uri = URI.joinPath(root, ...main.split(/[\\/]+/).filter((s) => s.length > 0))
      const key = this._uriIdentity.getComparisonKey(uri)
      const sep = key.lastIndexOf('/')
      return { uri, key, dirKey: sep > 0 ? key.slice(0, sep) : key }
    } catch (err) {
      this._logger.warn(
        `failed to resolve the main entry of development extension ${dto.id}; skipping watch`,
        err,
      )
      return undefined
    }
  }

  private _onFiles(events: readonly IFileChangeEvent[]): void {
    if (this._config.get<boolean>(AUTO_RESTART_ON_CHANGE_SETTING, true) === false) return
    const hit = events.some((ev) => {
      if (ev.resource.scheme !== 'file') return false
      const key = this._uriIdentity.getComparisonKey(ev.resource)
      return this._entries.some((e) => key === e.key || key.startsWith(e.dirKey + '/'))
    })
    if (!hit) return
    this._logger.debug('development extension output change detected; scheduling host restart')
    if (this._debounceTimer !== undefined) clearTimeout(this._debounceTimer)
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = undefined
      void this._trigger(false)
    }, this.debounceMs)
  }

  private async _trigger(skipStatConfirm: boolean): Promise<void> {
    if (this._inFlight) {
      // Coalesce: one queued re-run is enough — the restart re-scans everything.
      this._restartAgain = true
      return
    }
    this._inFlight = true
    let accessor: { dispose(): void } | undefined
    try {
      if (!skipStatConfirm && !(await this._confirmedOnDisk())) {
        this._logger.debug('skipping restart: no entry file changed since arming')
        return
      }
      if (this._disposed) return
      accessor = this._statusBar.addEntry({
        text: localize('extDev.autoReload.restarting', 'Restarting Extension Host…'),
        tooltip: localize(
          'extDev.autoReload.restarting.tooltip',
          "A development extension's build output changed; restarting the extension host.",
        ),
        showProgress: 'spinning',
        alignment: StatusBarAlignment.Left,
        priority: 8,
      })
      this._logger.info('restarting extension host after development extension output change')
      await this._hostClient.refreshExtensions()
      this._armTime = Date.now()
      if (!this._notifiedDebuggerDetach && !this._disposed) {
        this._notifiedDebuggerDetach = true
        this._notifications.notify({
          severity: Severity.Info,
          message: localize(
            'extDev.autoReload.debuggerDetached',
            'The extension host restarted automatically because a development extension\'s build output changed. An attached debugger was disconnected — attach it again to continue debugging. Set "extensions.autoRestartOnChange" to false to disable the automatic restart.',
          ),
        })
      }
    } catch (err) {
      this._logger.error('automatic extension host restart failed', err)
    } finally {
      accessor?.dispose()
      this._inFlight = false
      if (this._restartAgain) {
        this._restartAgain = false
        // The triggering write happened after the previous stat-confirm, so the
        // queued round skips it (its mtime would read as stale against the
        // just-updated arm time even though it is a real change).
        void this._trigger(true)
      }
    }
  }

  private async _confirmedOnDisk(): Promise<boolean> {
    for (const entry of this._entries) {
      try {
        const stat = await this._files.stat(entry.uri)
        if (stat.isFile && stat.mtime > this._armTime) return true
      } catch {
        // Vanished between the event and the stat — not proof of a real rebuild.
      }
    }
    return false
  }
}
