/*---------------------------------------------------------------------------------------------
 *  "Publish Branch" commit-button state (@p1).
 *
 *  With a clean working tree on a branch that has no upstream, the SCM input bar
 *  must offer Publish Branch instead of the disabled Commit — the state VSCode's
 *  git action button shows. Clicking it runs `git push -u`, after which the
 *  branch is published and in sync, so the button falls back to disabled Commit.
 *  Setup: a clone on a published default branch plus a fresh `feature` branch.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test'
import { writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { seedBaselineUserData, mkTempDir } from '@universe-editor/e2e-harness'
import { closeApp, launchCoreGitApp } from '../fixtures/coreGitApp.js'
import { evaluateWhenRestored } from '../pages/WorkbenchPO.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
}

/** A clone whose default branch is published, checked out on a clean, unpublished
 *  `feature`. Returns the clone path (the workspace root the app opens). */
function makeRepoWithUnpublishedBranch(): string {
  // realpath.native: the raw mkdtemp path on CI Windows is an 8.3 short path.
  const root = realpathSync.native(mkTempDir('universe-editor-e2e-pub-'))
  const remote = join(root, 'remote.git')
  const local = join(root, 'local')

  git(root, 'init', '--bare', remote)
  git(root, 'clone', remote, local)
  git(local, 'config', 'user.email', 'e2e@example.com')
  git(local, 'config', 'user.name', 'E2E')
  writeFileSync(join(local, 'a.ts'), 'const a = 1\n', 'utf8')
  git(local, 'add', '-A')
  git(local, 'commit', '-m', 'initial')
  git(local, 'push', '-u', 'origin', 'HEAD')
  git(local, 'checkout', '-b', 'feature')
  return local
}

test.describe('@p1 git publish branch', () => {
  test('the commit button publishes an unpublished branch, then falls back to Commit', async () => {
    // Cold boot + git extension activation in a real repo is heavy on Windows CI.
    test.setTimeout(120_000)

    const userDataDir = mkTempDir('universe-editor-e2e-pub-ud-')
    seedBaselineUserData(userDataDir)
    const repoDir = makeRepoWithUnpublishedBranch()

    // Launch with the repo pinned as the workspace — avoids the double extension-host
    // restart a post-boot openWorkspace incurs (workspace re-pin + trust flip).
    const app = await launchCoreGitApp({ userDataDir, extraArgs: [repoDir] })

    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() =>
        Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
      )
      await evaluateWhenRestored(page)

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'git extension should register a source control',
        })
        .toBeGreaterThan(0)

      // Opens the SCM container and expands the view holding the commit bar.
      await page.evaluate(() => window.__E2E__!.runCommand('_workbench.revealScm'))

      const publish = page.getByRole('button', { name: 'Publish Branch', exact: true })
      await expect(publish).toBeEnabled({ timeout: 30_000 })
      await publish.click()

      // Published and in sync now, so the bar shows the disabled Commit button.
      await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled({
        timeout: 30_000,
      })
      expect(git(repoDir, 'rev-parse', '--abbrev-ref', 'feature@{upstream}')).toBe('origin/feature')
    } finally {
      await closeApp(app)
    }
  })
})
