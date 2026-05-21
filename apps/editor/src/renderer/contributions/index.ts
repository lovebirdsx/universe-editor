/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Built-in workbench contributions. Importing this module registers every
 *  contribution with `ContributionsRegistry`; `ContributionService` then
 *  instantiates them as the lifecycle phase advances.
 *--------------------------------------------------------------------------------------------*/

import { ContributionsRegistry, WorkbenchPhase } from '@universe-editor/platform'
// Side-effect: registers all built-in Action2's with the global registries.
import '../actions/index.js'
import { BuiltInEditorProvidersContribution } from './BuiltInEditorProvidersContribution.js'
import { BuiltInViewContainersContribution } from './BuiltInViewContainersContribution.js'
import { BuiltInViewsContribution } from './BuiltInViewsContribution.js'
import { ContextKeyContribution } from './ContextKeyContribution.js'
import { SettingsContribution } from './SettingsContribution.js'
import { FileEditorStatusContribution } from './FileEditorStatusContribution.js'
import { ExternalChangeWatcher } from './ExternalChangeWatcher.js'
import { WorkspaceRecentMenuContribution } from './WorkspaceRecentMenuContribution.js'
import { WorkspaceRestoreContribution } from './WorkspaceRestoreContribution.js'
import { WorkspaceExplorerRevealContribution } from './WorkspaceExplorerRevealContribution.js'
import { ExplorerAutoRevealContribution } from './ExplorerAutoRevealContribution.js'
import { RecentFilesContribution } from './RecentFilesContribution.js'
import { JsonSchemaBridgeContribution } from './JsonSchemaBridgeContribution.js'
import { ThemeContribution } from './ThemeContribution.js'
import { WorkbenchFontContribution } from './WorkbenchFontContribution.js'
import { NotificationStatusContribution } from './NotificationStatusContribution.js'
import { BuiltInEditorBindingsContribution } from './BuiltInEditorBindingsContribution.js'
import { ExplorerMenuContribution } from './ExplorerMenuContribution.js'
import { LogLevelContribution } from './LogLevelContribution.js'
import { LogTailContribution } from './LogTailContribution.js'

// ContextKey defaults must seed before any contribution evaluates a when-clause.
ContributionsRegistry.registerContribution(
  'workbench.contrib.contextKey',
  ContextKeyContribution,
  WorkbenchPhase.BlockStartup,
)

// Built-in editor providers must be registered before WorkspaceRestoreContribution
// (BlockRestore) calls _restore(). EditorArea.tsx lives in the Workbench dynamic
// chunk which loads after setPhase(Ready), so we cannot rely on its module-level
// side-effects being present when _restore() resolves its storage IPC call.
ContributionsRegistry.registerContribution(
  'workbench.contrib.builtInEditorProviders',
  BuiltInEditorProvidersContribution,
  WorkbenchPhase.BlockStartup,
)

// ViewContainers need to exist before any UI tries to read them (ActivityBar
// derives its icons from the registry on first render), so register at startup.
ContributionsRegistry.registerContribution(
  'workbench.contrib.builtInViewContainers',
  BuiltInViewContainersContribution,
  WorkbenchPhase.BlockStartup,
)

// Built-in views — Explorer file tree etc. Register alongside the containers
// so the SideBar finds them on first paint.
ContributionsRegistry.registerContribution(
  'workbench.contrib.builtInViews',
  BuiltInViewsContribution,
  WorkbenchPhase.BlockStartup,
)

// Configuration schema must be registered before any UI consumes it (Settings
// editor reads `getConfigurationNodes()` on mount).
ContributionsRegistry.registerContribution(
  'workbench.contrib.settings',
  SettingsContribution,
  WorkbenchPhase.BlockStartup,
)

ContributionsRegistry.registerContribution(
  'workbench.contrib.theme',
  ThemeContribution,
  WorkbenchPhase.BlockStartup,
)

ContributionsRegistry.registerContribution(
  'workbench.contrib.workbenchFont',
  WorkbenchFontContribution,
  WorkbenchPhase.BlockStartup,
)

// JSON Schema bridge — derives schemas for settings.json / keybindings.json
// from the live ConfigurationRegistry / CommandsRegistry and feeds them to
// Monaco's JSON language service. BlockStartup so the schemas are ready
// before any settings.json editor opens.
ContributionsRegistry.registerContribution(
  'workbench.contrib.jsonSchemaBridge',
  JsonSchemaBridgeContribution,
  WorkbenchPhase.BlockStartup,
)

