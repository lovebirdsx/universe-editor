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
import { FocusContextKeyContribution } from './FocusContextKeyContribution.js'
import { WorkbenchPartsContribution } from './WorkbenchPartsContribution.js'
import { ConfigInitContribution } from './ConfigInitContribution.js'
import { AcpInitContribution } from './AcpInitContribution.js'
import { HistoryContribution } from './HistoryContribution.js'
import { SettingsContribution } from './SettingsContribution.js'
import { FileEditorStatusContribution } from './FileEditorStatusContribution.js'
import { ExternalChangeWatcher } from './ExternalChangeWatcher.js'
import { WorkspaceRecentMenuContribution } from './WorkspaceRecentMenuContribution.js'
import { WorkspaceRestoreContribution } from './WorkspaceRestoreContribution.js'
import { WorkspaceExplorerRevealContribution } from './WorkspaceExplorerRevealContribution.js'
import { WindowTitleContribution } from './WindowTitleContribution.js'
import { ExplorerAutoRevealContribution } from './ExplorerAutoRevealContribution.js'
import { RecentFilesContribution } from './RecentFilesContribution.js'
import { JsonSchemaBridgeContribution } from './JsonSchemaBridgeContribution.js'
import { ThemeContribution } from './ThemeContribution.js'
import { WorkbenchFontContribution } from './WorkbenchFontContribution.js'
import { NotificationStatusContribution } from './NotificationStatusContribution.js'
import { UpdateContribution } from './UpdateContribution.js'
import { ReleaseNotesContribution } from './ReleaseNotesContribution.js'
import { BuiltInEditorBindingsContribution } from './BuiltInEditorBindingsContribution.js'
import { ExplorerMenuContribution } from './ExplorerMenuContribution.js'
import { EditMenuContribution } from './EditMenuContribution.js'
import { LogLevelContribution } from './LogLevelContribution.js'
import { LogTailContribution } from './LogTailContribution.js'
import { AggregatedLogChannelContribution } from './AggregatedLogChannelContribution.js'
import { ErrorLogAutoRevealContribution } from './ErrorLogAutoRevealContribution.js'
import {
  AgentsConfigurationContribution,
  AgentsEditorProviderContribution,
  AgentsSessionEditorLifecycleContribution,
  AgentsSessionRestoreContribution,
  AgentsStatusBarContribution,
  AgentsViewContainerContribution,
} from './AgentsContributions.js'
import { AgentNotificationContribution } from './AgentNotificationContribution.js'
import { FirstRunAgentOnboardingContribution } from './FirstRunAgentOnboardingContribution.js'
import { SessionShutdownParticipant } from './SessionShutdownParticipant.js'
import { StartupPerformanceStatusContribution } from './StartupPerformanceStatusContribution.js'

// ContextKey defaults must seed before any contribution evaluates a when-clause.
ContributionsRegistry.registerContribution(
  'workbench.contrib.contextKey',
  ContextKeyContribution,
  WorkbenchPhase.BlockStartup,
)

// Focus-related context keys. BlockStartup so when-clauses involving
// focusedPart/focusedView/sideBarFocus/etc. resolve correctly from the very
// first command dispatch.
ContributionsRegistry.registerContribution(
  'workbench.contrib.focusContextKey',
  FocusContextKeyContribution,
  WorkbenchPhase.BlockStartup,
)

// Instantiate the six workbench Parts (they self-register with the
// LayoutService on construction) and bridge the FocusTracker to each Part.
// BlockStartup so getPart()/getParts() resolve before any React paint.
ContributionsRegistry.registerContribution(
  'workbench.contrib.workbenchParts',
  WorkbenchPartsContribution,
  WorkbenchPhase.BlockStartup,
)

// Kick off file-backed settings.json / keybindings.json loads. BlockStartup so
// the User config + keybinding layers are in flight before UI paint; both loads
// are async fire-and-forget and refresh subscribers via change events.
ContributionsRegistry.registerContribution(
  'workbench.contrib.configInit',
  ConfigInitContribution,
  WorkbenchPhase.BlockStartup,
)

