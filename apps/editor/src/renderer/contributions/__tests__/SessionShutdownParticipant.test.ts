/*---------------------------------------------------------------------------------------------
 *  Tests for SessionShutdownParticipant
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  IDialogService,
  ILifecycleService,
  LifecycleService,
  ShutdownReason,
  observableValue,
} from '@universe-editor/platform'
import { SessionShutdownParticipant } from '../SessionShutdownParticipant.js'
import { IAcpSessionService } from '../../services/acp/session/acpSessionService.js'
import type { AcpSessionStatus, IAcpSession } from '../../services/acp/session/acpSession.js'

function sessionWithStatus(status: AcpSessionStatus, backgroundTasks = 0): IAcpSession {
  return {
    status: observableValue('status', status),
    backgroundTaskCount: observableValue('backgroundTaskCount', backgroundTasks),
  } as unknown as IAcpSession
}

function makeSessionService(sessions: IAcpSession[]): IAcpSessionService {
  return {
    sessions: observableValue<readonly IAcpSession[]>('sessions', sessions),
  } as unknown as IAcpSessionService
}

function makeDialog(confirmed: boolean): IDialogService & { confirm: ReturnType<typeof vi.fn> } {
  return {
    confirm: vi.fn().mockResolvedValue({ confirmed }),
  } as unknown as IDialogService & { confirm: ReturnType<typeof vi.fn> }
}

describe('SessionShutdownParticipant', () => {
  it('does not veto and does not prompt when no session is running', async () => {
    const lifecycle: ILifecycleService = new LifecycleService()
    const dialog = makeDialog(true)
    new SessionShutdownParticipant(
      lifecycle,
      makeSessionService([sessionWithStatus('idle'), sessionWithStatus('closed')]),
      dialog,
    )

    const vetoed = await lifecycle.confirmBeforeShutdown(ShutdownReason.Quit)
    expect(vetoed).toBe(false)
    expect(dialog.confirm).not.toHaveBeenCalled()
  })

  it('prompts and proceeds when the user confirms', async () => {
    const lifecycle: ILifecycleService = new LifecycleService()
    const dialog = makeDialog(true)
    new SessionShutdownParticipant(
      lifecycle,
      makeSessionService([sessionWithStatus('running')]),
      dialog,
    )

    const vetoed = await lifecycle.confirmBeforeShutdown(ShutdownReason.SwitchWorkspace)
    expect(vetoed).toBe(false)
    expect(dialog.confirm).toHaveBeenCalledTimes(1)
  })

  it('vetoes when the user cancels', async () => {
    const lifecycle: ILifecycleService = new LifecycleService()
    const dialog = makeDialog(false)
    new SessionShutdownParticipant(
      lifecycle,
      makeSessionService([sessionWithStatus('running'), sessionWithStatus('idle')]),
      dialog,
    )

    const vetoed = await lifecycle.confirmBeforeShutdown(ShutdownReason.CloseWindow)
    expect(vetoed).toBe(true)
    expect(dialog.confirm).toHaveBeenCalledTimes(1)
  })

  it('prompts with the aggregate count when another window owns the running session', async () => {
    const lifecycle: ILifecycleService = new LifecycleService()
    const dialog = makeDialog(true)
    new SessionShutdownParticipant(
      lifecycle,
      makeSessionService([sessionWithStatus('idle')]),
      dialog,
    )

    const vetoed = await lifecycle.confirmBeforeShutdown(ShutdownReason.Quit, {
      runningSessionCount: 2,
    })

    expect(vetoed).toBe(false)
    expect(dialog.confirm).toHaveBeenCalledTimes(1)
    expect(dialog.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('2') }),
    )
  })

  it('does not repeat the running-session prompt in non-requesting windows', async () => {
    const lifecycle: ILifecycleService = new LifecycleService()
    const dialog = makeDialog(true)
    new SessionShutdownParticipant(
      lifecycle,
      makeSessionService([sessionWithStatus('running')]),
      dialog,
    )

    const vetoed = await lifecycle.confirmBeforeShutdown(ShutdownReason.Quit, {
      skipRunningSessionPrompt: true,
    })

    expect(vetoed).toBe(false)
    expect(dialog.confirm).not.toHaveBeenCalled()
  })

  it('prompts for a session whose turn settled but background tasks are still in flight', async () => {
    // Closing kills the agent process, and with it any `run_in_background`
    // work (e.g. a robocopy mirror) — an idle-status session with
    // backgroundTaskCount > 0 must still gate the shutdown.
    const lifecycle: ILifecycleService = new LifecycleService()
    const dialog = makeDialog(false)
    new SessionShutdownParticipant(
      lifecycle,
      makeSessionService([sessionWithStatus('idle', 1), sessionWithStatus('closed')]),
      dialog,
    )

    const vetoed = await lifecycle.confirmBeforeShutdown(ShutdownReason.CloseWindow)
    expect(vetoed).toBe(true)
    expect(dialog.confirm).toHaveBeenCalledTimes(1)
    expect(dialog.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('1') }),
    )
  })
})
