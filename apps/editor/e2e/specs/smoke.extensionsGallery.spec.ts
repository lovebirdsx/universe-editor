/*---------------------------------------------------------------------------------------------
 *  Smoke spec: the marketplace install path end-to-end, with signing.
 *
 *  A real publish → serve → install loop: beforeAll packs a `.vsix`, signs and
 *  publishes it with `scripts/gallery/publish.mjs` (throwaway Ed25519 key
 *  generated per worker), and serves the stage via `scripts/server/server.mjs`.
 *  The app launches with `UNIVERSE_GALLERY_URL` + `UNIVERSE_GALLERY_SIGNING_KEYS`
 *  pointing at that instance, so `installFromGallery` exercises the full
 *  download → anti-poisoning → signature verification → rescan path.
 *
 *  In-file serial (`mode: 'default'`): the gallery server and its fixed stage
 *  are shared by the tests in this file (core suite is fullyParallel per-test).
 *
 *  Not @p0 — spawns a gallery server child process + the extension host, which
 *  is slower and more environment-sensitive than the core workbench smoke path.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { generateKeyPairSync } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type AddressInfo } from 'node:net'
import AdmZip from 'adm-zip'
import { createColdAppTest, expect } from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY } from '../fixtures/electronApp.js'

const REPO_ROOT = path.resolve(APP_ROOT, '..', '..')
const PUBLISH_SCRIPT = path.join(REPO_ROOT, 'scripts', 'gallery', 'publish.mjs')
const SERVER_SCRIPT = path.join(REPO_ROOT, 'scripts', 'server', 'server.mjs')

const KEY_ID = 'e2e-market'
const KEY_PAIR = generateKeyPairSync('ed25519')
const PUBLIC_X = KEY_PAIR.publicKey.export({ format: 'jwk' }).x as string
const PRIVATE_PEM = KEY_PAIR.privateKey.export({ format: 'pem', type: 'pkcs8' })

const EXT_ID = 'acme.e2e-gallery'
const COMMAND_ID = 'e2eGallery.hello'

// The gallery URL is only known once beforeAll has bound a free port. The env
// object is shared by reference with the fixture, and launchApp reads it at
// launch time — beforeAll runs before any test launches the app, so the
// mutation below is always visible to every launch.
const galleryEnv: Record<string, string> = {
  UNIVERSE_GALLERY_URL: '',
  UNIVERSE_GALLERY_SIGNING_KEYS: JSON.stringify({ [KEY_ID]: PUBLIC_X }),
}

const test = createColdAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: [],
  env: galleryEnv,
})

let stageDir: string
let server: ChildProcess
let galleryUrl: string

/** Build the sample extension VSIX contributing one command. */
async function makeVsix(dir: string): Promise<string> {
  const manifest = {
    name: 'e2e-gallery',
    publisher: 'acme',
    version: '1.0.0',
    displayName: 'E2E Gallery Sample',
    engines: { universe: '*' },
    main: 'dist/extension.js',
    contributes: {
      commands: [{ command: COMMAND_ID, title: 'E2E Gallery: Hello' }],
    },
  }
  const zip = new AdmZip()
  zip.addFile('extension/package.json', Buffer.from(JSON.stringify(manifest)))
  zip.addFile(
    'extension/dist/extension.js',
    Buffer.from('module.exports = { activate() {}, deactivate() {} }'),
  )
  const vsixPath = path.join(dir, 'e2e-gallery.vsix')
  await fs.writeFile(vsixPath, zip.toBuffer())
  return vsixPath
}

function run(
  command: string,
  args: readonly string[],
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('exit', (code) => resolvePromise({ code, stderr }))
  })
}

/** Bind port 0 to let the OS pick a free port, then release it for the server.
 *  Eliminates the fixed-random-range collisions (a leftover server from a
 *  hard-killed previous run silently holds its port for the whole 15s wait). */
function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port
      probe.close(() => resolvePromise(port))
    })
  })
}

