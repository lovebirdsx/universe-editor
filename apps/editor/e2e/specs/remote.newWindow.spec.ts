/*---------------------------------------------------------------------------------------------
 *  Remote window context inheritance (@regression).
 *
 *  Covers the window-level remoteAuthority pipeline: "New Window"
 *  (workbench.action.newWindow) from a remote workspace carries the remote-ssh
 *  authority into the new EMPTY window (argv --ue-remote-authority → preload
 *  bridge → currentRemoteAuthority's argv fallback); from a local workspace it
 *  stays local. Also guards the empty remote window's Open Folder dialog: its
 *  start point is the remote user home (not the local home), and the same window
 *  can then open a remote folder as its workspace.
 *
 *  Direct mode, same as remote.fsRoundtrip / remote.workspaceUi:
 *  UNIVERSE_REMOTE_SERVER_CMD runs the local daemon with authority `e2e-local`,
 *  so remote-ssh://e2e-local/<tmp> tunnels to the SAME machine's filesystem.
 *  The remote user home is therefore this machine's os.homedir().
 *
 *  Not @p0 — spawning the remote server is a child process per cold launch,
 *  slower and more environment-sensitive than the core workbench smoke path.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  createColdAppTest,
  evaluateWhenRestored,
  expectNoLeaks,
  QuickInputPO,
  waitForProbe,
} from '@universe-editor/e2e-harness'
import { expect } from '../fixtures/electronApp.js'
import type { ElectronApplication, Page } from '@playwright/test'

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

/** Escape a path for use inside a regex (home paths can carry `+` etc.). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Wait for the probe to install on a freshly-created window and for its
 *  lifecycle to reach Restored (the same hardening smoke.windows applies). */
async function waitForProbeAndRestored(page: Page): Promise<void> {
  await waitForProbe(page)
  await evaluateWhenRestored(page)
}

/** Fire-and-forget New Window, then wait for the new page's probe to be ready. */
async function openNewWindow(electronApp: ElectronApplication, page: Page): Promise<Page> {
  const newWindow = electronApp.waitForEvent('window')
  await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.newWindow'))
  const newPage = await newWindow
  await waitForProbeAndRestored(newPage)
  return newPage
}

test.describe('remote window context', () => {
  test('New Window from a remote workspace inherits the remote authority @regression', async ({
    workbench,
    electronApp,
    scratchDir,
  }) => {
    await workbench.waitForRestored()
    const tmpDir = scratchDir('ue2-remote-nw-')
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello\n')
    const rootUri = remoteUri(tmpDir)

    await workbench.page.evaluate((uri) => window.__E2E__!.openWorkspaceUri(uri), rootUri)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getCurrentWorkspaceUri()), {
        timeout: 15_000,
      })
      .toBe(rootUri)

    // The primary remote window reports its authority.
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getWindowRemoteAuthority()), {
        timeout: 15_000,
      })
      .toBe(AUTHORITY)

    const newPage = await openNewWindow(electronApp, workbench.page)

    // The new empty window keeps the authority but not the workspace.
    await expect
      .poll(() => newPage.evaluate(() => window.__E2E__!.getWindowRemoteAuthority()), {
        timeout: 15_000,
      })
      .toBe(AUTHORITY)
    await expect
      .poll(() => newPage.evaluate(() => window.__E2E__!.getCurrentWorkspaceUri()), {
        timeout: 15_000,
      })
      .toBeUndefined()

    await expectNoLeaks(newPage)
  })

  test('an empty remote window opens the folder dialog at the remote home and can open a remote folder @regression', async ({
    workbench,
    electronApp,
    scratchDir,
  }) => {
    await workbench.waitForRestored()
    const tmpDir = scratchDir('ue2-remote-nw-')
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello\n')
    const rootUri = remoteUri(tmpDir)
    const subDir = path.join(tmpDir, 'sub')
    fs.mkdirSync(subDir)
    const subUri = remoteUri(subDir)

    await workbench.page.evaluate((uri) => window.__E2E__!.openWorkspaceUri(uri), rootUri)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getCurrentWorkspaceUri()), {
        timeout: 15_000,
      })
      .toBe(rootUri)

    const newPage = await openNewWindow(electronApp, workbench.page)
    await expect
      .poll(() => newPage.evaluate(() => window.__E2E__!.getWindowRemoteAuthority()), {
        timeout: 15_000,
      })
      .toBe(AUTHORITY)

    // Open Folder in the empty remote window: the simple dialog must start at
    // the remote user home (not the client home), pinned by the argv authority.
    const quickInput = new QuickInputPO(newPage)
    void newPage.evaluate(
      () => void window.__E2E__!.runCommand('workbench.action.files.openFolder'),
    )
    await quickInput.waitForVisible()

    const remoteHome = os.homedir()
    await expect(quickInput.input).toHaveValue(new RegExp(`^${escapeRegExp(remoteHome)}[\\\\/]?$`))

    await newPage.keyboard.press('Escape')
    await quickInput.waitForHidden()

    // The dialog's OK path calls IWorkspaceService.openFolder on a remote-ssh
    // URI; exercise that exact chain via the probe (bypassing the fragile typed
    // interaction) to prove the empty remote window can adopt a remote workspace.
    await newPage.evaluate((uri) => window.__E2E__!.openWorkspaceUri(uri), subUri)
    await expect
      .poll(() => newPage.evaluate(() => window.__E2E__!.getCurrentWorkspaceUri()), {
        timeout: 15_000,
      })
      .toBe(subUri)

    await expectNoLeaks(newPage)
  })

  test('New Window from a local workspace stays local @regression', async ({
    workbench,
    electronApp,
    scratchDir,
  }) => {
    await workbench.waitForRestored()
    const tmpDir = scratchDir('ue2-local-nw-')
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello\n')

    await workbench.openWorkspace(tmpDir)
    await expect
      .poll(() => workbench.getCurrentWorkspacePath(), { timeout: 15_000 })
      .toBe(tmpDir.replace(/\\/g, '/'))

    // A local workspace is always a local window — never an argv fallback.
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getWindowRemoteAuthority()), {
        timeout: 15_000,
      })
      .toBeUndefined()

    const newPage = await openNewWindow(electronApp, workbench.page)

    await expect
      .poll(() => newPage.evaluate(() => window.__E2E__!.getWindowRemoteAuthority()), {
        timeout: 15_000,
      })
      .toBeUndefined()

    await expectNoLeaks(newPage)
  })
})
