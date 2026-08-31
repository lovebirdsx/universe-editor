/*---------------------------------------------------------------------------------------------
 *  Remote SCM auto-refresh on save (@regression).
 *
 *  In a remote-ssh workspace, modifying a committed file and saving it must make
 *  it appear in SOURCE CONTROL's "Changes" list WITHOUT a manual git.refresh.
 *  Guards the bug where the git extension's working-tree interest (a
 *  `createFileSystemWatcher` over a recursive `**` glob anchored at the repo
 *  root) crossed the host codec as a remote-ssh base, and the renderer's
 *  MainThreadFileEvents dropped it (only `file:` was accepted) — so the watcher
 *  never received the save event and CHANGES stayed stale until a manual refresh.
 *
 *  Direct mode, same as remote.extensionHost: UNIVERSE_REMOTE_SERVER_CMD runs the
 *  local daemon against the Playwright tmp dir with authority `e2e-local`. The git
 *  built-in is pinned so it boots remotely and registers its SourceControl against
 *  the remote repository.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createColdAppTest } from '@universe-editor/e2e-harness'
import { expect } from '../fixtures/electronApp.js'

const AUTHORITY = 'e2e-local'

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const remoteServerEntry = path.join(repoRoot, 'packages', 'remote-server', 'dist', 'bootstrap.js')

export const test = createColdAppTest({
  appRoot: path.resolve(import.meta.dirname, '..', '..'),
  mainEntry: path.resolve(import.meta.dirname, '..', '..', 'out', 'main', 'index.js'),
  // The git built-in must boot (remotely) so its SourceControl registers against
  // the remote repo; the client's minimal-extension-set allowlist reaches the
  // remote host through the daemon's inherited env, so pin exactly git.
  extensions: ['@universe-editor/git'],
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

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

test.describe('remote scm', () => {
  test('saving a modified file surfaces it in SOURCE CONTROL changes without a manual refresh @regression', async ({
    workbench,
    scratchDir,
  }) => {
    // Cold boot + remote host + git extension activation is heavy.
    test.setTimeout(180_000)
    await workbench.waitForRestored()

    // scratchDir: the daemon holds the workspace root while the app lives — cleanup runs post-close.
    const tmpDir = scratchDir('ue2-remote-scm-')

    git(tmpDir, 'init')
    git(tmpDir, 'config', 'user.email', 'e2e@example.com')
    git(tmpDir, 'config', 'user.name', 'E2E')
    const filePath = path.join(tmpDir, 'a.txt')
    fs.writeFileSync(filePath, 'hello\n')
    git(tmpDir, 'add', '-A')
    git(tmpDir, 'commit', '-m', 'init')

    const rootUri = remoteUri(tmpDir)
    const aUri = remoteUri(filePath)

    // The git extension's autofetch timer re-runs `git status` every period and
    // would surface the save without the watcher — disable it so the working-tree
    // watcher is the only thing that can refresh after the save.
    await workbench.page.evaluate(() => window.__E2E__!.updateConfigValue('git.autofetch', false))

    // Open the remote folder as the workspace (dialog bypassed).
    await workbench.page.evaluate((uri) => window.__E2E__!.openWorkspaceUri(uri), rootUri)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getCurrentWorkspaceUri()), {
        timeout: 15_000,
      })
      .toBe(rootUri)

    // Wait for the git extension's SourceControl to register against the remote repo.
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
      })
      .toBeGreaterThan(0)

    // Settle the initial status scan (clean working tree) before editing: the
    // fire-and-forget scan the git extension launches on repo registration would
    // otherwise race the save below and pick up the modification on its own.
    await workbench.page.evaluate(() => window.__E2E__!.runCommand('git.refresh'))

    // Open the committed file and edit + save it through the active-editor save path.
    await workbench.page.evaluate((uri) => window.__E2E__!.openUri(uri), aUri)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorUri()), {
        timeout: 15_000,
      })
      .toBe(aUri)

    const next = 'hello remote edit\n'
    await expect
      .poll(
        () => workbench.page.evaluate((text) => window.__E2E__!.setActiveEditorText(text), next),
        { timeout: 15_000 },
      )
      .toBe(true)
    await workbench.page.evaluate(() => window.__E2E__!.runCommand('workbench.action.files.save'))

    // The saved file must land in the git "Changes" (workingTree) group on its
    // own — no git.refresh — as the working-tree watcher fires on the save event.
    await expect
      .poll(
        () =>
          workbench.page.evaluate(
            (suffix) => window.__E2E__!.getScmGroupIdsForResource(suffix),
            'a.txt',
          ),
        { timeout: 30_000, message: 'saved file should appear in the Changes group' },
      )
      .toContain('workingTree')
  })

  test('gitignored files under a remote repo report as ignored (Explorer dimming) @regression', async ({
    workbench,
    scratchDir,
  }) => {
    // Cold boot + remote host + git extension activation is heavy.
    test.setTimeout(180_000)
    await workbench.waitForRestored()

    // Guards the bug where the whole ignore-dim chain was gated on
    // `scheme === 'file'`, so remote resources never reached git.checkIgnore and
    // ignored files/folders rendered at normal brightness in the Explorer.
    const tmpDir = scratchDir('ue2-remote-ignore-')

    git(tmpDir, 'init')
    git(tmpDir, 'config', 'user.email', 'e2e@example.com')
    git(tmpDir, 'config', 'user.name', 'E2E')
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'ignored/\n*.log\n')
    fs.mkdirSync(path.join(tmpDir, 'ignored'), { recursive: true })
    const ignoredFile = path.join(tmpDir, 'ignored', 'blob.txt')
    const ignoredLog = path.join(tmpDir, 'debug.log')
    const trackedFile = path.join(tmpDir, 'a.txt')
    fs.writeFileSync(ignoredFile, 'noise\n')
    fs.writeFileSync(ignoredLog, 'noise\n')
    fs.writeFileSync(trackedFile, 'hello\n')
    git(tmpDir, 'add', '-A')
    git(tmpDir, 'commit', '-m', 'init')

    const rootUri = remoteUri(tmpDir)

    await workbench.page.evaluate((uri) => window.__E2E__!.openWorkspaceUri(uri), rootUri)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getCurrentWorkspaceUri()), {
        timeout: 15_000,
      })
      .toBe(rootUri)

    // The ignore lookup routes through the owning provider's checkIgnore command,
    // so the remote git SourceControl has to be registered first.
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
      })
      .toBeGreaterThan(0)

    // isIgnored is a pull-style cache: the first read enqueues and answers
    // undefined, so poll until the batch resolves.
    const isIgnored = (fsPath: string): Promise<boolean | undefined> =>
      workbench.page.evaluate((uri) => window.__E2E__!.isResourceGitIgnored(uri), remoteUri(fsPath))

    for (const [label, target] of [
      ['ignored folder', path.join(tmpDir, 'ignored')],
      ['file inside an ignored folder', ignoredFile],
      ['file matching a *.log rule', ignoredLog],
    ] as const) {
      await expect
        .poll(() => isIgnored(target), { timeout: 30_000, message: `${label} should be ignored` })
        .toBe(true)
    }

    // A tracked file must stay bright — a blanket "true" would dim the whole tree.
    await expect
      .poll(() => isIgnored(trackedFile), {
        timeout: 30_000,
        message: 'tracked file should not be ignored',
      })
      .toBe(false)
  })
})
