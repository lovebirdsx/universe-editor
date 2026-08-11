/*---------------------------------------------------------------------------------------------
 *  Crash-loop guard for automatic session restore: when this window's renderer
 *  recently died of OOM (typically during a huge session/load history replay),
 *  pausing the automatic resume breaks the reload → replay → OOM cycle; the user
 *  can still resume manually. Querying the main process is fail-open so a broken
 *  IPC never blocks restore.
 *--------------------------------------------------------------------------------------------*/

import type { IWindowsService } from '@universe-editor/platform'

export const OOM_AUTO_RESUME_PAUSE_WINDOW_MS = 5 * 60 * 1000

export async function shouldPauseAcpAutoResume(
  windowsService: IWindowsService,
  now: number = Date.now(),
): Promise<boolean> {
  let crash: Awaited<ReturnType<IWindowsService['getLastRenderCrash']>>
  try {
    crash = await windowsService.getLastRenderCrash()
  } catch {
    return false
  }
  return (
    crash !== null && crash.reason === 'oom' && now - crash.at < OOM_AUTO_RESUME_PAUSE_WINDOW_MS
  )
}
