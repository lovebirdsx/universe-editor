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

registerAction2(ToggleSidebarVisibilityAction)
registerAction2(ToggleSecondarySidebarVisibilityAction)
registerAction2(TogglePanelAction)
registerAction2(ShowCommandsAction)