// Hydrate ACP persisted state (session history / per-agent defaults / chat
// location). BlockStartup so hydration is in flight before session restore
// (AfterRestore) and before any createSession; all initialize() calls are
// fire-and-forget.
ContributionsRegistry.registerContribution(
  'workbench.contrib.acpInit',
  AcpInitContribution,
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

// Keep the native window title in sync with the current workspace folder so
// Alt+Tab / the taskbar identifies each window by its workspace path.
ContributionsRegistry.registerContribution(
  'workbench.contrib.windowTitle',
  WindowTitleContribution,
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

// Auto-update: status-bar entry + prompt notifications, driven by the main-side
// update state machine. AfterRestore so the status bar + notifications are live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.update',
  UpdateContribution,
  WorkbenchPhase.AfterRestore,
)

// Show "what's new" after an upgrade. AfterRestore so the editor area is mounted
// and activeGroup can host the tab.
ContributionsRegistry.registerContribution(
  'workbench.contrib.releaseNotes',
  ReleaseNotesContribution,
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

// Edit menu (Undo/Redo/Cut/Copy/Paste/Select All/Find/Replace). BlockStartup so
// the menubar structure is in place before the title bar first renders.
ContributionsRegistry.registerContribution(
  'workbench.contrib.editMenu',
  EditMenuContribution,
  WorkbenchPhase.BlockStartup,
)

// Apply persisted `logging.level` to the renderer + main loggers as early as
// possible so the configured level is in effect before bulk restore traffic.
ContributionsRegistry.registerContribution(
  'workbench.contrib.logLevel',
  LogLevelContribution,
  WorkbenchPhase.BlockStartup,
)

// Live tail of main-side log writes into the active log Output channel.
// AfterRestore so the Output service and panel UI are already wired up.
ContributionsRegistry.registerContribution(
  'workbench.contrib.logTail',
  LogTailContribution,
  WorkbenchPhase.AfterRestore,
)

// First Error log in a window reveals the Output panel and activates the
// channel that emitted the error so failures do not stay hidden in the logs.
ContributionsRegistry.registerContribution(
  'workbench.contrib.errorLogAutoReveal',
  ErrorLogAutoRevealContribution,
  WorkbenchPhase.AfterRestore,
)

// "All" aggregated Output channel — merges every log channel in time order so
// users can see cross-channel activity at a glance. BlockRestore so the All
// channel appears in the dropdown before AfterRestore contributions stream
// their first chunks (otherwise early appends are dropped while descriptors
// are being fetched).
ContributionsRegistry.registerContribution(
  'workbench.contrib.aggregatedLogChannel',
  AggregatedLogChannelContribution,
  WorkbenchPhase.BlockRestore,
)

// ACP integration: configuration schema, view container/views, editor provider
// (BlockStartup); status-bar entry runs after the workbench mounts.
ContributionsRegistry.registerContribution(
  'workbench.contrib.agentsConfiguration',
  AgentsConfigurationContribution,
  WorkbenchPhase.BlockStartup,
)
ContributionsRegistry.registerContribution(
  'workbench.contrib.agentsViewContainer',
  AgentsViewContainerContribution,
  WorkbenchPhase.BlockStartup,
)
ContributionsRegistry.registerContribution(
  'workbench.contrib.agentsEditorProvider',
  AgentsEditorProviderContribution,
  WorkbenchPhase.BlockStartup,
)
ContributionsRegistry.registerContribution(
  'workbench.contrib.agentsStatusBar',
  AgentsStatusBarContribution,
  WorkbenchPhase.AfterRestore,
)
ContributionsRegistry.registerContribution(
  'workbench.contrib.agentsSessionRestore',
  AgentsSessionRestoreContribution,
  WorkbenchPhase.AfterRestore,
)
ContributionsRegistry.registerContribution(
  'workbench.contrib.agentsSessionEditorLifecycle',
  AgentsSessionEditorLifecycleContribution,
  WorkbenchPhase.AfterRestore,
)

// Guard running ACP sessions on quit / close / reload / switch-workspace: prompt
// before interrupting them. AfterRestore so the session service + dialog are live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.sessionShutdownParticipant',
  SessionShutdownParticipant,
  WorkbenchPhase.AfterRestore,
)

// OS-level desktop notifications when an Agent session needs attention while the
// window is blurred. AfterRestore so the host service + Agents UI are live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.agentNotification',
  AgentNotificationContribution,
  WorkbenchPhase.AfterRestore,
)

// First-run only: reveal the Agents side bar so new users discover the editor's
// core feature. Self-gates on a GLOBAL storage flag. AfterRestore so layout
// visibility + view containers are live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.firstRunAgentOnboarding',
  FirstRunAgentOnboardingContribution,
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

// Navigation history (Alt+Left / Alt+Right). AfterRestore because cursor
// listeners attach via FileEditorRegistry events that only fire once Monaco
// editors mount, which happens after the editor area renders.
ContributionsRegistry.registerContribution(
  'workbench.contrib.history',
  HistoryContribution,
  WorkbenchPhase.AfterRestore,
)

// Startup performance: show total startup time in the status bar when it exceeds
// the configured threshold. AfterRestore so the renderer didMount mark is set and
// the status bar is live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.startupPerformanceStatus',
  StartupPerformanceStatusContribution,
  WorkbenchPhase.AfterRestore,
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
