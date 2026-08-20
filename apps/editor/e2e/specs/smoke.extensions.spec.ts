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
import * as nodeFs from 'node:fs'
import * as os from 'node:os'
import AdmZip from 'adm-zip'
import { createColdAppTest } from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY, test, expect } from '../fixtures/electronApp.js'

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

  test('built-in extensions are never version-incompatible @regression', async ({ workbench }) => {
    await workbench.waitForRestored()

    const builtins = await workbench.page.evaluate(() => window.__E2E__!.getBuiltinExtensionIds())
    expect(builtins.length).toBeGreaterThan(0)

    // Guards the dev/e2e app-version fallback: before the fix the host version
    // collapsed to Electron's own, flagging every built-in incompatible.
    const incompatible = await workbench.page.evaluate(() =>
      window.__E2E__!.getVersionIncompatibleExtensionIds(),
    )
    expect(incompatible.filter((id) => builtins.includes(id))).toEqual([])
  })

  test('built-ins hidden by default; @builtin lists them with text filtering', async ({
    workbench,
  }) => {
    const { activityBar, sideBar, page } = workbench
    await workbench.waitForBootstrapFocusSettled()

    await activityBar.click(EXTENSIONS_CONTAINER)
    await expect(sideBar.root).toHaveAttribute('data-active-view-container', EXTENSIONS_CONTAINER)

    const rows = page.getByTestId('extension-row')

    // Default list shows user-installed extensions only — the e2e baseline has
    // none, so built-ins (e.g. the Monokai theme) must not appear.
    await expect(rows.filter({ hasText: 'Monokai Theme' })).toHaveCount(0)

    // `@builtin` switches the list to built-in extensions.
    const searchBox = page.getByLabel('Search Extensions')
    await searchBox.fill('@builtin')
    await expect(page.getByText('Built-in', { exact: true })).toBeVisible()
    await expect.poll(() => rows.count()).toBeGreaterThan(5)
    await expect(rows.filter({ hasText: 'Monokai Theme' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'Git' }).first()).toBeVisible()

    // Extensions declaring `icon.svg` render a real <img>, not the lucide
    // fallback glyph (themes + textmate-grammars both declare one).
    await expect(rows.filter({ hasText: 'Monokai Theme' }).locator('img')).toHaveCount(1)
    await expect(rows.filter({ hasText: 'TextMate Grammars' }).locator('img')).toHaveCount(1)

    // Trailing text filters within the built-in pool (Monokai Theme matches by
    // name; the dimmed variant matches by id/description).
    await searchBox.fill('@builtin monokai')
    await expect(rows.filter({ hasText: 'Monokai Theme' })).toHaveCount(1)
    for (const text of await rows.allTextContents()) {
      expect(text.toLowerCase()).toContain('monokai')
    }

    // Clearing the query returns to the user-installed list.
    await searchBox.fill('')
    await expect(rows.filter({ hasText: 'Monokai Theme' })).toHaveCount(0)
  })
})

/**
 * Version-incompatibility guard: an extension declaring `engines.universe:
 * '>=99.0.0'` must be auto-disabled at load (not activated, contributions hidden)
 * and surfaced by the management list — the DisabledByInvalidExtension parity.
 *
 * Loaded as a dev extension (`--extension-development-path`) because install-time
 * `satisfies` would refuse it outright; the dev path still goes through the host
 * engine check (dev is not exempt).
 */
const INCOMPAT_COMMAND_ID = 'e2eIncompat.hello'
const INCOMPAT_DEV_EXT_ID = 'universe.e2e-incompat'

function makeIncompatibleDevExtensionDir(): string {
  const dir = nodeFs.realpathSync.native(
    nodeFs.mkdtempSync(path.join(os.tmpdir(), 'ue2-incompat-')),
  )
  nodeFs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'e2e-incompat',
      publisher: 'universe',
      version: '1.0.0',
      engines: { universe: '>=99.0.0' },
      main: 'dist/extension.js',
      contributes: { commands: [{ command: INCOMPAT_COMMAND_ID, title: 'E2E Incompat: Hello' }] },
    }),
  )
  nodeFs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  nodeFs.writeFileSync(
    path.join(dir, 'dist', 'extension.js'),
    'module.exports = { activate() {}, deactivate() {} }',
  )
  return dir
}

const incompatibleDevExtDir = makeIncompatibleDevExtensionDir()

const incompatibleTest = createColdAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: [],
  extraArgs: [`--extension-development-path=${incompatibleDevExtDir}`],
})

incompatibleTest.describe('@p1 extensions version incompatibility', () => {
  incompatibleTest(
    'auto-disables a version-incompatible extension and hides its contributions @regression',
    async ({ workbench }) => {
      await workbench.waitForRestored()

      // The host refuses to activate it, so its contributed command never registers.
      expect(
        await workbench.page.evaluate((id) => window.__E2E__!.hasCommand(id), INCOMPAT_COMMAND_ID),
      ).toBe(false)

      // The management service surfaces it as version-incompatible for the UI list.
      await expect
        .poll(
          () => workbench.page.evaluate(() => window.__E2E__!.getVersionIncompatibleExtensionIds()),
          { timeout: 10000 },
        )
        .toContain(INCOMPAT_DEV_EXT_ID)
    },
  )
})
