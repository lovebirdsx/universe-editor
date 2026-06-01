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
 *  Windows-only: auto-update is shipped for Windows, and electron-updater selects
 *  a platform updater (NsisUpdater on win, AppImageUpdater on linux) — the latter
 *  is not meaningful for an unpackaged run, so we skip elsewhere.
 *--------------------------------------------------------------------------------------------*/

import { createServer, type Server } from 'node:http'
import { writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test, expect, MAIN_ENTRY } from '../fixtures/electronApp.js'

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
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(FEED_PORT, '127.0.0.1', resolve))
  })

  test.afterAll(async () => {
    rmSync(DEV_UPDATE_CONFIG, { force: true })
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

    // UI link: an "available" status-bar entry (sparkle, right-aligned) appears.
    const entries = await workbench.statusBar.entriesFromProbe()
    const updateEntry = entries.find((e) => e.alignment === 'right' && e.icon === 'sparkle')
    expect(updateEntry).toBeDefined()
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
