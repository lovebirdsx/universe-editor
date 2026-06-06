/*---------------------------------------------------------------------------------------------
 *  SCM state cleanup on workspace switch.
 *
 *  Regression test for: switching from a git-managed workspace to a non-git
 *  workspace leaves stale SCM source controls visible in the SCM panel.
 *
 *  Root cause: HostSourceControl.dispose() sends $unregisterSourceControl via
 *  a fire-and-forget IPC call. When the extension host exits, the renderer tears
 *  down the IPC channel before that message can be processed, so ScmService
 *  retains the stale registrations. The fix calls scmService.resetSourceControls()
 *  in _teardownConnection() so the state is always cleaned up deterministically.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// The universe-editor repo root is a git-managed workspace we can use as a fixture.
const GIT_WORKSPACE = resolve(__dirname, '..', '..', '..', '..')

test.describe('@p1 SCM workspace switch', () => {
  test('clears SCM source controls when switching from git to non-git workspace', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()

    // Open a git-managed workspace so the git extension registers a source control.
    await workbench.openWorkspace(GIT_WORKSPACE)

    // Wait for the extension host to restart and git extension to register SCM.
    await expect
      .poll(() => workbench.getScmSourceControlCount(), { timeout: 15_000 })
      .toBeGreaterThan(0)

    // Switch to a temp directory that has no git repository.
    const nonGitDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-nongit-'))
    await workbench.openWorkspace(nonGitDir)

    // After the extension host restarts for the non-git workspace, no SCM source
    // controls should be registered (git extension returns early when no repo found).
    await expect.poll(() => workbench.getScmSourceControlCount(), { timeout: 15_000 }).toBe(0)
  })
})
