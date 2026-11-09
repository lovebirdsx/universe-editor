/*---------------------------------------------------------------------------------------------
 *  Regression guard: staging a multi-selection from the SCM changes list.
 *
 *  The renderer already forwarded `(primary, selection[])`, but `git.stage` only
 *  read the clicked row, so Ctrl-selecting several files and right-clicking
 *  Stage moved exactly one of them to the index. This drives the real UI end to
 *  end: select two working-tree rows, right-click one, run Stage Changes, and
 *  assert both files land in the index group.
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

/** Two committed files, both edited on disk so they show up as unstaged changes. */
function makeRepo(): string {
  // realpath.native: the raw mkdtemp path on CI Windows is an 8.3 short path.
  const repoDir = realpathSync.native(mkTempDir('universe-editor-e2e-scm-multi-'))
  git(repoDir, 'init')
  git(repoDir, 'config', 'user.email', 'e2e@example.com')
  git(repoDir, 'config', 'user.name', 'E2E')
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1\n', 'utf8')
  writeFileSync(join(repoDir, 'b.ts'), 'const b = 1\n', 'utf8')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'first')
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 2\n', 'utf8')
  writeFileSync(join(repoDir, 'b.ts'), 'const b = 2\n', 'utf8')
  return repoDir
}

test.describe('@p1 scm multi-select stage', () => {
  test('right-click Stage stages every selected change @regression', async () => {
    // Cold boot + git extension activation in a real repo is heavy on Windows CI.
    test.setTimeout(120_000)

    const userDataDir = mkTempDir('universe-editor-e2e-scm-multi-')
    seedBaselineUserData(userDataDir)
    const repoDir = makeRepo()

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

      await page.evaluate(() => window.__E2E__!.runCommand('workbench.view.scm'))
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getActiveViewContainerId(0)), {
          timeout: 30_000,
          message: 'the SCM container should be the active sidebar container',
        })
        .toBe('workbench.view.scm')

      const rowA = page.locator('[role="treeitem"]', { hasText: 'a.ts' })
      const rowB = page.locator('[role="treeitem"]', { hasText: 'b.ts' })
      await expect(rowA).toBeVisible({ timeout: 30_000 })
      await expect(rowB).toBeVisible({ timeout: 30_000 })

      // Ctrl-click both rows: the row handler toggles them into the selection
      // without opening a diff, so the tree keeps focus.
      await rowA.click({ modifiers: ['Control'] })
      await rowB.click({ modifiers: ['Control'] })
      const scmTree = page.locator('[role="tree"]').filter({ has: rowA }).first()
      await expect(scmTree.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(2)

      // Right-clicking a row inside the selection keeps the whole selection.
      await rowA.click({ button: 'right' })
      const menu = page.getByRole('menu')
      await expect(menu).toHaveCount(1)
      await menu.getByRole('menuitem', { name: 'Stage Changes' }).click()
      await expect(menu).toHaveCount(0)

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmGroupIdsForResource('a.ts')), {
          timeout: 30_000,
          message: 'a.ts should move into the index group',
        })
        .toEqual(['index'])
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmGroupIdsForResource('b.ts')), {
          timeout: 30_000,
          message: 'b.ts should move into the index group too',
        })
        .toEqual(['index'])
    } finally {
      await closeApp(app)
    }
  })
})
