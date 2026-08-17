/*---------------------------------------------------------------------------------------------
 *  Smoke spec: extension-development mode (--extension-development-path).
 *
 *  A fixture extension directory (package.json + dist/, UNPACKED — the shape an
 *  extension author iterates on) is passed via the real CLI flag. The spec pins:
 *   1) the dev extension's contributed command is registered (loaded + activated
 *      through the CLI path, under the core suite's empty allowlist);
 *   2) the host reports it via the extensionIsUnderDevelopment DTO flag;
 *   3) "Restart Extension Host" re-scans and the command survives the restart;
 *   4) the window title carries the [Extension Development Host] badge.
 *
 *  Not @p0 — the extension host boots a child process, which is slower and more
 *  environment-sensitive than the core workbench smoke path (same bar as
 *  smoke.extensions).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { createColdAppTest } from '@universe-editor/e2e-harness'
import { expect } from '../fixtures/electronApp.js'

const COMMAND_ID = 'e2eDevExt.hello'
const DEV_EXT_ID = 'universe.e2e-dev-ext'

/** Materialize a minimal unpacked extension on disk (the dev-directory shape). */
function makeDevExtensionDir(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ue2-devext-')))
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'e2e-dev-ext',
      publisher: 'universe',
      version: '1.0.0',
      engines: { universe: '*' },
      main: 'dist/extension.js',
      contributes: {
        commands: [{ command: COMMAND_ID, title: 'E2E Dev Ext: Hello' }],
      },
    }),
  )
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'dist', 'extension.js'),
    'module.exports = { activate() {}, deactivate() {} }',
  )
  return dir
}

const devExtDir = makeDevExtensionDir()

export const test = createColdAppTest({
  appRoot: path.resolve(import.meta.dirname, '..', '..'),
  mainEntry: path.resolve(import.meta.dirname, '..', '..', 'out', 'main', 'index.js'),
  extensions: [],
  extraArgs: [`--extension-development-path=${devExtDir}`],
})

test.describe('@p1 extension development mode', () => {
  test('loads a dev extension via --extension-development-path and survives a host restart', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()

    // 1) The dev extension activated (static command contribution translated),
    //    even under the core suite's empty built-in allowlist.
    await expect
      .poll(() => workbench.page.evaluate((id) => window.__E2E__!.hasCommand(id), COMMAND_ID), {
        timeout: 10000,
      })
      .toBe(true)

    // 2) The host tags it as under development.
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getDevExtensionIds()))
      .toContain(DEV_EXT_ID)

    // 3) workbench.action.restartExtensionHost re-scans: fire-and-forget (the
    //    restart is IPC-async), then the command must still be there.
    await workbench.page.evaluate(
      () => void window.__E2E__!.runCommand('workbench.action.restartExtensionHost'),
    )
    await expect
      .poll(() => workbench.page.evaluate((id) => window.__E2E__!.hasCommand(id), COMMAND_ID), {
        timeout: 15000,
      })
      .toBe(true)

    // 4) The window title carries the development-host badge (en-US is pinned
    //    by the fixture, so the English fallback text shows).
    await expect.poll(() => workbench.page.title()).toContain('[Extension Development Host]')
  })

  test('restarts the extension host automatically when the dev extension output changes @p1', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()
    await expect
      .poll(() => workbench.page.evaluate((id) => window.__E2E__!.hasCommand(id), COMMAND_ID), {
        timeout: 10000,
      })
      .toBe(true)

    const generationBefore = await workbench.page.evaluate(() =>
      window.__E2E__!.getExtensionHostGeneration(),
    )

    // Touch the manifest `main` entry the auto-reload contribution watches. The
    // appended line keeps the module valid, and the original content is restored
    // in finally so a Playwright retry in the same worker re-arms cleanly.
    const entryPath = path.join(devExtDir, 'dist', 'extension.js')
    const original = fs.readFileSync(entryPath, 'utf8')
    fs.appendFileSync(entryPath, '\n// touch')

    try {
      // The generation counter only moves when the host re-scans after a restart,
      // which pins the auto-restart even though the contributions DTO is unchanged.
      await expect
        .poll(
          async () => {
            const generation = await workbench.page.evaluate(() =>
              window.__E2E__!.getExtensionHostGeneration(),
            )
            // The out-of-workspace watcher's subscribe→ready window can swallow the
            // first touch; appending the same idempotent comment line re-triggers it.
            if (generation <= generationBefore) fs.appendFileSync(entryPath, '\n// touch')
            return generation
          },
          { timeout: 15000, intervals: [500, 1000] },
        )
        .toBeGreaterThan(generationBefore)

      // After the automatic restart the dev extension's command is registered again.
      await expect
        .poll(() => workbench.page.evaluate((id) => window.__E2E__!.hasCommand(id), COMMAND_ID), {
          timeout: 15000,
        })
        .toBe(true)
    } finally {
      // Disable the setting first so the restore write cannot schedule another
      // restart racing the fixture teardown.
      await workbench.page.evaluate(() =>
        window.__E2E__!.updateConfigValue('extensions.autoRestartOnChange', false),
      )
      fs.writeFileSync(entryPath, original)
    }
  })
})
