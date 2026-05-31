/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Built-in Action2 registrations. Imported for side-effect during bootstrap.
 *--------------------------------------------------------------------------------------------*/

import { registerAction2 } from '@universe-editor/platform'
import {
  ShowCommandsAction,
  ShowExplorerAction,
  ToggleActivityBarVisibilityAction,
  TogglePanelAction,
  ToggleSecondarySidebarVisibilityAction,
  ToggleSidebarVisibilityAction,
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
  SplitEditorDownAction,
  SplitEditorLeftAction,
  SplitEditorRightAction,
  SplitEditorUpAction,
  ToggleMinimapAction,
  ToggleWordWrapAction,
} from './editorActions.js'
import { OpenSettingsAction } from './preferencesActions.js'
import {
  ConfigureDisplayLanguageAction,
  OpenKeybindingsEditorAction,
  OpenKeybindingsJsonAction,
  OpenSettingsJsonAction,
  OpenWorkspaceSettingsAction,
  OpenWorkspaceSettingsJsonAction,
} from './preferencesActions.js'
import {
  AboutAction,
  CloseWindowAction,
  ExitAction,
  NewWindowAction,
  OpenFolderInNewWindowAction,
  OpenUserDataFolderAction,
  RestartEditorAction,
  SwitchWindowAction,
  ToggleDevToolsAction,
} from './windowActions.js'
import {
  ClearRecentWorkspacesAction,
  CloseFolderAction,
  OpenFolderAction,
  OpenRecentAction,
} from './workspaceActions.js'
import { SaveFileAction, SaveFileAsAction } from './fileSaveActions.js'
import { NewFileAction, NewFolderAction, NewUntitledFileAction } from './fileCreateActions.js'
import { DeleteFileAction, RenameFileAction } from './fileMutateActions.js'
import {
  ClearRecentFilesAction,
  GoToFileAction,
  OpenFileAction,
  OpenRecentFilesAction,
  OpenWithDefaultAppAction,
  RefreshExplorerAction,
} from './fileOpenActions.js'
import { RevealActiveFileInExplorerAction, RevealInOSExplorerAction } from './revealActions.js'
import { OpenInTerminalAction } from './terminalActions.js'
import {
  FindInFileAction,
  FindInFilesAction,
  FindNextAction,
  FindPreviousAction,
  FindReplaceInFileAction,
} from './searchActions.js'
import { CloseQuickInputAction } from './quickInputActions.js'
import { FocusNextPartAction, FocusPreviousPartAction } from './focusActions.js'
import { ClearHistoryAction, GoBackAction, GoForwardAction } from './historyActions.js'
import {
  ClearAllNotificationsAction,
  TestNotificationAction,
  ToggleNotificationsCenterAction,
} from './notificationActions.js'
import { ReopenWithAction } from './editorResolverActions.js'
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
  OpenAgentInEditorAction,
  OpenAgentViewAction,
  RefreshAgentSessionsAction,
  ResumeAgentSessionAction,
  ScrollAcpTimelinePageDownAction,
  ScrollAcpTimelinePageUpAction,
  ScrollAcpTimelineToBottomAction,
  ScrollAcpTimelineToTopAction,
  SelectAgentAction,
  SelectAgentModeAction,
  SelectAgentModelAction,
  SelectAgentThoughtLevelAction,
  ToggleAcpTimelineItemCollapseAction,
  CycleAcpTimelineCollapseAction,
  ToggleAgentChatLocationAction,
} from './agentActions.js'

// Layout
registerAction2(ToggleActivityBarVisibilityAction)
registerAction2(ToggleSidebarVisibilityAction)
registerAction2(ToggleSecondarySidebarVisibilityAction)
registerAction2(TogglePanelAction)
registerAction2(ShowCommandsAction)
registerAction2(ShowExplorerAction)

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

// Editor — tab navigation
registerAction2(NextEditorAction)
registerAction2(PreviousEditorAction)
registerAction2(QuickOpenRecentEditorAction)
registerAction2(QuickOpenRecentEditorReverseAction)
registerAction2(FirstEditorInGroupAction)
registerAction2(LastEditorInGroupAction)

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
registerAction2(ConfigureDisplayLanguageAction)
registerAction2(OpenWorkspaceSettingsAction)
registerAction2(OpenWorkspaceSettingsJsonAction)

// Workspace
registerAction2(OpenFolderAction)
registerAction2(OpenRecentAction)
registerAction2(ClearRecentWorkspacesAction)
registerAction2(CloseFolderAction)

// Files
registerAction2(SaveFileAction)
registerAction2(SaveFileAsAction)
registerAction2(GoToFileAction)
registerAction2(OpenFileAction)
registerAction2(OpenRecentFilesAction)
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

// Window / Help
registerAction2(NewWindowAction)
registerAction2(RestartEditorAction)
registerAction2(CloseWindowAction)
registerAction2(OpenFolderInNewWindowAction)
registerAction2(SwitchWindowAction)
registerAction2(ExitAction)
registerAction2(ToggleDevToolsAction)
registerAction2(AboutAction)
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

// Terminal
registerAction2(OpenInTerminalAction)

// Agents
registerAction2(NewAgentSessionAction)
registerAction2(CancelAgentTurnAction)
registerAction2(OpenAgentInEditorAction)
registerAction2(OpenAgentViewAction)
registerAction2(ToggleAgentChatLocationAction)
registerAction2(FocusAgentInputAction)
registerAction2(SelectAgentAction)
registerAction2(SelectAgentModelAction)
registerAction2(SelectAgentModeAction)
registerAction2(SelectAgentThoughtLevelAction)
registerAction2(ResumeAgentSessionAction)
registerAction2(ClearAgentSessionHistoryAction)
registerAction2(RefreshAgentSessionsAction)
registerAction2(FocusNextAcpTimelineItemAction)
registerAction2(FocusPreviousAcpTimelineItemAction)
registerAction2(ScrollAcpTimelineToTopAction)
registerAction2(ScrollAcpTimelineToBottomAction)
registerAction2(ScrollAcpTimelinePageUpAction)
registerAction2(ScrollAcpTimelinePageDownAction)
registerAction2(ToggleAcpTimelineItemCollapseAction)
registerAction2(CycleAcpTimelineCollapseAction)
