/*---------------------------------------------------------------------------------------------
 *  Git Graph reveal bridge smoke test (@p1).
 *
 *  `_workbench.openGitGraph <hash>` (the bridge timeline items and blame links
 *  call) must open the Git Graph editor and select + scroll to that commit.
 *  Setup: a real git repo with two commits; the reveal targets the older one
 *  so "selected" is distinguishable from the default HEAD selection.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { closeApp, launchCoreGitApp } from '../fixtures/coreGitApp.js'
import { evaluateWhenRestored } from '../pages/WorkbenchPO.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
}

function makeUserDataDir(): string {
  const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-ggr-'))
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ 'workbench.language': 'en-US', 'update.mode': 'manual' }, null, 2),
    'utf8',
  )
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({ 'welcome.agentOnboarding.seen': true }, null, 2),
    'utf8',
  )
  return userDataDir
}

/** Two commits touching a.ts: `first` (older) and `second`. */
function makeRepo(): { repoDir: string; firstHash: string; secondHash: string } {
  // realpath.native: `git rev-parse --show-toplevel` returns the long canonical
  // path; the raw mkdtemp path on CI Windows is an 8.3 short path.
  const repoDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'universe-editor-e2e-ggr-repo-')))
  git(repoDir, 'init')
  git(repoDir, 'config', 'user.email', 'e2e@example.com')
  git(repoDir, 'config', 'user.name', 'E2E')
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1\n', 'utf8')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'first')
  const firstHash = git(repoDir, 'rev-parse', 'HEAD')
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 2\n', 'utf8')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'second')
  const secondHash = git(repoDir, 'rev-parse', 'HEAD')
  return { repoDir, firstHash, secondHash }
}

test.describe('@p1 git graph reveal', () => {
  test('opens the graph at the requested commit via the _workbench bridge', async () => {
    // Cold boot + git extension activation in a real repo is heavy on Windows CI.
    test.setTimeout(120_000)

    const userDataDir = makeUserDataDir()
    const { repoDir, firstHash } = makeRepo()

    const app = await launchCoreGitApp({ userDataDir })

    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() =>
        Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
      )
      await evaluateWhenRestored(page)

      await page.evaluate((p) => window.__E2E__!.openWorkspace(p), repoDir)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'git extension should register a source control',
        })
        .toBeGreaterThan(0)

      await page.evaluate(
        (hash) => window.__E2E__!.runCommand('_workbench.openGitGraph', hash),
        firstHash,
      )

      const editor = page.locator('[data-testid="gitGraph-editor"]')
      await expect(editor).toBeVisible()
      // The bridge selects the target row and scrolls it into view (the CSS
      // module class keeps its `rowSelected` local name in the bundle).
      const row = editor.locator(`[data-hash="${firstHash}"]`)
      await expect(row).toBeVisible()
      await expect(row).toHaveClass(/rowSelected/)
    } finally {
      await closeApp(app)
    }
  })

  test('clicking a timeline row action selects that row before opening the graph', async () => {
    test.setTimeout(120_000)

    const userDataDir = makeUserDataDir()
    const { repoDir, firstHash, secondHash } = makeRepo()

    const app = await launchCoreGitApp({ userDataDir })

    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() =>
        Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
      )
      await evaluateWhenRestored(page)

      await page.evaluate((p) => window.__E2E__!.openWorkspace(p), repoDir)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'git extension should register a source control',
        })
        .toBeGreaterThan(0)

      // Open the file so the timeline follows it.
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), join(repoDir, 'a.ts'))

      // Timeline row keys are `<source>|<commit hash>` (hostTimeline.toItemDto).
      const row = (hash: string) => page.locator(`[data-row-key="git-history|${hash}"]`)
      await expect(row(secondHash)).toBeVisible({ timeout: 30_000 })
      await expect(row(firstHash)).toBeVisible()

      // Select the newer row first; the row click also opens its diff. Wait for
      // the diff editor to actually activate — the diff opens asynchronously, and
      // without this wait its late activation would steal focus from the graph
      // tab opened by the next step (inactive editors don't render their DOM).
      await row(secondHash).click()
      await expect(row(secondHash)).toHaveAttribute('aria-selected', 'true')
      await expect(page.locator('[data-testid="diff-editor"]')).toBeVisible({ timeout: 30_000 })

      // Clicking the older row's inline graph button must move the timeline
      // selection to that row (previously it stayed on the earlier selection).
      await row(firstHash).getByRole('button', { name: 'Open in Git Graph' }).click()
      await expect(row(firstHash)).toHaveAttribute('aria-selected', 'true')
      await expect(row(secondHash)).toHaveAttribute('aria-selected', 'false')

      const editor = page.locator('[data-testid="gitGraph-editor"]')
      await expect(editor).toBeVisible()
      await expect(editor.locator(`[data-hash="${firstHash}"]`)).toHaveClass(/rowSelected/)
    } finally {
      await closeApp(app)
    }
  })
})
