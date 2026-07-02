/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  AfterRestore-phase contribution registrations. Importing this module (side
 *  effect) registers every AfterRestore contribution with `ContributionsRegistry`.
 *--------------------------------------------------------------------------------------------*/

import { ContributionsRegistry, WorkbenchPhase } from '@universe-editor/platform'
import { AiStatusContribution } from '../AiStatusContribution.js'
import { JsonSchemaContextContribution } from '../JsonSchemaContextContribution.js'
import { JsonLanguageFeaturesContribution } from '../JsonLanguageFeaturesContribution.js'
import { InlineCompletionContribution } from '../InlineCompletionContribution.js'
import { FileEditorStatusContribution } from '../FileEditorStatusContribution.js'
import { GitBlameContribution } from '../GitBlameContribution.js'
import { GitMergeConflictContribution } from '../GitMergeConflictContribution.js'
import { DirtyDiffContribution } from '../DirtyDiffContribution.js'
import { ExternalChangeWatcher } from '../ExternalChangeWatcher.js'
import { GlobalDragAndDropContribution } from '../GlobalDragAndDropContribution.js'
import { WorkspaceRecentMenuContribution } from '../WorkspaceRecentMenuContribution.js'
import { WorkspaceExplorerRevealContribution } from '../WorkspaceExplorerRevealContribution.js'
import { WindowTitleContribution } from '../WindowTitleContribution.js'
import { ExplorerAutoRevealContribution } from '../ExplorerAutoRevealContribution.js'
import { RecentFilesContribution } from '../RecentFilesContribution.js'
import { NotificationStatusContribution } from '../NotificationStatusContribution.js'
import { UpdateContribution } from '../UpdateContribution.js'
import { ReleaseNotesContribution } from '../ReleaseNotesContribution.js'
import { LogTailContribution } from '../LogTailContribution.js'
import { ErrorLogAutoRevealContribution } from '../ErrorLogAutoRevealContribution.js'
import {
  AgentsActiveSessionSyncContribution,
  AgentsSessionEditorLifecycleContribution,
  AgentsSessionRestoreContribution,
} from '../AgentsContributions.js'
import { AgentNotificationContribution } from '../AgentNotificationContribution.js'
import { FirstRunAgentOnboardingContribution } from '../FirstRunAgentOnboardingContribution.js'
import { SessionShutdownParticipant } from '../SessionShutdownParticipant.js'
import { StartupPerformanceStatusContribution } from '../StartupPerformanceStatusContribution.js'
import { TerminalEditorLifecycleContribution } from '../TerminalEditorLifecycleContribution.js'
import { MonacoKeybindingSyncContribution } from '../MonacoKeybindingSyncContribution.js'
import { MonacoDefaultKeybindingOverrideContribution } from '../MonacoDefaultKeybindingOverrideContribution.js'
import { DocumentSyncContribution } from '../DocumentSyncContribution.js'
import { MarkdownPasteContribution } from '../MarkdownPasteContribution.js'
import { MarkdownDropContribution } from '../MarkdownDropContribution.js'
import { EditorOpenerContribution } from '../EditorOpenerContribution.js'
import { PeekNavigationContribution } from '../PeekNavigationContribution.js'
import {
  DirtyEditorsActivityContribution,
  ScmActivityContribution,
} from '../ActivityBarBadgeContributions.js'
import { ActiveRepoSyncContribution } from '../ActiveRepoSyncContribution.js'
import { OutlineViewStateContribution } from '../OutlineViewStateContribution.js'
import { HistoryContribution } from '../HistoryContribution.js'
import { StartupFileContribution } from '../StartupFileContribution.js'
import { StartupSessionContribution } from '../StartupSessionContribution.js'
import { SessionChangesDiffSyncContribution } from '../SessionChangesDiffSyncContribution.js'
import { DiffLiveContentSyncContribution } from '../DiffLiveContentSyncContribution.js'

// The single AI status-bar entry (sparkle + quick-settings popover). AfterRestore
// so the status bar exists when the entry is added.
ContributionsRegistry.registerContribution(
  'workbench.contrib.aiStatus',
  AiStatusContribution,
  WorkbenchPhase.AfterRestore,
)

