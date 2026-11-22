/*---------------------------------------------------------------------------------------------
 *  Late git repository detection smoke test (@p1).
 *
 *  Opening a folder that is NOT a git repo, then running `git init` inside it,
 *  must bring the git SourceControl online without a window reload — mirroring
 *  VSCode's `onPossibleGitRepositoryChange` (a workspace-wide watcher reacts to
 *  a `.git` entry appearing). Guards the regression where the git extension
 *  decided "no repos" once at activation and never looked again.
 *
 *  Also pins the other half of that switch: in a folder with no repository the
 *  contributed `Git:` commands are absent from the palette and the `ctrl+alt+g`
 *  keybinding is filtered out (`gitHasRepository`), instead of offering rows
 *  that die with "Contributed command '...' does not exist.".
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { test, expect } from '../fixtures/coreGitApp.js'

test.describe('@p1 git late repository detection', () => {
  test.use({
    workspaceSeeder: {
      seed(dir: string) {
        writeFileSync(join(dir, 'a.ts'), 'const a = 1\n', 'utf8')
      },
    },
  })

  test('detects git init in an already-open folder without a window reload', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    // Cold boot + git extension activation is heavy on Windows CI.
    test.setTimeout(120_000)
    const dir = launchWorkspace!.dir

    // Boot with no repo: no SourceControl is registered yet.
    await expect.poll(() => workbench.getScmSourceControlCount()).toBe(0)

    // Wait for the git extension's no-repo stub to become executable. Activation
    // registers the stub and arms the workspace watcher in one synchronous pass,
    // so once the renderer can run the stub the watcher is guaranteed in place —
    // `git init` can't slip into the gap between scan and watch.
    await expect
      .poll(async () => {
        try {
          await workbench.runCommand('git.getHeadContent')
          return true
        } catch {
          return false
        }
      })
      .toBe(true)

    // The manifest must reach the renderer before "no palette row" means
    // anything: the contributed-command proxy (and with it the palette entry) is
    // created at translation time, and every assertion here would also hold
    // against an extension host that had not started yet.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.hasCommand('git.deleteWorktree')), {
        timeout: 60_000,
      })
      .toBe(true)

    // Explicit `false` (not "unset"): a stale `true` left by a previous
    // activation would leave the palette open — the other half of the bug.
    await expect
      .poll(() => workbench.getContextKey('gitHasRepository'), { timeout: 30_000 })
      .toBe(false)

    const rows = workbench.quickInput.dialog.getByRole('option')
    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.showCommands'))
    await workbench.quickInput.waitForVisible()
    // The list itself must be alive before "zero rows" means the gate fired: an
    // empty list would satisfy the count below for an unrelated reason.
    await expect(rows.first()).toBeVisible()
    await page.keyboard.type('Delete Worktree')
    await expect(rows).toHaveCount(0)
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()

    // The keybinding's `when` filters it out too.
    const before = await page.evaluate(() => window.__E2E__!.traceKeybinding('ctrl+alt+g'))
    expect(before.candidates.find((c) => c.command === 'git.refresh')?.whenMatched).toBe(false)

    // Executed anyway (a keybinding, another extension, a probe): the host owns
    // no handler, and that — not a host allowlist rule — is what the caller is told.
    await expect(workbench.runCommand('git.deleteWorktree')).rejects.toThrow(
      /Contributed command 'git\.deleteWorktree' does not exist\./,
    )

    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })

    // The provider registers inside `setupRepositories`; the gate is written
    // after it returns — poll both, in that order.
    await expect.poll(() => workbench.getScmSourceControlCount(), { timeout: 30_000 }).toBe(1)
    await expect
      .poll(() => workbench.getContextKey('gitHasRepository'), { timeout: 30_000 })
      .toBe(true)

    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.showCommands'))
    await workbench.quickInput.waitForVisible()
    await page.keyboard.type('Delete Worktree')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(/Delete Worktree/i)
    await page.keyboard.press('Escape')
    await workbench.quickInput.waitForHidden()

    const after = await page.evaluate(() => window.__E2E__!.traceKeybinding('ctrl+alt+g'))
    expect(after.kind).toBe('execute')
    expect(after.command).toBe('git.refresh')
  })

  test('clears the gate when switching from a repository to a plain folder', async ({
    workbench,
    launchWorkspace,
    scratchDir,
  }) => {
    test.setTimeout(120_000)
    const dir = launchWorkspace!.dir

    await expect
      .poll(async () => {
        try {
          await workbench.runCommand('git.getHeadContent')
          return true
        } catch {
          return false
        }
      })
      .toBe(true)

    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
    await expect
      .poll(() => workbench.getContextKey('gitHasRepository'), { timeout: 30_000 })
      .toBe(true)

    const plainDir = scratchDir('universe-editor-e2e-git-plain-').replace(/\\/g, '/')
    await workbench.openWorkspace(plainDir)

    // The old value was `true`, so a `false` here can only come from the new
    // host's activation clearing it (the renderer's root context survives the
    // host restart).
    await expect
      .poll(() => workbench.getContextKey('gitHasRepository'), { timeout: 60_000 })
      .toBe(false)
    await expect.poll(() => workbench.getScmSourceControlCount(), { timeout: 30_000 }).toBe(0)
  })
})
