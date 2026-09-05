/*---------------------------------------------------------------------------------------------
 *  Regression guard: the SCM changes list's keyboard-opened context menu must be
 *  keyboard-driveable.
 *
 *  The ContextMenu key always opened *a* menu here — but the SCM rows rendered
 *  the mouse-only overflow popup (built for the title bar's `…` button), which
 *  had no arrow-key navigation, no Enter, and no active row. So the menu
 *  appeared and then swallowed every key, and the only way out was the mouse.
 *  The rows now render the shared workbench-ui ContextMenu, like the Explorer.
 *
 *  Both keys go through the real dispatch chain on purpose: Escape is the second
 *  half of the fix (the old popup listened on document *bubble*, where the
 *  workbench keybinding dispatcher had already stopped propagation), so it must
 *  be a real key press rather than a runCommand shortcut.
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
// smoke.explorerKeyboardContextMenu.
const RESTORE_WINDOW_MS = 1700

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
}

/** One committed file, then edited on disk so it shows up as an unstaged change. */
function makeRepo(): string {
  // realpath.native: the raw mkdtemp path on CI Windows is an 8.3 short path.
  const repoDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'universe-editor-e2e-skcm-repo-')))
  git(repoDir, 'init')
  git(repoDir, 'config', 'user.email', 'e2e@example.com')
  git(repoDir, 'config', 'user.name', 'E2E')
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1\n', 'utf8')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'first')
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 2\n', 'utf8')
  return repoDir
}

test.describe('@p1 scm keyboard context menu', () => {
  test('ContextMenu key opens a menu the arrow keys and Enter drive @regression', async () => {
    // Cold boot + git extension activation in a real repo is heavy on Windows CI.
    test.setTimeout(120_000)

    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-skcm-'))
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

      const row = page.locator('[role="treeitem"]', { hasText: 'a.ts' })
      await expect(row).toBeVisible({ timeout: 30_000 })

      // Click selects the row — and opens its diff, which takes focus (an SCM row
      // click is not a preserve-focus preview like the Explorer's). So wait out
      // the post-workspace focus-restore window, then put DOM focus back on the
      // tree: the key press has to be dispatched from the list, not the editor.
      await row.click()
      const tree = page.locator('[role="tree"]').filter({ has: row }).first()
      await page.waitForTimeout(RESTORE_WINDOW_MS)
      await tree.focus()
      await expect(tree).toHaveAttribute('data-focused', 'true')

      const menu = page.getByRole('menu')

      await page.keyboard.press('ContextMenu')
      await expect(menu).toHaveCount(1)
      // Row-level menu, not the title overflow: the row-gated git entries are here.
      await expect(menu.getByRole('menuitem', { name: 'Stage Changes' })).toBeVisible()

      // A keyboard-opened menu highlights its first entry right away (VSCode
      // parity) — there is no pointer to aim, so Enter must work immediately.
      // The highlight is a virtual focus (aria-activedescendant + data-active)
      // rather than DOM focus, which would blur the tree underneath.
      const active = page.locator('[role="menuitem"][data-active]')
      await expect(active).toHaveCount(1)
      await expect(active).toHaveText('Stage Changes')
      await expect(menu).toHaveAttribute('aria-activedescendant', /.+/)

      // The arrow keys step on from that opening highlight — and the menu must
      // survive the keypress. It used to unmount here: the row's scoped context
      // service had been emptied by StrictMode's dry run, and the re-render the
      // key triggered re-resolved the menu to zero rows.
      await page.keyboard.press('ArrowDown')
      await expect(menu).toHaveCount(1)
      await expect(active).toHaveCount(1)
      await expect(active).not.toHaveText('Stage Changes')

      // Escape closes it — the old popup listened on document bubble, where the
      // workbench keybinding dispatcher had already stopped propagation.
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)

      // Reopen and run the opening highlight straight away: no arrow key first.
      await page.keyboard.press('ContextMenu')
      await expect(menu).toHaveCount(1)
      await expect(page.locator('[role="menuitem"][data-active]')).toHaveText('Stage Changes')
      await page.keyboard.press('Enter')
      await expect(menu).toHaveCount(0)

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmGroupIdsForResource('a.ts')), {
          timeout: 30_000,
          message: 'Enter on "Stage Changes" should move the file into the index group',
        })
        .toEqual(['index'])
    } finally {
      await closeApp(app)
    }
  })
})
