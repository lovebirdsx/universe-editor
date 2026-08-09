/*---------------------------------------------------------------------------------------------
 *  Git Graph Go to Symbol smoke test (@p1).
 *
 *  `workbench.action.gotoSymbol` (Ctrl+R) inside the Git Graph editor must list
 *  the loaded commits (searchable by subject and hash), and accepting one must
 *  select that row with full click semantics — pushing the COMMIT CHANGES view.
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
  const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-ggs-'))
  seedBaselineUserData(userDataDir)
  return userDataDir
}

/** Two commits touching a.ts: `first` (older) and `second`. */
function makeRepo(): { repoDir: string; firstHash: string; secondHash: string } {
  // realpath.native: `git rev-parse --show-toplevel` returns the long canonical
  // path; the raw mkdtemp path on CI Windows is an 8.3 short path.
  const repoDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'universe-editor-e2e-ggs-repo-')))
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

test.describe('@p1 git graph go to symbol', () => {
  test('lists commits and accepting one selects the row + opens Commit Changes', async () => {
    // Cold boot + git extension activation in a real repo is heavy on Windows CI.
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

      await page.evaluate(() => window.__E2E__!.runCommand('git-graph.view'))

      const editor = page.locator('[data-testid="gitGraph-editor"]')
      await expect(editor).toBeVisible()
      // The graph's first load runs a git query after cold-boot extension
      // activation; HEAD is selected once the rows land.
      await expect(editor.locator(`[data-hash="${secondHash}"]`)).toHaveClass(/rowSelected/, {
        timeout: 30_000,
      })

      // Real keystroke: inside the graph editor ctrl+r must hit gotoSymbol's
      // scoped twin binding, not the global Open Recent command.
      await page.keyboard.press('Control+R')
      const quickInput = page.getByTestId('quick-input')
      await quickInput.waitFor({ state: 'visible' })

      // Both commits are listed by subject, with hash · author · date detail.
      await expect(quickInput.getByRole('option', { name: /second/ })).toBeVisible()
      await expect(quickInput.getByRole('option', { name: /first/ })).toBeVisible()

      // The detail rides along as a keyword: typing the older commit's short
      // hash filters the list down to that commit.
      await page.keyboard.type(firstHash.slice(0, 7))
      await expect(quickInput.getByRole('option', { name: /first/ })).toBeVisible()
      await expect(quickInput.getByRole('option', { name: /second/ })).toBeHidden()

      // Accepting selects the row (full click semantics) and pushes COMMIT CHANGES.
      await page.keyboard.press('Enter')
      await quickInput.waitFor({ state: 'hidden' })
      await expect(editor.locator(`[data-hash="${firstHash}"]`)).toHaveClass(/rowSelected/)

      const view = page.locator('[data-testid="commitChanges-view"]')
      await expect(view.locator('[data-testid="commitChanges-title"]')).toContainText(
        firstHash.slice(0, 7),
        { timeout: 30_000 },
      )
    } finally {
      await closeApp(app)
    }
  })
})
