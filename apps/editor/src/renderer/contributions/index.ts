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
import { BuiltInViewContainersContribution } from './BuiltInViewContainersContribution.js'
import { BuiltInViewsContribution } from './BuiltInViewsContribution.js'
import { ContextKeyContribution } from './ContextKeyContribution.js'
import { SettingsContribution } from './SettingsContribution.js'
import { StatusBarDefaultsContribution } from './StatusBarDefaultsContribution.js'
import { FileEditorStatusContribution } from '../workbench/statusbar/FileEditorStatusContribution.js'
import { WorkspaceRecentMenuContribution } from '../services/workspace/workspaceRecentMenuContribution.js'
import { WorkspaceRestoreContribution } from '../services/workspace/workspaceRestoreContribution.js'

// ContextKey defaults must seed before any contribution evaluates a when-clause.
ContributionsRegistry.registerContribution(
  'workbench.contrib.contextKey',
  ContextKeyContribution,
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

// Status bar defaults run after restore — the status bar is mounted by then.
ContributionsRegistry.registerContribution(
  'workbench.contrib.statusBarDefaults',
  StatusBarDefaultsContribution,
  WorkbenchPhase.AfterRestore,
)

// File editor cursor / language / encoding entries — only mount once both the
// status bar and the editor area are live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.fileEditorStatus',
  FileEditorStatusContribution,
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

// Editor groups must be rebuilt from storage BEFORE the React tree mounts the
// EditorArea, otherwise users see the default empty grid flash. BlockRestore
// runs at LifecyclePhase.Ready which the bootstrap toggles before mount.
ContributionsRegistry.registerContribution(
  'workbench.contrib.workspaceRestore',
  WorkspaceRestoreContribution,
  WorkbenchPhase.BlockRestore,
)

export {
  BuiltInViewContainersContribution,
  BuiltInViewsContribution,
  ContextKeyContribution,
  SettingsContribution,
  StatusBarDefaultsContribution,
  FileEditorStatusContribution,
  WorkspaceRecentMenuContribution,
  WorkspaceRestoreContribution,
}
