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
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import type { AcpSessionStatus, IAcpSession } from '../../services/acp/acpSession.js'

function sessionWithStatus(status: AcpSessionStatus): IAcpSession {
  return { status: observableValue('status', status) } as unknown as IAcpSession
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
})
