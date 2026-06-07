/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Side-effect aggregator: importing this module runs each service file's
 *  registerSingleton(...) call so the descriptors are present in the global
 *  registry before main.tsx feeds them into the ServiceCollection.
 *
 *  Mirrors contributions/index.ts. Add one import line per migrated service.
 *--------------------------------------------------------------------------------------------*/

import './quickInput/QuickInputService.js'
import './progress/ProgressService.js'
import './search/TextSearchService.js'
import './search/QuickTextSearchService.js'
import './exclude/ExcludeService.js'
import './keybindings/UserKeybindingsService.js'
import './acp/acpAgentRegistry.js'
import './acp/acpPermissionHandler.js'
import './acp/acpSessionHistory.js'
import './acp/acpAgentDefaultsService.js'
import './acp/acpChatLocationService.js'
import './performance/TimerService.js'
import './terminal/TerminalManagerService.js'
import './terminal/TerminalXtermService.js'
