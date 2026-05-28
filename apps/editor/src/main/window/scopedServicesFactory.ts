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

/** Services shared across all windows. Instantiated once at app startup. */
export interface ApplicationServices {
  readonly storage: IStorageService
  readonly ping: IPingService
  readonly fileSystem: IFileService
  readonly fileWatcher: IFileWatcherService
  readonly workspace: IWorkspaceServiceWire
  readonly userData: IUserDataFilesService
  readonly logFiles: ILogFilesService
  readonly acpHost: IAcpHostService
  readonly acpTerminal: IAcpTerminalService
  readonly disposableLeak: IDisposableLeakService
}

/** Services scoped to a single BrowserWindow. Created per-window by WindowMainService. */
export interface WindowScopedServices {
  readonly host: IHostServiceWire
  readonly logChannel: ILogChannelService
}
