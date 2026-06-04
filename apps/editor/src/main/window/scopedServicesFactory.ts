/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Two-layer service model (aligned with VSCode):
 *  - ApplicationServices: true singletons that must not be duplicated across windows
 *    (they share a single state.json; concurrent writes would corrupt it).
 *  - WindowScopedServices: one instance per BrowserWindow.
 *--------------------------------------------------------------------------------------------*/

import type {
  IFileService,
  IFileSearchService,
  IFileWatcherService,
  IStorageService,
  IUserDataFilesService,
  IWorkspaceServiceWire,
} from '@universe-editor/platform'
import type {
  ILogChannelService,
  ILogFilesService,
  IPerformanceMarksService,
  IPingService,
  IDisposableLeakService,
} from '../../shared/ipc/services.js'
import type { ITextSearchMainService } from '../../shared/ipc/textSearchService.js'
import type { IUpdateService } from '../../shared/ipc/updateService.js'
import type { IReleaseNotesService } from '../../shared/ipc/releaseNotesService.js'
import type { IAcpHostService } from '../../shared/ipc/acpHostService.js'
import type { IExtensionHostService } from '../../shared/ipc/extensionHostService.js'
import type { IAcpTerminalService } from '../../shared/ipc/acpTerminalService.js'
import type { ITerminalService } from '../../shared/ipc/terminalService.js'
import type { IClaudeBinaryService } from '../../shared/ipc/claudeBinaryService.js'
import type { ICodexBinaryService } from '../../shared/ipc/codexBinaryService.js'
import type { IHostServiceWire } from '@universe-editor/platform'
import type { RecentWorkspacesMainService } from '../services/workspace/recentWorkspacesMainService.js'

/** Services shared across all windows. Instantiated once at app startup. */
export interface ApplicationServices {
  readonly ping: IPingService
  readonly fileSystem: IFileService
  readonly fileSearch: IFileSearchService
  readonly textSearch: ITextSearchMainService
  readonly fileWatcher: IFileWatcherService
  readonly recentWorkspaces: RecentWorkspacesMainService
  readonly logFiles: ILogFilesService
  readonly acpHost: IAcpHostService
  readonly extensionHost: IExtensionHostService
  readonly acpTerminal: IAcpTerminalService
  readonly claudeBinary: IClaudeBinaryService
  readonly codexBinary: ICodexBinaryService
  readonly disposableLeak: IDisposableLeakService
  readonly update: IUpdateService
  readonly releaseNotes: IReleaseNotesService
  readonly performance: IPerformanceMarksService
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
  readonly terminal: ITerminalService
}
