/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/update/updateMainService.ts
 *  Focus: quitAndInstall must run the running-session veto gate BEFORE spawning
 *  the installer, so a cancelled confirm does not still install the update.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const quitAndInstallSpy = vi.fn()

/** Minimal shape of electron-updater's `UpdateCheckResult`, narrowed to the two
 * fields `_recheckLatest` actually reads. */
type FakeCheckResult = { isUpdateAvailable: boolean; updateInfo: { version: string } } | null

class FakeAutoUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = false
  forceDevUpdateConfig = false
  logger: unknown
  checkResult: FakeCheckResult = null
  checkForUpdates = vi.fn(async () => this.checkResult)
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

const { UpdateMainService, createWindowScopedUpdateService } =
  await import('../updateMainService.js')

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

function markAvailable(service: InstanceType<typeof UpdateMainService>): void {
  fakeAutoUpdater.emit('update-available', { version: '99.0.0' })
  // Sanity: the wired event handler put us in 'available'.
  expect((service as unknown as { _state: { type: string } })._state.type).toBe('available')
}

describe('UpdateMainService.quitAndInstall', () => {
  let service: InstanceType<typeof UpdateMainService>

  beforeEach(() => {
    quitAndInstallSpy.mockClear()
    fakeAutoUpdater.checkForUpdates.mockClear()
    fakeAutoUpdater.downloadUpdate.mockClear()
    fakeAutoUpdater.checkResult = null
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

    await createWindowScopedUpdateService(service, 42).quitAndInstall()

    expect(confirm).toHaveBeenCalledWith(42)
    expect(quitAndInstallSpy).toHaveBeenCalledWith(false, true)
  })

  it('does NOT install when the quit confirmer vetoes (user cancelled)', async () => {
    markDownloaded(service)
    const confirm = vi.fn(async () => false)
    service.setQuitConfirmer(confirm)

    await createWindowScopedUpdateService(service, 42).quitAndInstall()

    expect(confirm).toHaveBeenCalledWith(42)
    expect(quitAndInstallSpy).not.toHaveBeenCalled()
  })

  it('installs when no confirmer is wired (guard absent → proceed)', async () => {
    markDownloaded(service)

    await service.quitAndInstall()

    expect(quitAndInstallSpy).toHaveBeenCalledWith(false, true)
  })

  it('re-downloads when the server has a newer version than the downloaded build', async () => {
    markDownloaded(service)
    fakeAutoUpdater.checkResult = { isUpdateAvailable: true, updateInfo: { version: '99.0.1' } }

    await service.quitAndInstall()

    expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(quitAndInstallSpy).not.toHaveBeenCalled()
  })

  it('installs the downloaded build when the recheck fails (null)', async () => {
    markDownloaded(service)
    fakeAutoUpdater.checkResult = null

    await service.quitAndInstall()

    expect(fakeAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(quitAndInstallSpy).toHaveBeenCalledWith(false, true)
  })

  it('installs the downloaded build when the recheck finds no update', async () => {
    markDownloaded(service)
    fakeAutoUpdater.checkResult = { isUpdateAvailable: false, updateInfo: { version: '1.2.3' } }

    await service.quitAndInstall()

    expect(fakeAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(quitAndInstallSpy).toHaveBeenCalledWith(false, true)
  })

  it('installs the downloaded build when the recheck throws', async () => {
    markDownloaded(service)
    fakeAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('boom'))

    await service.quitAndInstall()

    expect(fakeAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(quitAndInstallSpy).toHaveBeenCalledWith(false, true)
    // finally must reset the recheck guard so later events are not suppressed.
    expect((service as unknown as { _rechecking: boolean })._rechecking).toBe(false)
  })
})

describe('UpdateMainService.downloadUpdate', () => {
  let service: InstanceType<typeof UpdateMainService>

  beforeEach(() => {
    quitAndInstallSpy.mockClear()
    fakeAutoUpdater.checkForUpdates.mockClear()
    fakeAutoUpdater.downloadUpdate.mockClear()
    fakeAutoUpdater.checkResult = null
    fakeAutoUpdater.removeAllListeners()
    service = new UpdateMainService(environment, configLocation)
  })

  afterEach(() => {
    service.dispose()
  })

  it('re-downloads the newest version when the recheck finds a newer one', async () => {
    markAvailable(service)
    fakeAutoUpdater.checkResult = { isUpdateAvailable: true, updateInfo: { version: '99.0.1' } }

    await service.downloadUpdate()

    expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    const state = (service as unknown as { _state: { type: string; version: string } })._state
    expect(state.type).toBe('downloading')
    expect(state.version).toBe('99.0.1')
  })

  it('downloads the already-known version when the recheck fails (null)', async () => {
    markAvailable(service)
    fakeAutoUpdater.checkResult = null

    await service.downloadUpdate()

    expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    const state = (service as unknown as { _state: { type: string; version: string } })._state
    expect(state.type).toBe('downloading')
    expect(state.version).toBe('99.0.0')
  })

  it('downloads the already-known version when the recheck throws', async () => {
    markAvailable(service)
    fakeAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('boom'))

    await service.downloadUpdate()

    expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    const state = (service as unknown as { _state: { type: string; version: string } })._state
    expect(state.type).toBe('downloading')
    expect(state.version).toBe('99.0.0')
    expect((service as unknown as { _rechecking: boolean })._rechecking).toBe(false)
  })
})
