/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Built-in workbench contributions. Importing this module registers every
 *  contribution with `ContributionsRegistry`; `ContributionService` then
 *  instantiates them as the lifecycle phase advances.
 *
 *  Registrations are split by lifecycle phase into ./registration/* so each
 *  phase's contributions are easy to locate and reason about. Importing each
 *  file runs its side-effect registrations.
 *--------------------------------------------------------------------------------------------*/

// Side-effect: registers all built-in Action2's with the global registries.
import '../actions/index.js'

// Side-effect: phase-grouped contribution registrations.
import './registration/blockStartup.js'
import './registration/blockRestore.js'
import './registration/afterRestore.js'
import './registration/eventually.js'

// Re-exported for tests and other modules that construct contributions directly.
export { BuiltInEditorProvidersContribution } from './BuiltInEditorProvidersContribution.js'
export { BuiltInViewContainersContribution } from './BuiltInViewContainersContribution.js'
export { BuiltInViewsContribution } from './BuiltInViewsContribution.js'
export { SwarmViewContribution } from './SwarmViewContribution.js'
export { SwarmConfigurationContribution } from './SwarmConfigurationContribution.js'
export { BuiltInEditorBindingsContribution } from './BuiltInEditorBindingsContribution.js'
export { ContextKeyContribution } from './ContextKeyContribution.js'
export { ExplorerClipboardContextContribution } from './ExplorerClipboardContextContribution.js'
export { CompareContextContribution } from './CompareContextContribution.js'
export { ExplorerMenuContribution } from './ExplorerMenuContribution.js'
export { SettingsContribution } from './SettingsContribution.js'
export { FileEditorStatusContribution } from './FileEditorStatusContribution.js'
export { ExternalChangeWatcher } from './ExternalChangeWatcher.js'
export { WorkspaceRecentMenuContribution } from './WorkspaceRecentMenuContribution.js'
export { WorkspaceRestoreContribution } from './WorkspaceRestoreContribution.js'
export { WorkspaceFocusRestoreContribution } from './WorkspaceFocusRestoreContribution.js'
export { WorkspaceExplorerRevealContribution } from './WorkspaceExplorerRevealContribution.js'
export { ExplorerAutoRevealContribution } from './ExplorerAutoRevealContribution.js'
export { RecentFilesContribution } from './RecentFilesContribution.js'
export { JsonSchemaBridgeContribution } from './JsonSchemaBridgeContribution.js'
export { ThemeContribution } from './ThemeContribution.js'
export { WorkbenchFontContribution } from './WorkbenchFontContribution.js'
export { NotificationStatusContribution } from './NotificationStatusContribution.js'
export { MarkdownPasteContribution } from './MarkdownPasteContribution.js'