// `activeEditorHasJsonSchema` context key — drives the editor-title "Show JSON
// Schema" action. AfterRestore: the editor service + schema registry are live,
// and it only gates an editor-title affordance (not first-paint).
ContributionsRegistry.registerContribution(
  'workbench.contrib.jsonSchemaContext',
  JsonSchemaContextContribution,
  WorkbenchPhase.AfterRestore,
)

// JSON document symbols (Outline / breadcrumbs / Go to Symbol in File) via a
// provider that delegates to Monaco's built-in JSON worker. AfterRestore so the
// language features service + Monaco are live, mirroring the other language
// feature wiring.
ContributionsRegistry.registerContribution(
  'workbench.contrib.jsonLanguageFeatures',
  JsonLanguageFeaturesContribution,
  WorkbenchPhase.AfterRestore,
)

ContributionsRegistry.registerContribution(
  'workbench.contrib.inlineCompletion',
  InlineCompletionContribution,
  WorkbenchPhase.AfterRestore,
)

// File editor cursor / language / encoding entries — only mount once both the
// status bar and the editor area are live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.fileEditorStatus',
  FileEditorStatusContribution,
  WorkbenchPhase.AfterRestore,
)

// Inline git blame on the cursor line + status-bar entry + hover. AfterRestore so
// the editor area, status bar and Monaco are live; blame data is fetched lazily
// from the `git` extension's contributed command once it activates.
ContributionsRegistry.registerContribution(
  'workbench.contrib.gitBlame',
  GitBlameContribution,
  WorkbenchPhase.AfterRestore,
)

// Inline merge-conflict resolution: scans the active file editor for git conflict
// markers, tints the regions, and floats Accept Current/Incoming/Both + Compare
// actions on each conflict. AfterRestore so the editor area + Monaco are live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.gitMergeConflict',
  GitMergeConflictContribution,
  WorkbenchPhase.AfterRestore,
)

// VSCode-style dirty diff: gutter bars + overview-ruler marks for lines changed
// vs git HEAD. AfterRestore so the editor area, Monaco and SCM model are live;
// HEAD content is fetched lazily from the `git` extension's contributed command.
ContributionsRegistry.registerContribution(
  'workbench.contrib.dirtyDiff',
  DirtyDiffContribution,
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

// Window-level safety net: preventDefault file/resource drags so dropping over
// any unhandled gap never makes Electron navigate to the file. AfterRestore so
// it installs once the workbench UI (and its drop targets) are live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.globalDragAndDrop',
  GlobalDragAndDropContribution,
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

// Auto-update: prompt notifications driven by the main-side update state machine
// (the always-visible indicator lives in the title bar). AfterRestore so the
// notification service is live.
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
ContributionsRegistry.registerContribution(
  'workbench.contrib.agentsActiveSessionSync',
  AgentsActiveSessionSyncContribution,
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

// Close editor tabs whose terminal process has exited. AfterRestore so editor
// groups are already rebuilt from storage.
ContributionsRegistry.registerContribution(
  'workbench.contrib.terminalEditorLifecycle',
  TerminalEditorLifecycleContribution,
  WorkbenchPhase.AfterRestore,
)

// Re-apply VSCode/user keybindings bound to monaco command ids once the monaco
// action bridge has run (those commands register lazily on monaco load, after
// the startup keybinding pass already skipped them). AfterRestore so the
// keybinding service is live; the actual reload waits on the bridge signal.
ContributionsRegistry.registerContribution(
  'workbench.contrib.monacoKeybindingSync',
  MonacoKeybindingSyncContribution,
  WorkbenchPhase.AfterRestore,
)

// Mirror `-command` disable entries (keybindings.json) onto Monaco's internal
// keybinding dispatch, so disabling a Monaco built-in default key (e.g.
// `-editor.action.insertCursorAbove`) actually frees the key instead of leaving
// Monaco's own dispatcher to consume it while the editor is focused. AfterRestore
// alongside the sync contribution; the actual work waits on the bridge signal.
ContributionsRegistry.registerContribution(
  'workbench.contrib.monacoDefaultKeybindingOverride',
  MonacoDefaultKeybindingOverrideContribution,
  WorkbenchPhase.AfterRestore,
)

// Mirrors all open editor documents into the trusted extension host so language
// plugins see workspace.textDocuments + onDidChangeTextDocument. AfterRestore so
// the editor service + Monaco models are live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.documentSync',
  DocumentSyncContribution,
  WorkbenchPhase.AfterRestore,
)

// Paste-to-link enhancement for markdown: pasting a file uri-list inserts a
// markdown image/link, pasting a URL over a selection wraps it as `[sel](url)`,
// pasting a binary image writes it to `assets/` beside the file and embeds it.
// AfterRestore so monaco's language-features service is live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.markdownPaste',
  MarkdownPasteContribution,
  WorkbenchPhase.AfterRestore,
)

