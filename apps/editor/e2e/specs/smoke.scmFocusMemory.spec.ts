/*---------------------------------------------------------------------------------------------
 *  Returning to the SCM view restores the focus context instead of always
 *  grabbing the commit box: the tree region survives a trip to the editor, the
 *  focused file row is restored, and the AI commit-message bridge still forces
 *  the input. Exercises the real LayoutService.focusView polling path.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/coreGitApp.js'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] })
}

/** Base commit tracks all three files; only a.ts and b.ts are then modified. */
function seedRepo(dir: string): void {
  git(dir, 'init')
  git(dir, 'config', 'user.email', 'e2e@example.com')
  git(dir, 'config', 'user.name', 'E2E')
  writeFileSync(join(dir, 'a.ts'), 'const a = 1\n', 'utf8')
  writeFileSync(join(dir, 'b.ts'), 'const b = 1\n', 'utf8')
  writeFileSync(join(dir, 'clean.ts'), 'const clean = 1\n', 'utf8')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')
  writeFileSync(join(dir, 'a.ts'), 'const a = 2\n', 'utf8')
  writeFileSync(join(dir, 'b.ts'), 'const b = 2\n', 'utf8')
}

test.describe('@p1 SCM focus memory', () => {
  test.use({
    workspaceSeeder: {
      seed(dir: string) {
        seedRepo(dir)
      },
    },
  })

  test('restores the tree region and the focused file row; AI still forces the input', async ({
    workbench,
    page,
    launchWorkspace,
  }) => {
    test.setTimeout(120_000)
    if (!launchWorkspace) throw new Error('workspaceSeeder must provide launchWorkspace')

    await workbench.waitForRestored()
    await expect
      .poll(() => workbench.getScmSourceControlCount(), {
        timeout: 60_000,
        message: 'git extension should register a source control',
      })
      .toBeGreaterThan(0)

    const cleanPath = join(launchWorkspace.dir, 'clean.ts')
    const openClean = async (): Promise<void> => {
      await page.evaluate((path) => window.__E2E__!.openFileUri(path), cleanPath)
      await workbench.focusActiveEditorGroup()
    }

    // Enter SCM from the editor with no matching changes: falls back to the
    // commit input on a fresh session.
    await openClean()
    await workbench.runCommand('workbench.view.scm')

    const sideBar = page.locator('[data-testid="part-sidebar"]')
    const commitInput = sideBar.locator('textarea')
    const scmTree = sideBar.locator('[role="tree"]')
    const rowB = sideBar.locator('[role="treeitem"]').filter({ hasText: 'b.ts' })
    const rowA = sideBar.locator('[role="treeitem"]').filter({ hasText: 'a.ts' })

    await expect(commitInput).toBeFocused({ timeout: 10_000 })
    await expect(rowB).toHaveCount(1, { timeout: 60_000 })

    // A plain row click also opens the row's diff, and focus intentionally
    // follows into the editor (see smoke.scmKeyboardContextMenu). The tree is
    // focused only for the instant between mousedown and that async open, so
    // wait for the navigation instead of asserting the tree kept focus.
    await rowB.click()
    await expect
      .poll(() => workbench.getActiveEditorUri(), {
        timeout: 10_000,
        message: 'clicking an SCM row should open its diff',
      })
      .toContain('b.ts')
    await openClean()

    await workbench.runCommand('workbench.view.scm')
    await expect(scmTree).toBeFocused({ timeout: 10_000 })
    await expect(rowB).toHaveAttribute('aria-selected', 'true')
    await expect(rowA).toHaveAttribute('aria-selected', 'false')

    // The input region is remembered too.
    await commitInput.click()
    await expect(commitInput).toBeFocused()
    await openClean()

    await workbench.runCommand('workbench.view.scm')
    await expect(commitInput).toBeFocused({ timeout: 10_000 })

    // The AI bridge explicitly asks for the commit input even with a tree focus.
    // Focus the tree directly: a plain row click would open b's diff and hand
    // focus to the editor before the bridge runs.
    await scmTree.focus()
    await expect(scmTree).toBeFocused()
    await workbench.runCommand('_workbench.revealScm')
    await expect(commitInput).toBeFocused({ timeout: 10_000 })
  })
})
