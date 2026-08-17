/*---------------------------------------------------------------------------------------------
 *  Remote workspace UI chain (@regression).
 *
 *  Opens a remote-ssh folder AS the workspace (the same IWorkspaceService.openFolder
 *  the command flow drives, bypassing the folder dialog), then exercises the chain a
 *  user hits next: the explorer lists the remote root, a remote file opens in an
 *  editor, an edit + save round-trips through the scheme-dispatched FileService, and
 *  the recent-workspaces list records the remote folder URI. All assertions go through
 *  the probe (service interfaces), not DOM, and everything is keyed by the full
 *  remote-ssh URI string — no fsPath leaks into the local filesystem.
 *
 *  Direct mode, same as remote.fsRoundtrip: UNIVERSE_REMOTE_SERVER_CMD runs the local
 *  daemon against the Playwright tmp dir with authority `e2e-local`.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs'
import * as path from 'node:path'
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

test.describe('remote workspace ui', () => {
  test('opens a remote folder, lists, edits + saves a file, and records it in recent @regression', async ({
    workbench,
    scratchDir,
  }) => {
    await workbench.waitForRestored()
    // scratchDir: the daemon holds the workspace root while the app lives — cleanup runs post-close.
    const tmpDir = scratchDir('ue2-remote-ws-')

    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello\n')
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'world\n')
    const rootUri = remoteUri(tmpDir)
    const aUri = remoteUri(path.join(tmpDir, 'a.txt'))

    // Open the remote folder as the workspace (dialog bypassed).
    await workbench.page.evaluate((uri) => window.__E2E__!.openWorkspaceUri(uri), rootUri)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getCurrentWorkspaceUri()), {
        timeout: 15_000,
      })
      .toBe(rootUri)

    // Explorer data source lists the remote root.
    await expect
      .poll(() => workbench.page.evaluate((uri) => window.__E2E__!.listResource(uri), rootUri), {
        timeout: 20_000,
      })
      .toEqual(expect.arrayContaining(['a.txt', 'b.txt']))

    // Open a remote file in an editor (the active editor id is its URI string).
    await workbench.page.evaluate((uri) => window.__E2E__!.openUri(uri), aUri)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorUri()), {
        timeout: 15_000,
      })
      .toBe(aUri)

    // Edit the open file and save it through the active-editor save path.
    const next = 'hello remote edit\n'
    await expect
      .poll(
        () => workbench.page.evaluate((text) => window.__E2E__!.setActiveEditorText(text), next),
        { timeout: 15_000 },
      )
      .toBe(true)
    await workbench.page.evaluate(() => window.__E2E__!.runCommand('workbench.action.files.save'))

    // The save round-tripped through the remote FileService: re-read from disk.
    await expect
      .poll(() => workbench.page.evaluate((uri) => window.__E2E__!.readFileText(uri), aUri), {
        timeout: 15_000,
      })
      .toBe(next)

    // Recent-workspaces list holds the remote folder URI (not a local fsPath).
    const recent = await workbench.page.evaluate(() => window.__E2E__!.getRecentWorkspaceUris())
    expect(recent).toContain(rootUri)
  })

  test('surfaces the remote authority via context key, status bar, and Remote Explorer @regression', async ({
    workbench,
    scratchDir,
  }) => {
    await workbench.waitForRestored()
    const tmpDir = scratchDir('ue2-remote-ws-')

    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello\n')
    const rootUri = remoteUri(tmpDir)

    // Local state: the remote indicator entry always renders (icon-only, no
    // background), isRemote is false, and the title bar shows no remote badge.
    await expect
      .poll(async () => {
        const entries = await workbench.page.evaluate(() => window.__E2E__!.getStatusBarEntries())
        const entry = entries.find((e) => e.entryId === 'remote.indicator')
        return entry ? { text: entry.text, backgroundColor: entry.backgroundColor ?? null } : null
      })
      .toEqual({ text: '$(remote)', backgroundColor: null })
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getContextKey('isRemote')))
      .toBe(false)
    await expect(workbench.page.getByTestId('titlebar-remote-badge')).toHaveCount(0)

    await workbench.page.evaluate((uri) => window.__E2E__!.openWorkspaceUri(uri), rootUri)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getCurrentWorkspaceUri()), {
        timeout: 15_000,
      })
      .toBe(rootUri)

    // The `remoteAuthority` context key seeds the current authority.
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getContextKey('remoteAuthority')), {
        timeout: 15_000,
      })
      .toBe(AUTHORITY)

    // A left-aligned status-bar entry shows the SSH indicator for the authority,
    // identified by its semantic entry id and carrying the remote background color.
    await expect
      .poll(async () => {
        const entries = await workbench.page.evaluate(() => window.__E2E__!.getStatusBarEntries())
        return entries.some(
          (e) =>
            e.entryId === 'remote.indicator' &&
            e.alignment === 'left' &&
            e.text.includes('SSH:') &&
            e.text.includes(AUTHORITY) &&
            e.backgroundColor === 'statusBarItem.remoteBackground',
        )
      })
      .toBe(true)

    // The remote context keys follow the connected authority (non-wsl → 'ssh').
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getContextKey('isRemote')))
      .toBe(true)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getContextKey('remoteName')))
      .toBe('ssh')

    // The title-bar badge shows the remote label next to the command center.
    const badge = workbench.page.getByTestId('titlebar-remote-badge')
    await expect(badge).toHaveCount(1)
    await expect(badge).toContainText(`SSH: ${AUTHORITY}`)

    // The OS window title starts with the remote marker, at the very front —
    // the taskbar truncates the tail, so the marker must not sit at the end.
    await expect
      .poll(() => workbench.page.evaluate(() => document.title), { timeout: 15_000 })
      .toMatch(/^⇄ /)

    // The Open Recent quick pick marks the remote workspace with the same
    // marker (showQuickPick-style action awaits user input → fire-and-forget).
    void workbench.page.evaluate(
      () => void window.__E2E__!.runCommand('workbench.action.openRecent'),
    )
    await workbench.quickInput.waitForVisible()
    await expect(workbench.quickInput.dialog.getByText(/^⇄ /)).toBeVisible()
    await workbench.page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()

    // Remote Explorer container + view are registered in the primary side bar.
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getViewContainerIdsByLocation(0)))
      .toContain('workbench.view.remote')
    const views = await workbench.page.evaluate(() =>
      window.__E2E__!.getViewIdsByContainer('workbench.view.remote'),
    )
    expect(views).toContain('workbench.view.remote.targets')

    // The connection facade (the Remote Explorer "Connections" data source) lists
    // the injected authority as connected.
    await expect
      .poll(
        async () => {
          const connections = await workbench.page.evaluate(() =>
            window.__E2E__!.getRemoteConnections(),
          )
          return connections.some((c) => c.authority === AUTHORITY && c.state === 'connected')
        },
        { timeout: 15_000 },
      )
      .toBe(true)
  })
})