// Drop-to-link enhancement for markdown (drag counterpart of the paste contrib):
// dropping a file into a markdown editor inserts a markdown image/link; dropping
// a binary image writes it to `assets/` beside the file and embeds it. Monaco's
// per-model dropIntoEditor is enabled for markdown only (see FileEditor).
// AfterRestore so monaco's language-features service is live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.markdownDrop',
  MarkdownDropContribution,
  WorkbenchPhase.AfterRestore,
)

// Routes Monaco's cross-file "open this resource" hook (Go to Definition into
// another file) through the workbench editor service. AfterRestore so the editor
// service + Monaco are live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.editorOpener',
  EditorOpenerContribution,
  WorkbenchPhase.AfterRestore,
)

// Make keyboard Enter inside the references peek follow to the target file
// (VSCode parity); standalone monaco only previews. AfterRestore so monaco +
// the editor opener handler it relies on are live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.peekNavigation',
  PeekNavigationContribution,
  WorkbenchPhase.AfterRestore,
)

// Activity Bar badges: unsaved file count on the Explorer, changed file count on
// Source Control. AfterRestore so the editor service + SCM model are live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.dirtyEditorsActivity',
  DirtyEditorsActivityContribution,
  WorkbenchPhase.AfterRestore,
)
ContributionsRegistry.registerContribution(
  'workbench.contrib.scmActivity',
  ScmActivityContribution,
  WorkbenchPhase.AfterRestore,
)

// Keep the git extension host's active repo in sync with the SCM view's selected
// repo, so argument-less git commands (command palette / keybindings / status
// bar) target the repo the user is looking at. AfterRestore so the SCM model and
// command service are live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.activeRepoSync',
  ActiveRepoSyncContribution,
  WorkbenchPhase.AfterRestore,
)

// Hydrate + persist the Outline view's user preferences (follow cursor / filter
// on type / sort order). AfterRestore so the storage service is live; hydration
// is fire-and-forget and the toolbar reads the observables once it mounts.
ContributionsRegistry.registerContribution(
  'workbench.contrib.outlineViewState',
  OutlineViewStateContribution,
  WorkbenchPhase.AfterRestore,
)

// Open a file that was passed via CLI argv at cold-launch (e.g. Windows double-click)
// or pushed from the main process when a second instance launches with a file path.
// AfterRestore so the editor groups are already rebuilt and can accept openEditor.
ContributionsRegistry.registerContribution(
  'workbench.contrib.startupFile',
  StartupFileContribution,
  WorkbenchPhase.AfterRestore,
)

// Resume a cross-worktree session this window was opened to follow (argv at
// cold-launch, or pushed over IPC when an existing window is focused).
// AfterRestore so the ACP session service + editor groups are live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.startupSession',
  StartupSessionContribution,
  WorkbenchPhase.AfterRestore,
)

// Keep already-open session diff tabs in sync with the change tracker: when the
// agent edits a tracked file again, push the fresh baseline/current into the
// open DiffEditorInput so it refreshes in place instead of showing a stale
// snapshot. AfterRestore so the editor groups + ACP session service are live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.sessionChangesDiffSync',
  SessionChangesDiffSyncContribution,
  WorkbenchPhase.AfterRestore,
)

// Keep an open diff tab's modified side in sync with live edits to its file:
// subscribe the diff to its originalUri's shared Monaco model so editing the file
// (after switching back, or side-by-side in a split group) refreshes the diff in
// place — including unsaved edits. AfterRestore so the editor groups are live.
ContributionsRegistry.registerContribution(
  'workbench.contrib.diffLiveContentSync',
  DiffLiveContentSyncContribution,
  WorkbenchPhase.AfterRestore,
)
