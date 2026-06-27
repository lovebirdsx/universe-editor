/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Built-in Action2 registrations. Imported for side-effect during bootstrap.
 *--------------------------------------------------------------------------------------------*/

import { registerAction2 } from '@universe-editor/platform'
import {
  GoToNextDifferenceAction,
  GoToPreviousDifferenceAction,
  OpenDiffAction,
} from './diffActions.js'
import { GoToNextChangeAction, GoToPreviousChangeAction } from './dirtyDiffActions.js'
import {
  GoToNextMergeConflictAction,
  GoToPreviousMergeConflictAction,
} from './mergeConflictActions.js'
import { CompleteMergeAction, OpenMergeEditorAction } from './mergeActions.js'
import {
  GetActiveEditorFileAction,
  GetConfigurationAction,
  OpenFileAction as OpenFileFromExtensionAction,
  OpenFileAtAction,
} from './extensionApiActions.js'
import {
  ShowCommandsAction,
  ShowExplorerAction,
  ShowScmAction,
  FocusOutlineAction,
  ToggleActivityBarVisibilityAction,
  TogglePanelAction,
  ToggleMaximizedPanelAction,
  ToggleSecondarySidebarVisibilityAction,
  ToggleSidebarVisibilityAction,
  IncreaseViewWidthAction,
  DecreaseViewWidthAction,
  IncreaseViewHeightAction,
  DecreaseViewHeightAction,
} from './layoutActions.js'
import {
  CloseActiveEditorAction,
  CloseAllEditorsAction,
  CloseEditorsInGroupAction,
  CloseEditorsToTheLeftAction,
  CloseEditorsToTheRightAction,
  CloseOtherEditorsAction,
  CloseUnmodifiedEditorsAction,
  FirstEditorInGroupAction,
  FocusAboveGroupAction,
  FocusActiveEditorGroupAction,
  FocusBelowGroupAction,
  FocusFirstGroupAction,
  FocusLastGroupAction,
  FocusLeftGroupAction,
  FocusNextGroupAction,
  FocusPreviousGroupAction,
  FocusRightGroupAction,
  LastEditorInGroupAction,
  MoveEditorLeftInGroupAction,
  MoveEditorRightInGroupAction,
  MoveEditorToAboveGroupAction,
  MoveEditorToBelowGroupAction,
  MoveEditorToLeftGroupAction,
  MoveEditorToNextGroupAction,
  MoveEditorToPreviousGroupAction,
  MoveEditorToRightGroupAction,
  NextEditorAction,
  PreviousEditorAction,
  QuickOpenRecentEditorAction,
  QuickOpenRecentEditorReverseAction,
  ReopenClosedEditorAction,
  SplitEditorDownAction,
  SplitEditorLeftAction,
  SplitEditorRightAction,
  SplitEditorUpAction,
  ToggleMinimapAction,
  ToggleWordWrapAction,
} from './editorActions.js'
import {
  ConfigureDisplayLanguageAction,
  OpenKeybindingsEditorAction,
  OpenKeybindingsJsonAction,
  OpenSettingsAction,
  OpenSettingsJsonAction,
  OpenVSCodeKeybindingsJsonAction,
  OpenVSCodeSettingsJsonAction,
  OpenWorkspaceSettingsAction,
  OpenWorkspaceSettingsJsonAction,
  SelectColorThemeAction,
} from './preferencesActions.js'
import {
  OpenConfigLocationFolderAction,
  ResetConfigLocationAction,
  SetConfigLocationAction,
} from './configLocationActions.js'
import {
  AboutAction,
  CloseWindowAction,
  ExitAction,
  NewWindowAction,
  OpenFolderInNewWindowAction,
  OpenUserDataFolderAction,
  ReloadWindowAction,
  SwitchWindowAction,
  ToggleDevToolsAction,
} from './windowActions.js'
import {
  ClearRecentWorkspacesAction,
  CloseFolderAction,
  OpenFolderAction,
  OpenRecentAction,
  OpenWorkspaceInVSCodeAction,
} from './workspaceActions.js'
import { SaveAllFilesAction, SaveFileAction, SaveFileAsAction } from './fileSaveActions.js'
import { NewFileAction, NewFolderAction, NewUntitledFileAction } from './fileCreateActions.js'
import { DeleteFileAction, RenameFileAction } from './fileMutateActions.js'
import {
  ClearRecentFilesAction,
  GoToFileAction,
  OpenFileAction,
  OpenWithDefaultAppAction,
  RefreshExplorerAction,
} from './fileOpenActions.js'
import { RevealActiveFileInExplorerAction, RevealInOSExplorerAction } from './revealActions.js'
import {
  CopyFileNameAction,
  CopyFilePathAction,
  CopyFileRelativePathAction,
} from './fileCopyActions.js'
import {
  NewTerminalAction,
  SplitTerminalAction,
  OpenInTerminalAction,
  ToggleTerminalAction,
  OpenTerminalInEditorAction,
  FocusTerminalPanelAction,
} from './terminalActions.js'
import {
  FindInFileAction,
  FindInFilesAction,
  FindNextAction,
  FindPreviousAction,
  FindReplaceInFileAction,
  QuickTextSearchAction,
} from './searchActions.js'
import { CloseQuickInputAction } from './quickInputActions.js'
import { FocusNextPartAction, FocusPreviousPartAction } from './focusActions.js'
import { ClearHistoryAction, GoBackAction, GoForwardAction } from './historyActions.js'
import { GoToWorkspaceSymbolAction, GoToFileSymbolAction } from './gotoSymbolActions.js'
import { gotoLocationActions } from './gotoLocationActions.js'
import {
  ClearAllNotificationsAction,
  TestNotificationAction,
  ToggleNotificationsCenterAction,
} from './notificationActions.js'
import { ReopenWithAction } from './editorResolverActions.js'
import { ResetViewLocationsAction } from './viewActions.js'
import {
  PickModelAction,
  ManageModelsAction,
  OpenAiSettingsJsonAction,
  SetApiKeyAction,
  ClearApiKeyAction,
} from './aiActions.js'
import {
  TriggerInlineCompletionAction,
  CommitInlineCompletionAction,
  JumpToNextInlineEditAction,
  ToggleInlineCompletionAction,
  PickInlineCompletionModelAction,
} from './inlineCompletionActions.js'
import { PickCommitModelAction } from './commitMessageActions.js'
import { PickSessionTitleModelAction } from './sessionTitleActions.js'
import {
  ViewGitGraphAction,
  GitGraphFocusSearchAction,
  GitGraphToggleRemoteBranchesAction,
} from './gitGraphActions.js'
import {
  ToggleBlameEditorDecorationAction,
  ToggleBlameStatusBarItemAction,
} from './gitBlameActions.js'
import { ShowStartupPerformanceAction } from './performanceActions.js'
import { ToggleKeybindingsTroubleshootingAction } from './developerActions.js'
import { OpenEditorGuideAction, OpenAgentGuideAction } from './helpActions.js'
import {
  OpenMarkdownPreviewAction,
  OpenMarkdownPreviewToSideAction,
  OpenMarkdownSourceAction,
  MarkdownPreviewFindAction,
  MarkdownPreviewFindNextAction,
  MarkdownPreviewFindPreviousAction,
  MarkdownPreviewFindCloseAction,
} from './markdownActions.js'
import { ShowJsonSchemaAction } from './jsonSchemaActions.js'
import {
  CheckForUpdatesAction,
  DownloadUpdateAction,
  InstallUpdateAction,
} from './updateActions.js'
import { ShowReleaseNotesAction } from './helpActions.js'
import {
  ClearOutputAction,
  OpenActiveLogFileAction,
  OpenLogFileAction,
  OpenLogsFolderAction,
  RefreshLogOutputAction,
  SetLogLevelAction,
  ShowLogsAction,
  ShowOutputChannelAction,
  ToggleOutputAction,
} from './logActions.js'
import {
  CancelAgentTurnAction,
  ClearAgentSessionHistoryAction,
  FocusAgentInputAction,
  FocusNextAcpTimelineItemAction,
  FocusPreviousAcpTimelineItemAction,
  NewAgentSessionAction,
  OpenAcpMcpSettingsAction,
  OpenAgentSettingsAction,
  OpenAgentInEditorAction,
  OpenAgentViewAction,
  RefreshAgentSessionsAction,
  ResumeAgentSessionAction,
  ScrollAcpTimelinePageDownAction,
  ScrollAcpTimelinePageUpAction,
  FocusBottomAcpTimelineAction,
  FocusTopAcpTimelineAction,
  JumpToAcpPlanAction,
  ShowAcpSessionChangesAction,
  SelectAgentAction,
  SelectAgentModeAction,
  SelectAgentModelAction,
  SelectAgentThoughtLevelAction,
  ToggleAcpTimelineItemCollapseAction,
  CycleAcpTimelineCollapseAction,
  ToggleAgentChatLocationAction,
  ScrollAcpTimelineUpAction,
  ScrollAcpTimelineDownAction,
  SwitchSessionAction,
  CopyFocusedAcpMessageAction,
  IncreaseAgentFontSizeAction,
  DecreaseAgentFontSizeAction,
  ResetAgentFontSizeAction,
  SelectNextAcpPromptSuggestionAction,
  SelectPreviousAcpPromptSuggestionAction,
  AcceptAcpPromptSuggestionAction,
  HideAcpPromptSuggestionAction,
  ChatFindAction,
  ChatFindNextAction,
  ChatFindPreviousAction,
  ChatFindCloseAction,
} from './agentActions.js'

