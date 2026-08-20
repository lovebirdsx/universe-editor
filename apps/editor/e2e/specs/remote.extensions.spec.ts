/*---------------------------------------------------------------------------------------------
 *  Remote user extensions (@regression).
 *
 *  Opens a remote-ssh folder, then proves the extension-management chain routes
 *  user extensions to the remote host: a locally-built `.vsix` is uploaded and
 *  installed into the daemon's `<dataDir>/user-extensions` (not the client's), the
 *  remote host re-scans it and its contributed command surfaces, and uninstalling
 *  removes both the record and the command. A second test disables a remote
 *  extension and asserts the effective disabled set tracks it.
 *
 *  Direct mode, same as remote.extensionHost: UNIVERSE_REMOTE_SERVER_CMD runs the
 *  local daemon against `<userData>/remote-direct/<authority>`, so the remote
 *  user-extensions dir is isolated per authority and shared by the install engine
 *  and the remote host (both resolve it from the same `serverPaths.ts`).
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import AdmZip from 'adm-zip'
import { createColdAppTest } from '@universe-editor/e2e-harness'
import { expect } from '../fixtures/electronApp.js'

const AUTHORITY = 'e2e-local'

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const remoteServerEntry = path.join(repoRoot, 'packages', 'remote-server', 'dist', 'bootstrap.js')

export const test = createColdAppTest({
  appRoot: path.resolve(import.meta.dirname, '..', '..'),
  mainEntry: path.resolve(import.meta.dirname, '..', '..', 'out', 'main', 'index.js'),
  extensions: [],
  env: {
    UNIVERSE_REMOTE_SERVER_CMD: JSON.stringify([process.execPath, remoteServerEntry]),
  },
})

/** `remote-ssh://<authority>/<path>` for an absolute local path (same host). */
function remoteUri(fsPath: string): string {
  const normalized = fsPath.replace(/\\/g, '/')
  const pathPart = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `remote-ssh://${AUTHORITY}${pathPart}`
}

/** Build a minimal restricted-tier extension `.vsix` contributing one command. */
async function makeVsix(dir: string, commandId: string): Promise<string> {
  const manifest = {
    name: 'e2e-remote-sample',
    publisher: 'universe',
    version: '1.0.0',
    engines: { universe: '*' },
    main: 'dist/extension.js',
    contributes: {
      commands: [{ command: commandId, title: 'E2E Remote Sample: Hello' }],
    },
  }
  const zip = new AdmZip()
  zip.addFile('extension/package.json', Buffer.from(JSON.stringify(manifest)))
  zip.addFile(
    'extension/dist/extension.js',
    Buffer.from('module.exports = { activate() {}, deactivate() {} }'),
  )
  const vsixPath = path.join(dir, 'e2e-remote-sample.vsix')
  await fs.writeFile(vsixPath, zip.toBuffer())
  return vsixPath
}

test.describe('remote user extensions', () => {
  test('installs a VSIX into the remote host so its command appears, then uninstalls it @regression', async ({
    workbench,
    scratchDir,
  }) => {
    const commandId = 'e2eRemoteSample.hello'
    const installedId = 'universe.e2e-remote-sample'
    await workbench.waitForRestored()

    // scratchDir: held by the daemon while the app lives; the vsix lives there too
    // so cleanup runs post-close (Windows won't EPERM on a live-handle remove).
    const tmpDir = scratchDir('ue2-remote-ext-')
    const vsixPath = await makeVsix(tmpDir, commandId)

    // Open the remote folder as the workspace (dialog bypassed).
    const rootUri = remoteUri(tmpDir)
    await workbench.page.evaluate((uri) => window.__E2E__!.openWorkspaceUri(uri), rootUri)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getCurrentWorkspaceUri()), {
        timeout: 15_000,
      })
      .toBe(rootUri)

    // The contributed command must not exist before install.
    expect(await workbench.page.evaluate((id) => window.__E2E__!.hasCommand(id), commandId)).toBe(
      false,
    )

    // Install into the remote host (authority-tail routes through the tunnel).
    const id = await workbench.page.evaluate(
      (args: { vsixPath: string; authority: string }) =>
        window.__E2E__!.installVsixExtension(args.vsixPath, args.authority),
      { vsixPath, authority: AUTHORITY },
    )
    expect(id).toBe(installedId)

    // The remote host's installed set now contains it (poll: install → tunnel →
    // remote extensions.json round-trips asynchronously).
    await expect
      .poll(
        () =>
          workbench.page.evaluate((a) => window.__E2E__!.getInstalledExtensionIds(a), AUTHORITY),
        { timeout: 10_000 },
      )
      .toContain(installedId)

    // Installing re-scans the remote host and re-applies contributions; the
    // command surfaces without a reload.
    await expect
      .poll(() => workbench.page.evaluate((id) => window.__E2E__!.hasCommand(id), commandId), {
        timeout: 15_000,
      })
      .toBe(true)

    // Uninstall from the remote host: record and command both disappear.
    await workbench.page.evaluate(
      (args: { identifier: string; authority: string }) =>
        window.__E2E__!.uninstallExtension(args.identifier, args.authority),
      { identifier: installedId, authority: AUTHORITY },
    )
    await expect
      .poll(
        () =>
          workbench.page.evaluate((a) => window.__E2E__!.getInstalledExtensionIds(a), AUTHORITY),
        { timeout: 10_000 },
      )
      .not.toContain(installedId)
    await expect
      .poll(() => workbench.page.evaluate((id) => window.__E2E__!.hasCommand(id), commandId), {
        timeout: 15_000,
      })
      .toBe(false)
  })

  test('disabling a remote extension adds it to the effective disabled set @regression', async ({
    workbench,
    scratchDir,
  }) => {
    const commandId = 'e2eRemoteSample.disable'
    const installedId = 'universe.e2e-remote-sample'
    await workbench.waitForRestored()

    const tmpDir = scratchDir('ue2-remote-ext-')
    const vsixPath = await makeVsix(tmpDir, commandId)

    const rootUri = remoteUri(tmpDir)
    await workbench.page.evaluate((uri) => window.__E2E__!.openWorkspaceUri(uri), rootUri)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getCurrentWorkspaceUri()), {
        timeout: 15_000,
      })
      .toBe(rootUri)

    const id = await workbench.page.evaluate(
      (args: { vsixPath: string; authority: string }) =>
        window.__E2E__!.installVsixExtension(args.vsixPath, args.authority),
      { vsixPath, authority: AUTHORITY },
    )
    expect(id).toBe(installedId)
    await expect
      .poll(
        () =>
          workbench.page.evaluate((a) => window.__E2E__!.getInstalledExtensionIds(a), AUTHORITY),
        { timeout: 10_000 },
      )
      .toContain(installedId)

    expect(
      await workbench.page.evaluate(() => window.__E2E__!.getDisabledExtensionIds()),
    ).not.toContain(installedId)

    // Disable globally → the enablement service routes by the workspace authority
    // and the effective disabled set tracks the remote host's enablement map.
    await workbench.page.evaluate(
      (i) => window.__E2E__!.setExtensionEnablement(i, false),
      installedId,
    )
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getDisabledExtensionIds()), {
        timeout: 10_000,
      })
      .toContain(installedId)

    // Re-enable → it leaves the disabled set again.
    await workbench.page.evaluate(
      (i) => window.__E2E__!.setExtensionEnablement(i, true),
      installedId,
    )
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getDisabledExtensionIds()), {
        timeout: 10_000,
      })
      .not.toContain(installedId)
  })
})
