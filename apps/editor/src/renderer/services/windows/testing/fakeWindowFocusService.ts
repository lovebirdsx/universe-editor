/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Test helper: records every focus request so tests can assert that a reveal
 *  path asked the OS window (not just the renderer activation) to follow.
 *--------------------------------------------------------------------------------------------*/

import type { IEditorGroup } from '@universe-editor/platform'
import type { IWindowFocusService } from '../windowFocusService.js'
import type { IWorkbenchWindow } from '../workbenchWindowService.js'

export class FakeWindowFocusService implements IWindowFocusService {
  declare readonly _serviceBrand: undefined

  readonly focusedWindows: IWorkbenchWindow[] = []
  readonly focusedGroups: IEditorGroup[] = []
  focusMainWindowCalls = 0

  focusWindow(win: IWorkbenchWindow): void {
    this.focusedWindows.push(win)
  }

  focusGroup(group: IEditorGroup): void {
    this.focusedGroups.push(group)
  }

  focusMainWindow(): void {
    this.focusMainWindowCalls++
    this.focusedWindows.push({ isMain: true, token: undefined } as unknown as IWorkbenchWindow)
  }
}