// Layout
registerAction2(ToggleActivityBarVisibilityAction)
registerAction2(ToggleSidebarVisibilityAction)
registerAction2(ToggleSecondarySidebarVisibilityAction)
registerAction2(TogglePanelAction)
registerAction2(ToggleMaximizedPanelAction)
registerAction2(IncreaseViewWidthAction)
registerAction2(DecreaseViewWidthAction)
registerAction2(IncreaseViewHeightAction)
registerAction2(DecreaseViewHeightAction)
registerAction2(ShowCommandsAction)
registerAction2(ShowExplorerAction)
registerAction2(ShowScmAction)
registerAction2(FocusOutlineAction)

// Editor — view
registerAction2(ToggleMinimapAction)
registerAction2(ToggleWordWrapAction)

// Editor — close
registerAction2(CloseActiveEditorAction)
registerAction2(CloseAllEditorsAction)
registerAction2(CloseOtherEditorsAction)
registerAction2(CloseEditorsToTheRightAction)
registerAction2(CloseEditorsToTheLeftAction)
registerAction2(CloseUnmodifiedEditorsAction)
registerAction2(CloseEditorsInGroupAction)
registerAction2(ReopenClosedEditorAction)

// Editor — tab navigation
registerAction2(NextEditorAction)
registerAction2(PreviousEditorAction)
registerAction2(QuickOpenRecentEditorAction)
registerAction2(QuickOpenRecentEditorReverseAction)
registerAction2(FirstEditorInGroupAction)
registerAction2(LastEditorInGroupAction)
registerAction2(MoveEditorLeftInGroupAction)
registerAction2(MoveEditorRightInGroupAction)

