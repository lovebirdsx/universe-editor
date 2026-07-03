/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/update/updateMainService.ts
 *  Focus: quitAndInstall must run the running-session veto gate BEFORE spawning
 *  the installer, so a cancelled confirm does not still install the update.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const quitAndInstallSpy = vi.fn()

class FakeAutoUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = false
  forceDevUpdateConfig = false
  logger: unknown
  checkForUpdates = vi.fn(async () => undefined)
  downloadUpdate = vi.fn(async () => [])
  setFeedURL = vi.fn()
  quitAndInstall = quitAndInstallSpy
}

const fakeAutoUpdater = new FakeAutoUpdater()

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3', isPackaged: false },
}))

vi.mock('electron-updater', () => ({
  default: { autoUpdater: fakeAutoUpdater },
}))

const { UpdateMainService } = await import('../updateMainService.js')

const environment = { updateUrl: undefined }
// Minimal ConfigLocationMainService stand-in: no config file, never fires changes.
const configLocation = {
  currentDir: '/nonexistent-config-dir',
  onDidChangeConfigDir: () => ({ dispose() {} }),
} as never

function markDownloaded(service: InstanceType<typeof UpdateMainService>): void {
  fakeAutoUpdater.emit('update-downloaded', { version: '99.0.0' })
  // Sanity: the wired event handler put us in 'downloaded'.
  expect((service as unknown as { _state: { type: string } })._state.type).toBe('downloaded')
}

describe('UpdateMainService.quitAndInstall', () => {
  let service: InstanceType<typeof UpdateMainService>

  beforeEach(() => {
    quitAndInstallSpy.mockClear()
    fakeAutoUpdater.removeAllListeners()
    service = new UpdateMainService(environment, configLocation)
  })

  afterEach(() => {
    service.dispose()
  })

  it('does nothing when no update is downloaded', async () => {
    await service.quitAndInstall()
    expect(quitAndInstallSpy).not.toHaveBeenCalled()
  })

  it('installs when the quit confirmer clears (no running sessions)', async () => {
    markDownloaded(service)
    const confirm = vi.fn(async () => true)
    service.setQuitConfirmer(confirm)

    await service.quitAndInstall()

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(quitAndInstallSpy).toHaveBeenCalledWith(true, true)
  })

  it('does NOT install when the quit confirmer vetoes (user cancelled)', async () => {
    markDownloaded(service)
    const confirm = vi.fn(async () => false)
    service.setQuitConfirmer(confirm)

    await service.quitAndInstall()

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(quitAndInstallSpy).not.toHaveBeenCalled()
  })

  it('installs when no confirmer is wired (guard absent → proceed)', async () => {
    markDownloaded(service)

    await service.quitAndInstall()

    expect(quitAndInstallSpy).toHaveBeenCalledWith(true, true)
  })
})