// File editor cursor / language / encoding entries — only mount once both the
// status bar and the editor area are live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.fileEditorStatus',
  FileEditorStatusContribution,
  WorkbenchPhase.AfterRestore,
)

// External-change watcher — subscribes to the file watcher and reconciles
// open FileEditorInputs with disk on every batch. AfterRestore so any
// previously-open editors are already attached to groups.
ContributionsRegistry.registerContribution(
  'workbench.contrib.externalChangeWatcher',
  ExternalChangeWatcher,
  WorkbenchPhase.AfterRestore,
)

// The File → Open Recent submenu reflects IWorkspaceService.recent and only
// becomes useful once user-driven workspace state is in play, so register at
// AfterRestore alongside other UI-seeding contributions.
ContributionsRegistry.registerContribution(
  'workbench.contrib.workspaceRecentMenu',
  WorkspaceRecentMenuContribution,
  WorkbenchPhase.AfterRestore,
)

// Reveal Explorer whenever a folder is opened so the user sees the file tree.
ContributionsRegistry.registerContribution(
  'workbench.contrib.workspaceExplorerReveal',
  WorkspaceExplorerRevealContribution,
  WorkbenchPhase.AfterRestore,
)

// Auto-reveal active editor's file in the Explorer + mark it as "active" in the
// tree. Runs AfterRestore so IEditorService + ExplorerTreeService are ready.
ContributionsRegistry.registerContribution(
  'workbench.contrib.explorerAutoReveal',
  ExplorerAutoRevealContribution,
  WorkbenchPhase.AfterRestore,
)

// Track recently opened files and provide quick-open access to them.
ContributionsRegistry.registerContribution(
  'workbench.contrib.recentFiles',
  RecentFilesContribution,
  WorkbenchPhase.AfterRestore,
)

// Bell icon with unread badge. AfterRestore so the status bar is live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.notificationStatus',
  NotificationStatusContribution,
  WorkbenchPhase.AfterRestore,
)

// Default glob → EditorInput bindings + "Reopen With..." menu item.
// BlockStartup so the catch-all '**/*' → FileEditorInput registration exists
// before ExplorerView or any other caller opens a file.
ContributionsRegistry.registerContribution(
  'workbench.contrib.builtInEditorBindings',
  BuiltInEditorBindingsContribution,
  WorkbenchPhase.BlockStartup,
)

// Explorer right-click menu items registered through MenuRegistry.
// BlockStartup so they are available before any ExplorerContextMenu renders.
ContributionsRegistry.registerContribution(
  'workbench.contrib.explorerMenu',
  ExplorerMenuContribution,
  WorkbenchPhase.BlockStartup,
)

// Apply persisted `logging.level` to the renderer + main loggers as early as
// possible so the configured level is in effect before bulk restore traffic.
ContributionsRegistry.registerContribution(
  'workbench.contrib.logLevel',
  LogLevelContribution,
  WorkbenchPhase.BlockStartup,
)

// Live tail of main-side log writes into the active `Log (X)` Output channel.
// AfterRestore so the Output service and panel UI are already wired up.
ContributionsRegistry.registerContribution(
  'workbench.contrib.logTail',
  LogTailContribution,
  WorkbenchPhase.AfterRestore,
)

// Editor groups must be rebuilt from storage BEFORE the React tree mounts the
// EditorArea, otherwise users see the default empty grid flash. BlockRestore
// runs at LifecyclePhase.Ready which the bootstrap toggles before mount.
ContributionsRegistry.registerContribution(
  'workbench.contrib.workspaceRestore',
  WorkspaceRestoreContribution,
  WorkbenchPhase.BlockRestore,
)

export {
  BuiltInEditorProvidersContribution,
  BuiltInViewContainersContribution,
  BuiltInViewsContribution,
  BuiltInEditorBindingsContribution,
  ContextKeyContribution,
  ExplorerMenuContribution,
  SettingsContribution,
  FileEditorStatusContribution,
  ExternalChangeWatcher,
  WorkspaceRecentMenuContribution,
  WorkspaceRestoreContribution,
  WorkspaceExplorerRevealContribution,
  ExplorerAutoRevealContribution,
  RecentFilesContribution,
  JsonSchemaBridgeContribution,
  ThemeContribution,
  WorkbenchFontContribution,
  NotificationStatusContribution,
}
