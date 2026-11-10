/*---------------------------------------------------------------------------------------------
 *  Tests for SessionShutdownParticipant
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  IDialogService,
  ILifecycleService,
  IWindowsService,
  LifecycleService,
  ShutdownReason,
  observableValue,
} from '@universe-editor/platform'
import { SessionShutdownParticipant } from '../SessionShutdownParticipant.js'
import { IAcpSessionService } from '../../services/acp/session/acpSessionService.js'
import type { AcpSessionStatus, IAcpSession } from '../../services/acp/session/acpSession.js'
import { E2E_PROBE_ENABLED_KEY } from '../../../shared/e2e/contract.js'

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

function makeWindows(): IWindowsService & { reportShutdownPromptShown: ReturnType<typeof vi.fn> } {
  return {
    reportShutdownPromptShown: vi.fn().mockResolvedValue(undefined),
  } as unknown as IWindowsService & { reportShutdownPromptShown: ReturnType<typeof vi.fn> }
}

function makeParticipant(
  lifecycle: ILifecycleService,
  sessions: IAcpSession[],
  dialog: IDialogService,
  windows: IWindowsService = makeWindows(),
): SessionShutdownParticipant {
  return new SessionShutdownParticipant(lifecycle, makeSessionService(sessions), dialog, windows)
}

describe('SessionShutdownParticipant', () => {
  it('does not veto and does not prompt when no session is running', async () => {
    const lifecycle: ILifecycleService = new LifecycleService()
    const dialog = makeDialog(true)
    const windows = makeWindows()
    makeParticipant(
      lifecycle,
      [sessionWithStatus('idle'), sessionWithStatus('closed')],
      dialog,
      windows,
    )

    const vetoed = await lifecycle.confirmBeforeShutdown(ShutdownReason.Quit)
    expect(vetoed).toBe(false)
    expect(dialog.confirm).not.toHaveBeenCalled()
    expect(windows.reportShutdownPromptShown).not.toHaveBeenCalled()
  })

  it('prompts and proceeds when the user confirms', async () => {
    const lifecycle: ILifecycleService = new LifecycleService()
    const dialog = makeDialog(true)
    makeParticipant(lifecycle, [sessionWithStatus('running')], dialog)

    const vetoed = await lifecycle.confirmBeforeShutdown(ShutdownReason.SwitchWorkspace)
    expect(vetoed).toBe(false)
    expect(dialog.confirm).toHaveBeenCalledTimes(1)
  })

  it('vetoes when the user cancels', async () => {
    const lifecycle: ILifecycleService = new LifecycleService()
    const dialog = makeDialog(false)
    makeParticipant(
      lifecycle,
      [sessionWithStatus('running'), sessionWithStatus('idle')],
      dialog,
    )

    const vetoed = await lifecycle.confirmBeforeShutdown(ShutdownReason.CloseWindow)
    expect(vetoed).toBe(true)
    expect(dialog.confirm).toHaveBeenCalledTimes(1)
  })

  it('describes sessions in other windows and acknowledges the prompt', async () => {
    const lifecycle: ILifecycleService = new LifecycleService()
    const dialog = makeDialog(true)
    const windows = makeWindows()
    makeParticipant(lifecycle, [sessionWithStatus('idle')], dialog, windows)

    const vetoed = await lifecycle.confirmBeforeShutdown(ShutdownReason.Quit, {
      runningSessions: {
        promptWindowCount: 0,
        otherWindows: [{ workspaceName: 'other', count: 2 }],
      },
      promptAckId: 11,
    })

    expect(vetoed).toBe(false)
    expect(dialog.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Other windows have 2'),
        detail: expect.stringContaining('other (2 sessions)'),
        primaryButton: 'Exit',
      }),
    )
    expect(windows.reportShutdownPromptShown).toHaveBeenCalledWith(11)
  })

  it('describes own and other-window sessions separately', async () => {
    const lifecycle: ILifecycleService = new LifecycleService()
    const dialog = makeDialog(true)
    makeParticipant(lifecycle, [sessionWithStatus('running')], dialog)

    await lifecycle.confirmBeforeShutdown(ShutdownReason.Quit, {
      runningSessions: {
        promptWindowCount: 1,
        otherWindows: [{ workspaceName: 'other', count: 2 }],
      },
      promptAckId: 12,
    })

    expect(dialog.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('This window has 1'),
        detail: expect.stringContaining('other (2 sessions)'),
      }),
    )
    expect(dialog.confirm.mock.calls[0]?.[0].message).toContain('2 more')
  })

  it('falls back to the local count when the coordinator snapshot undercounts', async () => {
    const lifecycle: ILifecycleService = new LifecycleService()
    const dialog = makeDialog(true)
    makeParticipant(lifecycle, [sessionWithStatus('running')], dialog)

    await lifecycle.confirmBeforeShutdown(ShutdownReason.Quit, {
      runningSessions: { promptWindowCount: 0, otherWindows: [] },
      promptAckId: 13,
    })

    expect(dialog.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('This window has 1') }),
    )
  })

  it('does not repeat the running-session prompt in non-requesting windows', async () => {
    const lifecycle: ILifecycleService = new LifecycleService()
    const dialog = makeDialog(true)
    const windows = makeWindows()
    makeParticipant(lifecycle, [sessionWithStatus('running')], dialog, windows)

    const vetoed = await lifecycle.confirmBeforeShutdown(ShutdownReason.Quit, {
      skipRunningSessionPrompt: true,
      promptAckId: 14,
    })

    expect(vetoed).toBe(false)
    expect(dialog.confirm).not.toHaveBeenCalled()
    expect(windows.reportShutdownPromptShown).not.toHaveBeenCalled()
  })

  it('prompts for a session whose turn settled but background tasks are still in flight', async () => {
    // Closing kills the agent process, and with it any `run_in_background`
    // work (e.g. a robocopy mirror) — an idle-status session with
    // backgroundTaskCount > 0 must still gate the shutdown.
    const lifecycle: ILifecycleService = new LifecycleService()
    const dialog = makeDialog(false)
    makeParticipant(
      lifecycle,
      [sessionWithStatus('idle', 1), sessionWithStatus('closed')],
      dialog,
    )

    const vetoed = await lifecycle.confirmBeforeShutdown(ShutdownReason.CloseWindow)
    expect(vetoed).toBe(true)
    expect(dialog.confirm).toHaveBeenCalledTimes(1)
    expect(dialog.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('1') }),
    )
  })

  it('labels the primary button with the action being confirmed', async () => {
    const lifecycle: ILifecycleService = new LifecycleService()
    const dialog = makeDialog(true)
    makeParticipant(lifecycle, [sessionWithStatus('running')], dialog)

    await lifecycle.confirmBeforeShutdown(ShutdownReason.CloseWindow)

    expect(dialog.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ primaryButton: 'Close Window' }),
    )
  })

  it('skip only suppresses the session prompt, other vetoes still run', async () => {
    const lifecycle: ILifecycleService = new LifecycleService()
    let otherVetoRan = false
    lifecycle.onBeforeShutdown((e) => {
      otherVetoRan = true
      e.veto(true, 'other')
    })
    makeParticipant(lifecycle, [sessionWithStatus('running')], makeDialog(true))

    const vetoed = await lifecycle.confirmBeforeShutdown(ShutdownReason.Quit, {
      skipRunningSessionPrompt: true,
    })

    expect(vetoed).toBe(true)
    expect(otherVetoRan).toBe(true)
  })

  it('skip still lets onWillShutdown participants join', async () => {
    const lifecycle: ILifecycleService = new LifecycleService()
    let joined = false
    lifecycle.onWillShutdown((e) => {
      e.join(
        Promise.resolve().then(() => {
          joined = true
        }),
        'stop-agents',
      )
    })
    makeParticipant(lifecycle, [sessionWithStatus('running')], makeDialog(true))

    await lifecycle.shutdown(ShutdownReason.Quit, { skipRunningSessionPrompt: true })

    expect(joined).toBe(true)
  })

  it('does not prompt or acknowledge in E2E', async () => {
    const globalWithWindow = globalThis as unknown as { window?: Record<string, unknown> }
    const previousWindow = globalWithWindow.window
    globalWithWindow.window = { [E2E_PROBE_ENABLED_KEY]: true }
    try {
      const lifecycle: ILifecycleService = new LifecycleService()
      const dialog = makeDialog(true)
      const windows = makeWindows()
      makeParticipant(lifecycle, [sessionWithStatus('running')], dialog, windows)

      const vetoed = await lifecycle.confirmBeforeShutdown(ShutdownReason.Quit, {
        runningSessions: { promptWindowCount: 1, otherWindows: [] },
        promptAckId: 15,
      })

      expect(vetoed).toBe(false)
      expect(dialog.confirm).not.toHaveBeenCalled()
      expect(windows.reportShutdownPromptShown).not.toHaveBeenCalled()
    } finally {
      if (previousWindow === undefined) delete globalWithWindow.window
      else globalWithWindow.window = previousWindow
    }
  })
})
