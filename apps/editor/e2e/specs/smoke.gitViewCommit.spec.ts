/*---------------------------------------------------------------------------------------------
 *  "Open Commit" smoke test (@p1).
 *
 *  `git.viewCommit <uri> <hash>` (the timeline/blame entry point) must surface
 *  the sidebar "Commit Changes" view with the commit's title and one file row
 *  per changed file; clicking a file row opens that file's diff editor. The
 *  timeline row's inline "Open Commit" button drives the same view through
 *  `git.timeline.viewCommit`, and clicking a commit row in the Git Graph
 *  (Ctrl+click two rows to compare) updates the view from the graph side.
 *  Setup: a real git repo whose second commit touches two files.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { seedBaselineUserData } from '@universe-editor/e2e-harness'
import { closeApp, launchCoreGitApp } from '../fixtures/coreGitApp.js'
import { evaluateWhenRestored } from '../pages/WorkbenchPO.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
}

function makeUserDataDir(): string {
  const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-gvc-'))
  seedBaselineUserData(userDataDir)
  return userDataDir
}

/** Two commits; `second` touches both a.ts and b.ts (2-file commit changes). */
function makeRepo(): { repoDir: string; firstHash: string; secondHash: string } {
  // realpath.native: the raw mkdtemp path on CI Windows is an 8.3 short path.
  const repoDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'universe-editor-e2e-gvc-repo-')))
  git(repoDir, 'init')
  git(repoDir, 'config', 'user.email', 'e2e@example.com')
  git(repoDir, 'config', 'user.name', 'E2E')
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1\n', 'utf8')
  writeFileSync(join(repoDir, 'b.ts'), 'const b = 1\n', 'utf8')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'first')
  const firstHash = git(repoDir, 'rev-parse', 'HEAD')
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 2\n', 'utf8')
  writeFileSync(join(repoDir, 'b.ts'), 'const b = 2\n', 'utf8')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'second')
  const secondHash = git(repoDir, 'rev-parse', 'HEAD')
  return { repoDir, firstHash, secondHash }
}

test.describe('@p1 git view commit', () => {
  test('git.viewCommit surfaces the Commit Changes view with one row per changed file', async () => {
    // Cold boot + git extension activation in a real repo is heavy on Windows CI.
    test.setTimeout(120_000)

    const userDataDir = makeUserDataDir()
    const { repoDir, secondHash } = makeRepo()

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

      await page.evaluate(
        ({ uri, hash }) => window.__E2E__!.runCommand('git.viewCommit', uri, hash),
        { uri: `file:///${join(repoDir, 'a.ts').replace(/\\/g, '/')}`, hash: secondHash },
      )

      const view = page.locator('[data-testid="commitChanges-view"]')
      await expect(view).toBeVisible({ timeout: 30_000 })
      // The SCM container must be activated in the SideBar (location 0) —
      // probe-based, Allotment.Pane CSS visibility would misjudge DOM.
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveViewContainerId(0)), {
          message: 'the SCM container should be the active sidebar container',
        })
        .toBe('workbench.view.scm')
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              window.__E2E__!.getViewCollapsed('workbench.view.scm.commitChanges'),
            ),
          {
            message: 'the Commit Changes view should be expanded',
          },
        )
        .toBe(false)

      // Title carries the short hash; the second commit edited two files.
      await expect(view.locator('[data-testid="commitChanges-title"]')).toContainText(
        secondHash.slice(0, 7),
      )
      await expect(view.locator('[data-row-key^="file:"]')).toHaveCount(2)

      // Clicking a file row opens that file's diff editor.
      await view.locator('[data-row-key="file:a.ts"]').click()
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
          timeout: 30_000,
          message: 'clicking a file row should open the diff editor',
        })
        .toBe('diff')
    } finally {
      await closeApp(app)
    }
  })

  test('timeline row inline "Open Commit" button surfaces the same view', async () => {
    test.setTimeout(120_000)

    const userDataDir = makeUserDataDir()
    const { repoDir, secondHash } = makeRepo()

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

      // Open the file so the timeline follows it.
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), join(repoDir, 'a.ts'))

      // Timeline row keys are `<source>|<commit hash>` (hostTimeline.toItemDto).
      const row = page.locator(`[data-row-key="git-history|${secondHash}"]`)
      await expect(row).toBeVisible({ timeout: 30_000 })

      await row.getByRole('button', { name: 'Open Commit' }).click()

      const view = page.locator('[data-testid="commitChanges-view"]')
      await expect(view).toBeVisible({ timeout: 30_000 })
      await expect(view.locator('[data-testid="commitChanges-title"]')).toContainText(
        secondHash.slice(0, 7),
      )
      await expect(view.locator('[data-row-key^="file:"]')).toHaveCount(2)
    } finally {
      await closeApp(app)
    }
  })

  test('clicking a commit row in the Git Graph surfaces the view; Ctrl+click compares', async () => {
    test.setTimeout(120_000)

    const userDataDir = makeUserDataDir()
    const { repoDir, firstHash, secondHash } = makeRepo()

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

      await page.evaluate(
        (hash) => window.__E2E__!.runCommand('_workbench.openGitGraph', hash),
        secondHash,
      )

      const editor = page.locator('[data-testid="gitGraph-editor"]')
      await expect(editor).toBeVisible()
      // The graph's first load runs a git query after cold-boot extension
      // activation — well beyond the default expect timeout.
      const secondRow = editor.locator(`[data-hash="${secondHash}"]`)
      const firstRow = editor.locator(`[data-hash="${firstHash}"]`)
      await expect(secondRow).toBeVisible({ timeout: 30_000 })

      const view = page.locator('[data-testid="commitChanges-view"]')
      const title = view.locator('[data-testid="commitChanges-title"]')

      // Plain click on a commit row surfaces its changes in the sidebar view.
      // (The reveal above pre-selected `secondHash`, so click the other row —
      // clicking the selected row would toggle the selection off.)
      await firstRow.click()
      await expect(title).toContainText(firstHash.slice(0, 7), { timeout: 30_000 })
      await expect(view.locator('[data-row-key^="file:"]')).toHaveCount(2)

      // Ctrl+click a second row compares the two commits (title shows "↔").
      await secondRow.click({ modifiers: ['Control'] })
      await expect(title).toContainText('↔', { timeout: 30_000 })
    } finally {
      await closeApp(app)
    }
  })
})