// Editor — split
registerAction2(SplitEditorRightAction)
registerAction2(SplitEditorDownAction)
registerAction2(SplitEditorLeftAction)
registerAction2(SplitEditorUpAction)

// Editor — group focus
registerAction2(FocusNextGroupAction)
registerAction2(FocusPreviousGroupAction)
registerAction2(FocusFirstGroupAction)
registerAction2(FocusLastGroupAction)
registerAction2(FocusActiveEditorGroupAction)
registerAction2(FocusLeftGroupAction)
registerAction2(FocusRightGroupAction)
registerAction2(FocusAboveGroupAction)
registerAction2(FocusBelowGroupAction)

// Focus — cross-part navigation
registerAction2(FocusNextPartAction)
registerAction2(FocusPreviousPartAction)

// History — back/forward navigation
registerAction2(GoBackAction)
registerAction2(GoForwardAction)
registerAction2(ClearHistoryAction)

// Go — symbol navigation
registerAction2(GoToWorkspaceSymbolAction)
registerAction2(GoToFileSymbolAction)

// Go — location navigation (Monaco goto/peek definition, type, impl, references)
for (const action of gotoLocationActions) registerAction2(action)

// Editor — move editor to group
registerAction2(MoveEditorToLeftGroupAction)
registerAction2(MoveEditorToRightGroupAction)
registerAction2(MoveEditorToAboveGroupAction)
registerAction2(MoveEditorToBelowGroupAction)
registerAction2(MoveEditorToNextGroupAction)
registerAction2(MoveEditorToPreviousGroupAction)

