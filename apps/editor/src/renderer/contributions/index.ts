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
import { FileEditorStatusContribution } from '../workbench/statusbar/FileEditorStatusContribution.js'
import { ExternalChangeWatcher } from '../workbench/editor/ExternalChangeWatcher.js'
import { WorkspaceRecentMenuContribution } from '../services/workspace/workspaceRecentMenuContribution.js'
import { WorkspaceRestoreContribution } from '../services/workspace/workspaceRestoreContribution.js'
import { WorkspaceExplorerRevealContribution } from '../services/workspace/workspaceExplorerRevealContribution.js'
import { ExplorerAutoRevealContribution } from './ExplorerAutoRevealContribution.js'
import { RecentFilesContribution } from './RecentFilesContribution.js'
import { JsonSchemaBridgeContribution } from './JsonSchemaBridgeContribution.js'
import { ThemeContribution } from './ThemeContribution.js'

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
  ContextKeyContribution,
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
}
