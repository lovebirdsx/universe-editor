/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Side-effect aggregator: importing this module runs each service file's
 *  registerSingleton(...) call so the descriptors are present in the global
 *  registry before main.tsx feeds them into the ServiceCollection.
 *
 *  Mirrors contributions/index.ts. Add one import line per migrated service.
 *--------------------------------------------------------------------------------------------*/

import './quickInput/QuickInputService.js'
import './dialogs/SimpleFileDialog.js'
import './progress/ProgressService.js'
import './search/TextSearchService.js'
import './search/QuickTextSearchService.js'
import './exclude/ExcludeService.js'
import './files/outOfWorkspaceWatchService.js'
import './keybindings/UserKeybindingsService.js'
import './configuration/UserSettingsSync.js'
import './acp/acpAgentRegistry.js'
import './acp/acpPermissionHandler.js'
import './acp/session/acpSessionHistory.js'
import './acp/session/acpAgentDefaultsService.js'
import './acp/session/acpConfigOptionsCache.js'
import './acp/session/acpChatLocationService.js'
import './acp/session/sessionBookmarkService.js'
import './performance/TimerService.js'
import './terminal/TerminalManagerService.js'
import './terminal/TerminalXtermService.js'
import './configurationResolver/ConfigurationResolverService.js'
import './activity/ActivityService.js'
import './explorer/CompareService.js'
import './extensions/WebviewService.js'
import './history/HistoryService.js'
import './languageFeatures/LanguageFeaturesService.js'
import './statusbar/StatusBarService.js'
import './ai/RecentEditsTracker.js'