// Preferences
registerAction2(OpenSettingsAction)
registerAction2(OpenKeybindingsEditorAction)
registerAction2(OpenSettingsJsonAction)
registerAction2(OpenKeybindingsJsonAction)
registerAction2(OpenVSCodeKeybindingsJsonAction)
registerAction2(OpenVSCodeSettingsJsonAction)
registerAction2(ConfigureDisplayLanguageAction)
registerAction2(OpenWorkspaceSettingsAction)
registerAction2(OpenWorkspaceSettingsJsonAction)
registerAction2(SelectColorThemeAction)
registerAction2(SetConfigLocationAction)
registerAction2(OpenConfigLocationFolderAction)
registerAction2(ResetConfigLocationAction)

// Workspace
registerAction2(OpenFolderAction)
registerAction2(OpenRecentAction)
registerAction2(ClearRecentWorkspacesAction)
registerAction2(CloseFolderAction)
registerAction2(OpenWorkspaceInVSCodeAction)

// Files
registerAction2(SaveFileAction)
registerAction2(SaveFileAsAction)
registerAction2(SaveAllFilesAction)
registerAction2(GoToFileAction)
registerAction2(OpenFileAction)
registerAction2(ClearRecentFilesAction)
registerAction2(NewUntitledFileAction)
registerAction2(NewFileAction)
registerAction2(NewFolderAction)
registerAction2(RenameFileAction)
registerAction2(DeleteFileAction)
registerAction2(OpenWithDefaultAppAction)
registerAction2(RefreshExplorerAction)
registerAction2(RevealActiveFileInExplorerAction)
registerAction2(RevealInOSExplorerAction)
registerAction2(CopyFileNameAction)
registerAction2(CopyFilePathAction)
registerAction2(CopyFileRelativePathAction)

// Window / Help
registerAction2(NewWindowAction)
registerAction2(ReloadWindowAction)
registerAction2(CloseWindowAction)
registerAction2(OpenFolderInNewWindowAction)
registerAction2(SwitchWindowAction)
registerAction2(ExitAction)
registerAction2(ToggleDevToolsAction)
registerAction2(AboutAction)
registerAction2(OpenEditorGuideAction)
registerAction2(OpenAgentGuideAction)
registerAction2(OpenUserDataFolderAction)
registerAction2(ShowLogsAction)
registerAction2(RefreshLogOutputAction)
registerAction2(OpenActiveLogFileAction)
registerAction2(OpenLogFileAction)
registerAction2(OpenLogsFolderAction)
registerAction2(SetLogLevelAction)
registerAction2(ShowOutputChannelAction)
registerAction2(ClearOutputAction)
registerAction2(ToggleOutputAction)

// Search
registerAction2(FindInFilesAction)
registerAction2(QuickTextSearchAction)
registerAction2(FindInFileAction)
registerAction2(FindReplaceInFileAction)
registerAction2(FindNextAction)
registerAction2(FindPreviousAction)

// Quick Input (registered last so its `escape` binding wins over
// FocusActiveEditorGroupAction whenever `quickInputVisible` is true).
registerAction2(CloseQuickInputAction)

// Notifications
registerAction2(ToggleNotificationsCenterAction)
registerAction2(ClearAllNotificationsAction)
registerAction2(TestNotificationAction)

// Editor resolver
registerAction2(ReopenWithAction)

// Views — reset view locations (move is via drag & drop)
registerAction2(ResetViewLocationsAction)

// AI
registerAction2(PickModelAction)
registerAction2(ManageModelsAction)
registerAction2(OpenAiSettingsJsonAction)
registerAction2(SetApiKeyAction)
registerAction2(ClearApiKeyAction)
registerAction2(TriggerInlineCompletionAction)
registerAction2(CommitInlineCompletionAction)
registerAction2(JumpToNextInlineEditAction)
registerAction2(ToggleInlineCompletionAction)
registerAction2(PickInlineCompletionModelAction)
registerAction2(PickCommitModelAction)
registerAction2(PickSessionTitleModelAction)

// Git Graph
registerAction2(ViewGitGraphAction)
registerAction2(GitGraphFocusSearchAction)
registerAction2(GitGraphToggleRemoteBranchesAction)

// Git Blame
registerAction2(ToggleBlameEditorDecorationAction)
registerAction2(ToggleBlameStatusBarItemAction)

// Developer
registerAction2(ShowStartupPerformanceAction)
registerAction2(ToggleKeybindingsTroubleshootingAction)

