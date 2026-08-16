/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  ShutdownReason,
  type ILifecycleService,
  type IWindowsService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { activateForeignSession } from '../activateForeignSession.js'

function makeDeps() {
  const openWindow = vi.fn()
  const confirmBeforeShutdown = vi.fn().mockResolvedValue(false)
  const openFolder = vi.fn()
  const windows = { openWindow } as unknown as IWindowsService
  const lifecycle = { confirmBeforeShutdown } as unknown as ILifecycleService
  const workspace = { openFolder } as unknown as IWorkspaceService
  return { windows, lifecycle, workspace, openWindow, confirmBeforeShutdown, openFolder }
}

describe('activateForeignSession', () => {
  it('opens a remote-ssh URI in a new window when authority is present', async () => {
    const deps = makeDeps()
    await activateForeignSession(deps, '/home/user/proj', {
      newWindow: true,
      sessionId: 'sid',
      authority: 'host',
    })

    expect(deps.openWindow).toHaveBeenCalledTimes(1)
    const folder = deps.openWindow.mock.calls[0]![0] as {
      scheme: string
      authority: string
      path: string
    }
    expect(folder.scheme).toBe('remote-ssh')
    expect(folder.authority).toBe('host')
    expect(folder.path).toBe('/home/user/proj')
    expect(deps.openWindow.mock.calls[0]![1]).toEqual({ sessionId: 'sid' })
  })

  it('opens a remote-ssh URI in the same window when authority is present', async () => {
    const deps = makeDeps()
    await activateForeignSession(deps, '/home/user/proj', {
      newWindow: false,
      authority: 'host',
    })

    expect(deps.openFolder).toHaveBeenCalledTimes(1)
    const folder = deps.openFolder.mock.calls[0]![0] as {
      scheme: string
      authority: string
      path: string
    }
    expect(folder.scheme).toBe('remote-ssh')
    expect(folder.authority).toBe('host')
    expect(folder.path).toBe('/home/user/proj')
  })

  it('falls back to a file URI when authority is absent', async () => {
    const deps = makeDeps()
    await activateForeignSession(deps, '/home/user/proj', { newWindow: true })

    expect(deps.openWindow).toHaveBeenCalledTimes(1)
    const folder = deps.openWindow.mock.calls[0]![0] as {
      scheme: string
      authority: string
      path: string
    }
    expect(folder.scheme).toBe('file')
    expect(folder.path).toBe('/home/user/proj')
  })

  it('returns false when the same-window shutdown is vetoed', async () => {
    const deps = makeDeps()
    deps.confirmBeforeShutdown.mockResolvedValue(true)

    const result = await activateForeignSession(deps, '/home/user/proj', { newWindow: false })

    expect(result).toBe(false)
    expect(deps.openFolder).not.toHaveBeenCalled()
    expect(deps.confirmBeforeShutdown).toHaveBeenCalledWith(ShutdownReason.SwitchWorkspace)
  })
})
