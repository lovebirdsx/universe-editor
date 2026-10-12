/*---------------------------------------------------------------------------------------------
 *  Smoke spec: auto-update end-to-end (P1, Windows-only).
 *
 *  Stands up a local static server and writes a `dev-app-update.yml` next to the
 *  app entry (where electron-updater looks when unpackaged), pointing the feed at
 *  that server. The server returns a `latest.yml` advertising a far-future
 *  version. Because the E2E build runs unpackaged (app.isPackaged === false),
 *  UpdateMainService sets forceDevUpdateConfig, so electron-updater really fetches
 *  the feed. This drives the full publish → check → "available" path against a
 *  stubbed release source — no real download (sha512 isn't verified until
 *  download) and no restart.
 *
 *  The fixture pins `update.mode=manual`, which is exactly what the important-update
 *  policy keys off: manual must prompt, default must download unattended. Those two
 *  cases are the two tests below.
 *
 *  Windows-only: auto-update is shipped for Windows, and electron-updater selects
 *  a platform updater (NsisUpdater on win, AppImageUpdater on linux) — the latter
 *  is not meaningful for an unpackaged run, so we skip elsewhere.
 *--------------------------------------------------------------------------------------------*/

import { createServer, type Server } from 'node:http'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { test, expect, MAIN_ENTRY } from '../fixtures/electronApp.js'

// Opt out of fullyParallel: both tests share the beforeAll-owned feed server on
// a fixed port and the dev-app-update.yml written next to the app entry —
// splitting them across workers would run beforeAll twice (EADDRINUSE + file
// races on the shared out/ dir).
test.describe.configure({ mode: 'default' })

const FEED_PORT = 8788
const FUTURE_VERSION = '99.0.0'
const ASSET = `Universe Editor-${FUTURE_VERSION}-win-x64.exe`

// electron-updater (unpackaged) reads dev-app-update.yml from app.getAppPath(),
// which is the directory of the main entry.
const DEV_UPDATE_CONFIG = join(dirname(MAIN_ENTRY), 'dev-app-update.yml')
const DEV_UPDATE_YML = `provider: generic
url: http://127.0.0.1:${FEED_PORT}/
channel: latest
`

// Minimal generic-provider manifest. sha512/size are placeholders — they are only
// validated on download, which this spec deliberately does not trigger.
const LATEST_YML = `version: ${FUTURE_VERSION}
files:
  - url: ${ASSET}
    sha512: ${'A'.repeat(88)}
    size: 1024
path: ${ASSET}
sha512: ${'A'.repeat(88)}
releaseDate: '2099-01-01T00:00:00.000Z'
`

// The metadata-only index the app reads to learn a release's urgency. Only
// `versions[].urgency` matters here; the rest is what the download page expects.
const NOTES_INDEX = JSON.stringify({
  schema: 1,
  versions: [
    { version: FUTURE_VERSION, date: '', title: '', summary: '', urgency: 'important', path: '' },
  ],
})

/**
 * Set `update.mode` for the *next* check by editing the file main reads. The probe's
 * `updateUserConfigValue` only awaits hydration, not the flush to disk, and main reads
 * settings.json fresh at the moment it decides — writing the file directly is both
 * race-free and exactly the input that decision consumes.
 */
async function writeUpdateMode(app: ElectronApplication, mode: string): Promise<void> {
  const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  const file = join(userDataDir, 'settings.json')
  const settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  settings['update.mode'] = mode
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

test.describe('@p1 auto-update', () => {
  test.skip(process.platform !== 'win32', 'auto-update is Windows-only')

  let server: Server

  test.beforeAll(async () => {
    writeFileSync(DEV_UPDATE_CONFIG, DEV_UPDATE_YML, 'utf8')
    server = createServer((req, res) => {
      // electron-updater appends a ?noCache=… query, so match on the path prefix.
      if (req.url?.startsWith('/latest.yml')) {
        res.writeHead(200, { 'content-type': 'text/yaml' })
        res.end(LATEST_YML)
        return
      }
      if (req.url?.startsWith('/notes/index.json')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(NOTES_INDEX)
        return
      }
      if (req.url?.endsWith('.blockmap')) {
        // 404 so electron-updater skips the differential path and falls back to a full
        // download — which is the request the branch below holds open.
        res.writeHead(404)
        res.end()
        return
      }
      if (req.url?.endsWith('.exe')) {
        // Hold the installer response open. The download must stay in flight so the
        // state parks at `downloading` and never reaches `update-downloaded` — that
        // would register electron-updater's quit-install handler and let CI run the
        // placeholder installer.
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': '1024',
        })
        res.write(Buffer.alloc(256))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(FEED_PORT, '127.0.0.1', resolve))
  })

  test.afterAll(async () => {
    rmSync(DEV_UPDATE_CONFIG, { force: true })
    // The installer request never completes; drop the sockets before waiting for close.
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test('check against the feed transitions to "available" and surfaces the version', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()

    await workbench.runCommand('workbench.action.checkForUpdates')

    await expect
      .poll(async () => (await workbench.getUpdateState()).status, { timeout: 15_000 })
      .toBe('available')

    const state = await workbench.getUpdateState()
    expect(state.version).toBe(FUTURE_VERSION)
    // The urgency comes from <feed>/notes/index.json, not from anything packaged.
    expect(state.urgency).toBe('important')

    // UI link: the icon-only title-bar update indicator becomes visible, with a
    // tooltip carrying the available version.
    const indicator = workbench.page.getByTestId('titlebar-update-indicator')
    await expect(indicator).toBeVisible()
    await expect(indicator).toHaveAttribute('data-tooltip', new RegExp(FUTURE_VERSION))
    await expect(indicator).toHaveAttribute('data-tooltip', /important/i)

    // manual mode: an important update still waits for the user, so it must NOT
    // slide into a download on its own.
    await workbench.page.waitForTimeout(1_500)
    expect((await workbench.getUpdateState()).status).toBe('available')
  })

  test('an important update downloads unattended under update.mode=default', async ({
    electronApp,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await writeUpdateMode(electronApp, 'default')

    await workbench.runCommand('workbench.action.checkForUpdates')

    await expect
      .poll(async () => (await workbench.getUpdateState()).status, { timeout: 20_000 })
      .toBe('downloading')

    const state = await workbench.getUpdateState()
    expect(state.version).toBe(FUTURE_VERSION)
    // Urgency survives into `downloading` — that is what makes the UI shout.
    expect(state.urgency).toBe('important')
  })

  test('reports the running version, distinct from the feed version', async ({ workbench }) => {
    await workbench.waitForRestored()

    // Unpackaged runs report the Electron runtime version (no app package.json on
    // app.getAppPath()); packaged builds report the real app version. Either way
    // it must be a valid semver and never the feed's advertised version.
    const state = await workbench.getUpdateState()
    expect(state.currentVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(state.currentVersion).not.toBe(FUTURE_VERSION)
  })
})
