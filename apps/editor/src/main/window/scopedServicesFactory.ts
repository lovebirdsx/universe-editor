/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Two-layer service model (aligned with VSCode):
 *  - ApplicationServices: true singletons that must not be duplicated across windows
 *    (they share a single state.json; concurrent writes would corrupt it).
 *  - WindowScopedServices: one instance per BrowserWindow.
 *--------------------------------------------------------------------------------------------*/

import type {
  IFileService,
  IFileWatcherService,
  IStorageService,
  IUserDataFilesService,
  IWorkspaceServiceWire,
} from '@universe-editor/platform'
import type {
  ILogChannelService,
  ILogFilesService,
  IPingService,
  IDisposableLeakService,
} from '../../shared/ipc/services.js'
import type { IAcpHostService } from '../../shared/ipc/acpHostService.js'
import type { IAcpTerminalService } from '../../shared/ipc/acpTerminalService.js'
import type { IHostServiceWire } from '@universe-editor/platform'
import type { RecentWorkspacesMainService } from '../services/workspace/recentWorkspacesMainService.js'

/** Services shared across all windows. Instantiated once at app startup. */
export interface ApplicationServices {
  readonly ping: IPingService
  readonly fileSystem: IFileService
  readonly fileWatcher: IFileWatcherService
  readonly recentWorkspaces: RecentWorkspacesMainService
  readonly logFiles: ILogFilesService
  readonly acpHost: IAcpHostService
  readonly acpTerminal: IAcpTerminalService
  readonly disposableLeak: IDisposableLeakService
}

/**
 * Services scoped to a single BrowserWindow. Created per-window by
 * WindowMainService. `storage` / `workspace` / `userData` are per-window so
 * opening a folder in one window does not affect others; their GLOBAL state
 * (state.json, recent list) is still shared via the app-singleton backends.
 */
export interface WindowScopedServices {
  readonly host: IHostServiceWire
  readonly logChannel: ILogChannelService
  readonly storage: IStorageService
  readonly workspace: IWorkspaceServiceWire
  readonly userData: IUserDataFilesService
}