/** Poll the gallery endpoint until the server answers (or time out). */
async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(`${url}/extensionquery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filters: [{ criteria: [], pageNumber: 1, pageSize: 10, sortBy: 0, sortOrder: 0 }],
          flags: 0x1,
        }),
      })
      if (res.status === 200) return
    } catch {
      // connection refused — server not up yet
    }
    if (Date.now() > deadline) throw new Error(`gallery server did not start on ${url}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

test.describe('@p1 extensions gallery', () => {
  test.describe.configure({ mode: 'default' })

  test.beforeAll(async () => {
    stageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-gallery-'))
    const vsixPath = await makeVsix(stageDir)
    const keyFile = path.join(stageDir, 'market-key.pem')
    await fs.writeFile(keyFile, PRIVATE_PEM)

    const publish = await run(process.execPath, [
      PUBLISH_SCRIPT,
      '--stage',
      stageDir,
      '--signing-key-file',
      keyFile,
      '--key-id',
      KEY_ID,
      vsixPath,
    ])
    if (publish.code !== 0) throw new Error(`publish.mjs failed: ${publish.stderr}`)

    const port = await getFreePort()
    galleryUrl = `http://127.0.0.1:${port}`
    galleryEnv['UNIVERSE_GALLERY_URL'] = galleryUrl

    let serverStderr = ''
    server = spawn(
      process.execPath,
      [
        SERVER_SCRIPT,
        '--root',
        stageDir,
        '--gallery-root',
        path.join(stageDir, 'gallery'),
        '--port',
        String(port),
        '--base',
        '/',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    server.stderr?.on('data', (d: Buffer) => (serverStderr += d.toString()))
    // Fail fast (with the real error) if the server dies instead of listening —
    // an opaque 15s poll timeout hides EADDRINUSE / script crashes entirely.
    const exited = new Promise<number | null>((resolvePromise) => {
      server.on('exit', (code) => resolvePromise(code))
    })
    const outcome = await Promise.race([
      waitForServer(galleryUrl).then(() => 'ready' as const),
      exited,
    ])
    if (outcome !== 'ready') {
      throw new Error(`gallery server exited before listening (code ${outcome}): ${serverStderr}`)
    }
  })

  test.afterAll(async () => {
    server.kill()
    await fs
      .rm(stageDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      .catch(() => undefined)
  })

  test('installs a signed marketplace extension so its command appears, then uninstalls it', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()

    expect(await workbench.page.evaluate((id) => window.__E2E__!.hasCommand(id), COMMAND_ID)).toBe(
      false,
    )

    const installedId = await workbench.page.evaluate(
      (id) => window.__E2E__!.installGalleryExtension(id),
      EXT_ID,
    )
    expect(installedId).toBe(EXT_ID)

    // Installing re-scans the extension host and re-applies contributions; the
    // command surfaces without a reload.
    await expect
      .poll(() => workbench.page.evaluate((id) => window.__E2E__!.hasCommand(id), COMMAND_ID), {
        timeout: 10000,
      })
      .toBe(true)

    expect(
      await workbench.page.evaluate(() => window.__E2E__!.getInstalledExtensionIds()),
    ).toContain(EXT_ID)

    await workbench.page.evaluate((id) => window.__E2E__!.uninstallExtension(id), EXT_ID)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getInstalledExtensionIds()), {
        timeout: 5000,
      })
      .not.toContain(EXT_ID)
  })

  test('marketplace search lists the published extension', async ({ workbench }) => {
    const { activityBar, page } = workbench
    await workbench.waitForBootstrapFocusSettled()

    await activityBar.click('workbench.view.extensions')
    const searchBox = page.getByLabel('Search Extensions')
    await searchBox.fill('e2e-gallery')
    await expect(
      page.getByTestId('extension-row').filter({ hasText: 'E2E Gallery Sample' }),
    ).toHaveCount(1, { timeout: 10000 })
  })
})
