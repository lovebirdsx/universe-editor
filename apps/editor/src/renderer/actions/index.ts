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
  CloseEditorsToTheRightAction,
  CloseOtherEditorsAction,
  FirstEditorInGroupAction,
  FocusActiveEditorGroupAction,
  FocusFirstGroupAction,
  FocusLastGroupAction,
  FocusNextGroupAction,
  FocusPreviousGroupAction,
  LastEditorInGroupAction,
  NextEditorAction,
  PreviousEditorAction,
  SplitEditorDownAction,
  SplitEditorLeftAction,
  SplitEditorRightAction,
  SplitEditorUpAction,
  ToggleMinimapAction,
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
  NewWindowAction,
  RestartEditorAction,
  ToggleDevToolsAction,
} from './windowActions.js'
import {
  ClearRecentWorkspacesAction,
  CloseFolderAction,
  OpenFolderAction,
  OpenRecentAction,
} from './workspaceActions.js'
import {
  ClearRecentFilesAction,
  DeleteFileAction,
  NewFileAction,
  NewFolderAction,
  OpenFileAction,
  OpenRecentFilesAction,
  OpenWithDefaultAppAction,
  RenameFileAction,
  SaveFileAction,
  SaveFileAsAction,
} from './fileActions.js'
import { NewUntitledFileAction } from './newUntitledFileAction.js'
import { RevealActiveFileInExplorerAction, RevealInOSExplorerAction } from './revealActions.js'
import {
  FindInFileAction,
  FindInFilesAction,
  FindNextAction,
  FindPreviousAction,
  FindReplaceInFileAction,
} from './searchActions.js'
import { CloseQuickInputAction } from './quickInputActions.js'
import {
  ClearAllNotificationsAction,
  TestNotificationAction,
  ToggleNotificationsCenterAction,
} from './notificationActions.js'
import { ReopenWithAction } from './editorResolverActions.js'

// Layout
registerAction2(ToggleActivityBarVisibilityAction)
registerAction2(ToggleSidebarVisibilityAction)
registerAction2(ToggleSecondarySidebarVisibilityAction)
registerAction2(TogglePanelAction)
registerAction2(ShowCommandsAction)
registerAction2(ShowExplorerAction)

// Editor — view
registerAction2(ToggleMinimapAction)

// Editor — close
registerAction2(CloseActiveEditorAction)
registerAction2(CloseAllEditorsAction)
registerAction2(CloseOtherEditorsAction)
registerAction2(CloseEditorsToTheRightAction)

// Editor — tab navigation
registerAction2(NextEditorAction)
registerAction2(PreviousEditorAction)
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
registerAction2(OpenFileAction)
registerAction2(OpenRecentFilesAction)
registerAction2(ClearRecentFilesAction)
registerAction2(NewUntitledFileAction)
registerAction2(NewFileAction)
registerAction2(NewFolderAction)
registerAction2(RenameFileAction)
registerAction2(DeleteFileAction)
registerAction2(OpenWithDefaultAppAction)
registerAction2(RevealActiveFileInExplorerAction)
registerAction2(RevealInOSExplorerAction)

// Window / Help
registerAction2(NewWindowAction)
registerAction2(RestartEditorAction)
registerAction2(CloseWindowAction)
registerAction2(ToggleDevToolsAction)
registerAction2(AboutAction)

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