// Markdown
registerAction2(OpenMarkdownPreviewAction)
registerAction2(OpenMarkdownPreviewToSideAction)
registerAction2(OpenMarkdownSourceAction)
registerAction2(MarkdownPreviewFindAction)
registerAction2(MarkdownPreviewFindNextAction)
registerAction2(MarkdownPreviewFindPreviousAction)
registerAction2(MarkdownPreviewFindCloseAction)

registerAction2(ShowJsonSchemaAction)

// Diff (internal, invoked by the extension host)
registerAction2(OpenDiffAction)
registerAction2(GoToNextDifferenceAction)
registerAction2(GoToPreviousDifferenceAction)

// Editor — dirty-diff navigation (next/previous change vs git HEAD)
registerAction2(GoToNextChangeAction)
registerAction2(GoToPreviousChangeAction)
registerAction2(GoToNextMergeConflictAction)
registerAction2(GoToPreviousMergeConflictAction)
registerAction2(OpenMergeEditorAction)
registerAction2(CompleteMergeAction)
registerAction2(GetActiveEditorFileAction)
registerAction2(OpenFileFromExtensionAction)
registerAction2(OpenFileAtAction)
registerAction2(GetConfigurationAction)

// Update
registerAction2(CheckForUpdatesAction)
registerAction2(DownloadUpdateAction)
registerAction2(InstallUpdateAction)
registerAction2(ShowReleaseNotesAction)

// Terminal
registerAction2(OpenInTerminalAction)
registerAction2(ToggleTerminalAction)
registerAction2(NewTerminalAction)
registerAction2(SplitTerminalAction)
registerAction2(OpenTerminalInEditorAction)
registerAction2(FocusTerminalPanelAction)

// Agents
registerAction2(NewAgentSessionAction)
registerAction2(CancelAgentTurnAction)
registerAction2(OpenAgentInEditorAction)
registerAction2(OpenAgentViewAction)
registerAction2(ToggleAgentChatLocationAction)
registerAction2(FocusAgentInputAction)
registerAction2(SelectAgentAction)
registerAction2(OpenAcpMcpSettingsAction)
registerAction2(OpenAgentSettingsAction)
registerAction2(SelectAgentModelAction)
registerAction2(SelectAgentModeAction)
registerAction2(SelectAgentThoughtLevelAction)
registerAction2(ResumeAgentSessionAction)
registerAction2(ClearAgentSessionHistoryAction)
registerAction2(RefreshAgentSessionsAction)
registerAction2(FocusNextAcpTimelineItemAction)
registerAction2(FocusPreviousAcpTimelineItemAction)
registerAction2(FocusTopAcpTimelineAction)
registerAction2(FocusBottomAcpTimelineAction)
registerAction2(JumpToAcpPlanAction)
registerAction2(ShowAcpSessionChangesAction)
registerAction2(ScrollAcpTimelineUpAction)
registerAction2(ScrollAcpTimelineDownAction)
registerAction2(ScrollAcpTimelinePageUpAction)
registerAction2(ScrollAcpTimelinePageDownAction)
registerAction2(ToggleAcpTimelineItemCollapseAction)
registerAction2(CycleAcpTimelineCollapseAction)
registerAction2(SwitchSessionAction)
registerAction2(CopyFocusedAcpMessageAction)
registerAction2(IncreaseAgentFontSizeAction)
registerAction2(DecreaseAgentFontSizeAction)
registerAction2(ResetAgentFontSizeAction)
// Prompt suggestion popover — registered last so its `escape` / `enter` / `tab`
// / `ctrl+j` / `ctrl+n` / `ctrl+p` bindings win the newest-wins tie-break over
// global shortcuts whenever `acpPromptPopupVisible` is set.
registerAction2(SelectNextAcpPromptSuggestionAction)
registerAction2(SelectPreviousAcpPromptSuggestionAction)
registerAction2(AcceptAcpPromptSuggestionAction)
registerAction2(HideAcpPromptSuggestionAction)
// In-session find — registered last so its `f3` / `shift+f3` / `escape` bindings
// win the newest-wins tie-break over global shortcuts whenever
// `acpChatFindVisible` is set (`ctrl+f` to open gates on `acpChatFocused`).
registerAction2(ChatFindAction)
registerAction2(ChatFindNextAction)
registerAction2(ChatFindPreviousAction)
registerAction2(ChatFindCloseAction)
