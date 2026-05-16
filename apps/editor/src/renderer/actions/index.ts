/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Built-in Action2 registrations. Imported for side-effect during bootstrap.
 *--------------------------------------------------------------------------------------------*/

import { registerAction2 } from '@universe-editor/platform'
import {
  ShowCommandsAction,
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
} from './editorActions.js'
import { OpenSettingsAction } from './preferencesActions.js'
import { AboutAction, CloseWindowAction, ToggleDevToolsAction } from './windowActions.js'
import {
  ClearRecentWorkspacesAction,
  CloseFolderAction,
  OpenFolderAction,
  OpenRecentAction,
} from './workspaceActions.js'
import {
  DeleteFileAction,
  NewFileAction,
  NewFolderAction,
  OpenFileAction,
  RenameFileAction,
  SaveFileAction,
  SaveFileAsAction,
} from './fileActions.js'
import { NewUntitledFileAction } from './newUntitledFileAction.js'
import { RevealActiveFileInExplorerAction } from './revealActions.js'

// Layout
registerAction2(ToggleSidebarVisibilityAction)
registerAction2(ToggleSecondarySidebarVisibilityAction)
registerAction2(TogglePanelAction)
registerAction2(ShowCommandsAction)

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

// Preferences
registerAction2(OpenSettingsAction)

// Workspace
registerAction2(OpenFolderAction)
registerAction2(OpenRecentAction)
registerAction2(ClearRecentWorkspacesAction)
registerAction2(CloseFolderAction)

// Files
registerAction2(SaveFileAction)
registerAction2(SaveFileAsAction)
registerAction2(OpenFileAction)
registerAction2(NewUntitledFileAction)
registerAction2(NewFileAction)
registerAction2(NewFolderAction)
registerAction2(RenameFileAction)
registerAction2(DeleteFileAction)
registerAction2(RevealActiveFileInExplorerAction)

// Window / Help
registerAction2(CloseWindowAction)
registerAction2(ToggleDevToolsAction)
registerAction2(AboutAction)
