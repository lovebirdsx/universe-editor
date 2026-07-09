/*---------------------------------------------------------------------------------------------
 *  Smoke spec: the extensions system end-to-end.
 *
 *  1) The Extensions view container opens from the activity bar.
 *  2) Installing a local `.vsix` makes its contributed command visible without a
 *     reload; uninstalling removes both the extension and its command.
 *
 *  Not @p0 — the extension host boots a child process, which is slower and more
 *  environment-sensitive than the core workbench smoke path.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import AdmZip from 'adm-zip'
import { test, expect } from '../fixtures/electronApp.js'

const EXTENSIONS_CONTAINER = 'workbench.view.extensions'

/** Build a minimal restricted-tier extension `.vsix` contributing one command. */
async function makeVsix(dir: string, commandId: string): Promise<string> {
  const manifest = {
    name: 'e2e-sample',
    publisher: 'universe',
    version: '1.0.0',
    engines: { universe: '*' },
    main: 'dist/extension.js',
    contributes: {
      commands: [{ command: commandId, title: 'E2E Sample: Hello' }],
    },
  }
  const zip = new AdmZip()
  zip.addFile('extension/package.json', Buffer.from(JSON.stringify(manifest)))
  zip.addFile(
    'extension/dist/extension.js',
    Buffer.from('module.exports = { activate() {}, deactivate() {} }'),
  )
  const vsixPath = path.join(dir, 'e2e-sample.vsix')
  await fs.writeFile(vsixPath, zip.toBuffer())
  return vsixPath
}

test.describe('@p1 extensions', () => {
  test('opens the extensions view container', async ({ workbench }) => {
    const { activityBar, sideBar } = workbench
    await workbench.waitForBootstrapFocusSettled()

    await expect(activityBar.item(EXTENSIONS_CONTAINER)).toBeVisible()
    await activityBar.click(EXTENSIONS_CONTAINER)
    await expect(sideBar.root).toHaveAttribute('data-active-view-container', EXTENSIONS_CONTAINER)
  })

  test('installs a VSIX so its command appears, then uninstalls it @regression', async ({
    workbench,
  }) => {
    const commandId = 'e2eSample.hello'
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-ext-'))
    const vsixPath = await makeVsix(tmpDir, commandId)

    await workbench.waitForRestored()

    // The contributed command must not exist before install.
    expect(await workbench.page.evaluate((id) => window.__E2E__!.hasCommand(id), commandId)).toBe(
      false,
    )

    const installedId = await workbench.page.evaluate(
      (p) => window.__E2E__!.installVsixExtension(p),
      vsixPath,
    )
    expect(installedId).toBe('universe.e2e-sample')

    // Installing re-scans the restricted host and re-applies contributions; the
    // command surfaces without a reload.
    await expect
      .poll(() => workbench.page.evaluate((id) => window.__E2E__!.hasCommand(id), commandId), {
        timeout: 10000,
      })
      .toBe(true)

    expect(
      await workbench.page.evaluate(() => window.__E2E__!.getInstalledExtensionIds()),
    ).toContain('universe.e2e-sample')

    // Uninstall removes the extension from the list.
    await workbench.page.evaluate((id) => window.__E2E__!.uninstallExtension(id), installedId)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getInstalledExtensionIds()), {
        timeout: 5000,
      })
      .not.toContain('universe.e2e-sample')

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  test('disabling a built-in extension adds it to the effective disabled set @regression', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()

    // Built-ins are listed and enabled by default.
    const builtins = await workbench.page.evaluate(() => window.__E2E__!.getBuiltinExtensionIds())
    expect(builtins.length).toBeGreaterThan(0)
    const target = builtins[0]!

    expect(
      await workbench.page.evaluate(() => window.__E2E__!.getDisabledExtensionIds()),
    ).not.toContain(target)

    // Disable globally → it enters the effective disabled set.
    await workbench.page.evaluate((id) => window.__E2E__!.setExtensionEnablement(id, false), target)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getDisabledExtensionIds()), {
        timeout: 5000,
      })
      .toContain(target)

    // Re-enable → it leaves the disabled set again.
    await workbench.page.evaluate((id) => window.__E2E__!.setExtensionEnablement(id, true), target)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getDisabledExtensionIds()), {
        timeout: 5000,
      })
      .not.toContain(target)
  })
})
