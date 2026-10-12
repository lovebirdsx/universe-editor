/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/update/updateMainService.ts
 *  Focus: quitAndInstall must run the running-session veto gate BEFORE spawning
 *  the installer, so a cancelled confirm does not still install the update.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const quitAndInstallSpy = vi.fn()

/** Where the service looks for dev-app-update.yml (unpackaged) — per-test temp dir. */
let appPath = '/nonexistent-app-dir'
/** Where the service looks for settings.json — per-test temp dir. */
let configDir = '/nonexistent-config-dir'

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
  app: { getVersion: () => '1.2.3', isPackaged: false, getAppPath: () => appPath },
}))

vi.mock('electron-updater', () => ({
  default: { autoUpdater: fakeAutoUpdater },
}))

const { UpdateMainService, createWindowScopedUpdateService } =
  await import('../updateMainService.js')

const environment = { updateUrl: undefined }
// Minimal ConfigLocationMainService stand-in: reads `configDir`, never fires changes.
const configLocation = {
  get currentDir() {
    return configDir
  },
  onDidChangeConfigDir: () => ({ dispose() {} }),
} as never

/** The private state machine, for assertions. */
function stateOf(service: InstanceType<typeof UpdateMainService>): {
  type: string
  version?: string
  urgency?: string
  autoDownload?: boolean
  explicit?: boolean
  percent?: number
  error?: string
} {
  return (service as unknown as { _state: { type: string } })._state
}

function markDownloaded(service: InstanceType<typeof UpdateMainService>): void {
  fakeAutoUpdater.emit('update-downloaded', { version: '99.0.0' })
  // Sanity: the wired event handler put us in 'downloaded'.
  expect(stateOf(service).type).toBe('downloaded')
}

/** `update-available` now resolves the urgency before publishing, so it lands async. */
async function markAvailable(
  service: InstanceType<typeof UpdateMainService>,
  version = '99.0.0',
): Promise<void> {
  fakeAutoUpdater.emit('update-available', { version })
  await vi.waitFor(() => expect(stateOf(service).type).toBe('available'))
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
    await markAvailable(service)
    fakeAutoUpdater.checkResult = { isUpdateAvailable: true, updateInfo: { version: '99.0.1' } }

    await service.downloadUpdate()

    expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    const state = stateOf(service)
    expect(state.type).toBe('downloading')
    expect(state.version).toBe('99.0.1')
  })

  it('downloads the already-known version when the recheck fails (null)', async () => {
    await markAvailable(service)
    fakeAutoUpdater.checkResult = null

    await service.downloadUpdate()

    expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    const state = stateOf(service)
    expect(state.type).toBe('downloading')
    expect(state.version).toBe('99.0.0')
  })

  it('downloads the already-known version when the recheck throws', async () => {
    await markAvailable(service)
    fakeAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('boom'))

    await service.downloadUpdate()

    expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    const state = stateOf(service)
    expect(state.type).toBe('downloading')
    expect(state.version).toBe('99.0.0')
    expect((service as unknown as { _rechecking: boolean })._rechecking).toBe(false)
  })
})

