/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Guards running ACP sessions across shutdown-like transitions. Participates in
 *  the lifecycle veto chain (quit / close window / reload / switch workspace):
 *  if any session is still running — or still executing `run_in_background`
 *  tasks past its settled turn — it prompts the user before letting the action
 *  interrupt them. Modelled on VSCode's WorkingCopyBackupTracker.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IDialogService,
  ILifecycleService,
  IWindowsService,
  localize,
  ShutdownReason,
  type IWorkbenchContribution,
  type RunningSessionsByWindow,
  type RunningSessionsShutdownInfo,
} from '@universe-editor/platform'
import { IAcpSessionService } from '../services/acp/session/acpSessionService.js'
import { E2E_PROBE_ENABLED_KEY } from '../../shared/e2e/contract.js'

export class SessionShutdownParticipant extends Disposable implements IWorkbenchContribution {
  constructor(
    @ILifecycleService lifecycle: ILifecycleService,
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IDialogService private readonly _dialog: IDialogService,
    @IWindowsService private readonly _windows: IWindowsService,
  ) {
    super()
    this._register(
      lifecycle.onBeforeShutdown((e) =>
        e.veto(
          this._maybeVeto(
            e.reason,
            e.context?.runningSessions,
            e.context?.skipRunningSessionPrompt === true,
            e.context?.skipSessionIds,
            e.context?.promptAckId,
          ),
          'acp.runningSessions',
        ),
      ),
    )
  }

  /** @returns true to veto (cancel the action), false to proceed. */
  private async _maybeVeto(
    reason: ShutdownReason,
    aggregate: RunningSessionsShutdownInfo | undefined,
    skipPrompt = false,
    skipSessionIds: readonly string[] = [],
    promptAckId?: number,
  ): Promise<boolean> {
    if (skipPrompt) return false
    // Closing kills the agent process — and with it any still-running
    // `run_in_background` task (e.g. a robocopy mirror), so a session whose
    // turn settled but whose background work is in flight counts as busy too.
    // The CLI quit names the session that requested the refresh: it is being
    // intentionally interrupted, so exempt it from both the local and the
    // coordinator's count. Everything else still prompts.
    const skip = new Set(skipSessionIds)
    const localRunningCount = this._sessions.sessions.get().filter((s) => {
      if (skip.size > 0) {
        const durableId = s.sessionIdOnAgent?.get()
        if (skip.has(s.id) || (durableId !== undefined && skip.has(durableId))) return false
      }
      return s.status.get() === 'running' || s.backgroundTaskCount.get() > 0
    }).length
    // The coordinator's snapshot can undercount its own window when listSessions
    // times out; trust whichever count is higher for the prompt's host window.
    const promptWindowCount = Math.max(aggregate?.promptWindowCount ?? 0, localRunningCount)
    const otherWindows = aggregate?.otherWindows ?? []
    const otherCount = otherWindows.reduce((n, w) => n + w.count, 0)
    if (promptWindowCount + otherCount === 0) return false

    // E2E runs headless: a modal confirm has no one to answer it and would hang
    // app.close() until SIGKILL, which orphans child processes (node-pty / ACP
    // agents / extension host) on Windows and blows the worker teardown budget.
    // Proceed without prompting so graceful quit + will-quit dispose can run.
    // Mirrors ReloadWindowAction's isE2E modal skip in windowActions.ts.
    const isE2E = typeof window !== 'undefined' && window[E2E_PROBE_ENABLED_KEY] === true
    if (isE2E) return false

    if (promptAckId !== undefined) {
      // Tell main the modal is about to be on screen so it waits for the user's
      // decision instead of its renderer-unresponsive timeout.
      void this._windows.reportShutdownPromptShown(promptAckId).catch(() => undefined)
    }

    const action = actionLabel(reason)
    const { confirmed } = await this._dialog.confirm({
      type: 'warning',
      message: runningSessionsMessage(promptWindowCount, otherWindows, otherCount, action),
      detail: runningSessionsDetail(otherWindows),
      primaryButton: actionButtonLabel(reason),
      cancelButton: localize('common.cancel', 'Cancel'),
    })
    return !confirmed
  }
}

function runningSessionsMessage(
  promptWindowCount: number,
  otherWindows: readonly RunningSessionsByWindow[],
  otherCount: number,
  action: string,
): string {
  if (otherWindows.length === 0) {
    return localize(
      'shutdown.runningSessions.message.thisWindow',
      'This window has {count} running sessions; {action} will interrupt them',
      { count: promptWindowCount, action },
    )
  }
  if (promptWindowCount === 0) {
    return localize(
      'shutdown.runningSessions.message.otherWindows',
      'Other windows have {count} running sessions across {windowCount} windows; {action} will interrupt them',
      { count: otherCount, windowCount: otherWindows.length, action },
    )
  }
  return localize(
    'shutdown.runningSessions.message.both',
    'This window has {ownCount} running sessions; {windowCount} other windows have {otherCount} more. {action} will interrupt them',
    {
      ownCount: promptWindowCount,
      windowCount: otherWindows.length,
      otherCount,
      action,
    },
  )
}

function runningSessionsDetail(otherWindows: readonly RunningSessionsByWindow[]): string {
  if (otherWindows.length === 0) {
    return localize('shutdown.runningSessions.detail', 'Do you want to continue?')
  }
  const list = otherWindows
    .map((w) =>
      localize('shutdown.runningSessions.otherWindowEntry', '{name} ({count} sessions)', {
        name:
          w.workspaceName === ''
            ? localize('shutdown.runningSessions.untitledWindow', 'Untitled window')
            : w.workspaceName,
        count: w.count,
      }),
    )
    .join('\n')
  return localize(
    'shutdown.runningSessions.detail.withOtherWindows',
    'Other windows:\n{list}\n\nDo you want to continue?',
    { list },
  )
}

function actionButtonLabel(reason: ShutdownReason): string {
  switch (reason) {
    case ShutdownReason.Quit:
      return localize('shutdown.runningSessions.confirm.quit', 'Exit')
    case ShutdownReason.CloseWindow:
      return localize('shutdown.runningSessions.confirm.closeWindow', 'Close Window')
    case ShutdownReason.Reload:
      return localize('shutdown.runningSessions.confirm.reload', 'Restart Editor')
    case ShutdownReason.SwitchWorkspace:
      return localize('shutdown.runningSessions.confirm.switchWorkspace', 'Switch Workspace')
  }
}

function actionLabel(reason: ShutdownReason): string {
  switch (reason) {
    case ShutdownReason.Quit:
      return localize('shutdown.action.quit', 'Quitting')
    case ShutdownReason.CloseWindow:
      return localize('shutdown.action.closeWindow', 'Closing the window')
    case ShutdownReason.Reload:
      return localize('shutdown.action.reload', 'Reloading the editor')
    case ShutdownReason.SwitchWorkspace:
      return localize('shutdown.action.switchWorkspace', 'Switching workspace')
  }
}
