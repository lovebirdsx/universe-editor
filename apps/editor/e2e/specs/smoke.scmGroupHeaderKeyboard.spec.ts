/*---------------------------------------------------------------------------------------------
 *  Regression guard: arrow-key navigation of the SCM tree must survive opening
 *  and closing the context menu on a *group header* (CHANGES / Staged Changes).
 *
 *  The group-header menu resolves to zero rows whenever no contribution matches
 *  the group's scope (e.g. Perforce's "Changes" group has no matching `when`).
 *  An empty menu renders nothing, but its window-capture keydown listener used
 *  to stay armed anyway: ArrowUp/ArrowDown were swallowed at the capture phase
 *  (Left/Right slipped through), leaving the tree dead to vertical keys until
 *  the whole view remounted. Empty menus now report the close immediately, so
 *  the listener unmounts with them.
 *
 *  This spec drives the non-empty git group menu through the real key dispatch
 *  chain — the precise empty-rows path is covered by the workbench-ui unit
 *  tests (ContextMenu.test.tsx / ListMenu.test.tsx), which is also where the
 *  regression was reproduced before the fix.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { seedBaselineUserData } from '@universe-editor/e2e-harness'
import { closeApp, launchCoreGitApp } from '../fixtures/coreGitApp.js'
import { evaluateWhenRestored } from '../pages/WorkbenchPO.js'

// After the workspace settles the workbench keeps a ~1.5s window in which it
// restores focus to the active editor (WorkspaceFocusRestoreContribution), so
// the first click on a row can lose the tree focus again. Same wait as
// smoke.scmKeyboardContextMenu.
const RESTORE_WINDOW_MS = 1700

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
}

/** One committed file, then edited on disk so it shows up as an unstaged change. */
function makeRepo(): string {
  // realpath.native: the raw mkdtemp path on CI Windows is an 8.3 short path.
  const repoDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'universe-editor-e2e-sgh-repo-')))
  git(repoDir, 'init')
  git(repoDir, 'config', 'user.email', 'e2e@example.com')
  git(repoDir, 'config', 'user.name', 'E2E')
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1\n', 'utf8')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'first')
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 2\n', 'utf8')
  return repoDir
}

test.describe('@p1 scm group header keyboard menu', () => {
  test('arrow keys keep moving tree focus after Shift+F10 on the Changes header @regression', async () => {
    // Cold boot + git extension activation in a real repo is heavy on Windows CI.
    test.setTimeout(120_000)

    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-sgh-'))
    seedBaselineUserData(userDataDir)
    const repoDir = makeRepo()

    // Launch with the repo pinned as the workspace — avoids the double
    // extension-host restart a post-boot openWorkspace incurs.
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

      // The Changes group header (label "Changes", rendered uppercase by CSS).
      const header = page.locator('[role="treeitem"]', { hasText: 'Changes' })
      const fileRow = page.locator('[role="treeitem"]', { hasText: 'a.ts' })
      await expect(fileRow).toBeVisible({ timeout: 30_000 })

      // Anchor the tree on the file row (a group-header click would toggle the
      // group collapsed and hide the row — ScmGroupRow.onClick → model.toggle).
      // Wait out the post-workspace focus-restore window, then put DOM focus on
      // the tree so the key presses are dispatched from the list, not the editor.
      await fileRow.click()
      const tree = page.locator('[role="tree"]').filter({ has: header }).first()
      await page.waitForTimeout(RESTORE_WINDOW_MS)
      await tree.focus()
      await expect(tree).toHaveAttribute('data-focused', 'true')

      // Arrow up to the group header: selection and focus move together.
      await page.keyboard.press('ArrowUp')
      await expect(header).toHaveAttribute('aria-selected', 'true')

      // Shift+F10 on the group header opens the group-level menu: keyboard-opened,
      // so the first entry is highlighted right away.
      const menu = page.getByRole('menu')
      await page.keyboard.press('Shift+F10')
      await expect(menu).toHaveCount(1)
      await expect(page.locator('[role="menuitem"][data-active]')).toHaveCount(1)

      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)

      // The regression: ArrowUp/ArrowDown were swallowed after the group-header
      // menu. They must move the tree selection between header and file row.
      await page.keyboard.press('ArrowDown')
      await expect(fileRow).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('ArrowUp')
      await expect(header).toHaveAttribute('aria-selected', 'true')
    } finally {
      await closeApp(app)
    }
  })
})
