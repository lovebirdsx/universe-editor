/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-worktree session activation. A session carries the cwd it was created
 *  in; activating one whose cwd differs from the open folder must realign the
 *  window context to that cwd (single-root model — the agent, file tree, SCM and
 *  search all follow one folder) rather than spawning the agent against a sibling
 *  worktree behind the current UI. Two modes mirror OpenRecentAction:
 *   - newWindow:  open the owning worktree in a new window (current window intact)
 *   - same window: switch this window's folder after a shutdown confirmation
 *--------------------------------------------------------------------------------------------*/

import {
  URI,
  ShutdownReason,
  type ILifecycleService,
  type IWindowsService,
  type IWorkspaceService,
} from '@universe-editor/platform'

export interface ActivateForeignSessionDeps {
  windows: IWindowsService
  lifecycle: ILifecycleService
  workspace: IWorkspaceService
}

/**
 * Realign the window to a foreign session's worktree so it can be resumed there.
 * `newWindow` (default, plain click) opens the worktree in a new window; the
 * modifier-key path switches the current window after confirming shutdown.
 * Returns false when the same-window switch was vetoed by the shutdown guard.
 */
export async function activateForeignSession(
  deps: ActivateForeignSessionDeps,
  cwd: string,
  options: { newWindow: boolean },
): Promise<boolean> {
  const folder = URI.file(cwd)
  if (options.newWindow) {
    await deps.windows.openWindow(folder)
    return true
  }
  if (await deps.lifecycle.confirmBeforeShutdown(ShutdownReason.SwitchWorkspace)) return false
  await deps.workspace.openFolder(folder)
  return true
}
