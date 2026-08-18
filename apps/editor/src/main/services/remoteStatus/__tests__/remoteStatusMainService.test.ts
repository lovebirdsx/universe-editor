/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/remoteStatus/remoteStatusMainService.ts
 *  (stopServer window-close orchestration).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { Emitter } from '@universe-editor/platform'
import { RemoteStatusMainService } from '../remoteStatusMainService.js'

function makeService() {
  const stopServer = vi.fn().mockResolvedValue(undefined)
  const closeConnection = vi.fn().mockResolvedValue(undefined)
  const remote = {
    onDidChangeState: new Emitter<never>().event,
    stopServer,
    closeConnection,
  }
  const environment = { isE2E: false }
  const svc = new RemoteStatusMainService(remote as never, environment as never)
  return { svc, stopServer, closeConnection }
}

describe('RemoteStatusMainService — stopServer', () => {
  it('stops the server directly when no windows participant is wired', async () => {
    const { svc, stopServer } = makeService()
    await expect(svc.stopServer('myhost')).resolves.toBe(true)
    expect(stopServer).toHaveBeenCalledWith('myhost')
  })

  it('closes the related windows first, then stops the server', async () => {
    const { svc, stopServer } = makeService()
    const closeWindowsForRemoteAuthority = vi.fn().mockResolvedValue(true)
    svc.setWindowsParticipant({ closeWindowsForRemoteAuthority })

    await expect(svc.stopServer('myhost')).resolves.toBe(true)

    expect(closeWindowsForRemoteAuthority).toHaveBeenCalledWith('myhost')
    expect(closeWindowsForRemoteAuthority.mock.invocationCallOrder[0]).toBeLessThan(
      stopServer.mock.invocationCallOrder[0]!,
    )
  })

  it('keeps the server running when the window close is vetoed', async () => {
    const { svc, stopServer } = makeService()
    svc.setWindowsParticipant({
      closeWindowsForRemoteAuthority: vi.fn().mockResolvedValue(false),
    })

    await expect(svc.stopServer('myhost')).resolves.toBe(false)

    expect(stopServer).not.toHaveBeenCalled()
  })
})

describe('RemoteStatusMainService — closeRemoteWorkspace', () => {
  it('disconnects directly when no windows participant is wired', async () => {
    const { svc, closeConnection } = makeService()
    await expect(svc.closeRemoteWorkspace('myhost')).resolves.toBe(true)
    expect(closeConnection).toHaveBeenCalledWith('myhost')
  })

  it('closes the related windows first, then disconnects the connection', async () => {
    const { svc, closeConnection } = makeService()
    const closeWindowsForRemoteAuthority = vi.fn().mockResolvedValue(true)
    svc.setWindowsParticipant({ closeWindowsForRemoteAuthority })

    await expect(svc.closeRemoteWorkspace('myhost')).resolves.toBe(true)

    expect(closeWindowsForRemoteAuthority).toHaveBeenCalledWith('myhost')
    expect(closeWindowsForRemoteAuthority.mock.invocationCallOrder[0]).toBeLessThan(
      closeConnection.mock.invocationCallOrder[0]!,
    )
  })

  it('keeps the connection up when the window close is vetoed', async () => {
    const { svc, closeConnection } = makeService()
    svc.setWindowsParticipant({
      closeWindowsForRemoteAuthority: vi.fn().mockResolvedValue(false),
    })

    await expect(svc.closeRemoteWorkspace('myhost')).resolves.toBe(false)

    expect(closeConnection).not.toHaveBeenCalled()
  })
})