describe('UpdateMainService important updates', () => {
  let service: InstanceType<typeof UpdateMainService>
  let root: string
  /** Answers served for `<feed>/notes/index.json`. */
  let index: unknown

  /** Every state the service published, in order — transient ones included. */
  let seen: Array<{ type: string }>
  const emitted = (type: string): Array<Record<string, unknown>> =>
    seen.filter((s) => s.type === type) as Array<Record<string, unknown>>

  const setMode = (mode: string): void =>
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ 'update.mode': mode }))

  beforeEach(() => {
    quitAndInstallSpy.mockClear()
    fakeAutoUpdater.checkForUpdates.mockClear()
    fakeAutoUpdater.downloadUpdate.mockClear()
    fakeAutoUpdater.downloadUpdate.mockResolvedValue([])
    fakeAutoUpdater.checkResult = null
    fakeAutoUpdater.removeAllListeners()

    root = mkTempDir('ue-update-')
    appPath = root
    configDir = root
    writeFileSync(
      join(root, 'dev-app-update.yml'),
      'provider: generic\nurl: http://feed.test/\nchannel: latest\n',
    )
    setMode('default')
    index = { schema: 1, versions: [{ version: '99.0.0', urgency: 'important' }] }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(index), { status: 200 })),
    )

    service = new UpdateMainService(environment, configLocation)
    seen = []
    service.onDidChangeState((state) => seen.push(state as never))
  })

  afterEach(() => {
    service.dispose()
    vi.unstubAllGlobals()
    removeDirWithRetry(root)
    appPath = '/nonexistent-app-dir'
    configDir = '/nonexistent-config-dir'
  })

  it.each(['default', 'start'])(
    'downloads an important update without a click in %s mode',
    async (mode) => {
      setMode(mode)
      fakeAutoUpdater.emit('update-available', { version: '99.0.0' })
      await vi.waitFor(() => expect(stateOf(service).type).toBe('downloading'))

      expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
      expect(stateOf(service).urgency).toBe('important')
      // The renderer keys "no Download button" off this flag, so it must be published.
      expect(emitted('available')[0]).toMatchObject({
        version: '99.0.0',
        urgency: 'important',
        autoDownload: true,
      })
    },
  )

  it('carries the urgency through progress ticks into the downloaded state', async () => {
    fakeAutoUpdater.emit('update-available', { version: '99.0.0' })
    await vi.waitFor(() => expect(stateOf(service).type).toBe('downloading'))

    fakeAutoUpdater.emit('download-progress', { percent: 42 })
    expect(stateOf(service).percent).toBe(42)
    expect(stateOf(service).urgency).toBe('important')

    fakeAutoUpdater.emit('update-downloaded', { version: '99.0.0' })
    await vi.waitFor(() => expect(stateOf(service).type).toBe('downloaded'))
    // Losing the urgency here would downgrade the restart prompt to a plain one.
    expect(stateOf(service).urgency).toBe('important')
  })

  it.each(['manual', 'none'])('respects %s mode: prompts instead of downloading', async (mode) => {
    setMode(mode)
    await markAvailable(service)

    expect(stateOf(service).urgency).toBe('important')
    expect(stateOf(service).autoDownload).toBeUndefined()
    expect(fakeAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('leaves a normal update to the user', async () => {
    index = { schema: 1, versions: [{ version: '99.0.0', urgency: 'normal' }] }
    await markAvailable(service)

    expect(stateOf(service).urgency).toBe('normal')
    expect(fakeAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('degrades to a normal prompt when the index cannot be fetched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    await markAvailable(service)

    expect(stateOf(service).urgency).toBe('normal')
    expect(fakeAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('degrades to normal when there is no feed config to read the URL from', async () => {
    rmSync(join(root, 'dev-app-update.yml'))
    await markAvailable(service)

    expect(stateOf(service).urgency).toBe('normal')
    expect(fakeAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('returns to the prompt when the silent download fails, without an error prompt', async () => {
    fakeAutoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('disk full'))
    fakeAutoUpdater.emit('update-available', { version: '99.0.0' })
    await vi.waitFor(() => expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(stateOf(service).type).toBe('available'))

    // Back to `available` rather than `idle` — that is what keeps the renderer from
    // raising "check for updates failed" over a download the user never started.
    expect(stateOf(service).urgency).toBe('important')
    expect(emitted('idle')).toHaveLength(0)
  })

  it('surfaces a failed user-initiated download as an error prompt', async () => {
    setMode('manual')
    await markAvailable(service)
    fakeAutoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('disk full'))

    await service.downloadUpdate()

    // `_setState` clears the one-shot idle flags right after broadcasting, so the
    // prompt has to be asserted on what was published, not on the live state.
    expect(emitted('idle').at(-1)).toMatchObject({ error: 'disk full', explicit: true })
  })

  it('re-reads the feed config after a transient read failure', async () => {
    rmSync(join(root, 'dev-app-update.yml'))
    await markAvailable(service)
    expect(stateOf(service).urgency).toBe('normal')

    writeFileSync(
      join(root, 'dev-app-update.yml'),
      'provider: generic\nurl: http://feed.test/\nchannel: latest\n',
    )
    // The state stays `available` across both checks, so wait on the urgency itself.
    fakeAutoUpdater.emit('update-available', { version: '99.0.0' })
    await vi.waitFor(() => expect(stateOf(service).urgency).toBe('important'))
  })

  it('settles once when electron-updater both emits error and rejects', async () => {
    // The real updater does both, so the failure must be idempotent.
    fakeAutoUpdater.downloadUpdate.mockImplementationOnce(async () => {
      fakeAutoUpdater.emit('error', new Error('connection reset'))
      throw new Error('connection reset')
    })
    fakeAutoUpdater.emit('update-available', { version: '99.0.0' })
    await vi.waitFor(() => expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(stateOf(service).type).toBe('available'))

    expect(stateOf(service).urgency).toBe('important')
    expect(emitted('idle')).toHaveLength(0)
  })

  it('never retries the download for the same version in one session', async () => {
    fakeAutoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('nope'))
    fakeAutoUpdater.emit('update-available', { version: '99.0.0' })
    await vi.waitFor(() => expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(stateOf(service).type).toBe('available'))

    fakeAutoUpdater.emit('update-available', { version: '99.0.0' })
    await vi.waitFor(() => expect(emitted('available').length).toBe(2))

    expect(emitted('available').filter((s) => s.autoDownload === true)).toHaveLength(1)
    expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
  })
})
