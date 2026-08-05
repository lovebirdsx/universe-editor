/*---------------------------------------------------------------------------------------------
 *  Late git repository detection smoke test (@p1).
 *
 *  Opening a folder that is NOT a git repo, then running `git init` inside it,
 *  must bring the git SourceControl online without a window reload — mirroring
 *  VSCode's `onPossibleGitRepositoryChange` (a workspace-wide watcher reacts to
 *  a `.git` entry appearing). Guards the regression where the git extension
 *  decided "no repos" once at activation and never looked again.
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

    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })

    await expect.poll(() => workbench.getScmSourceControlCount(), { timeout: 30_000 }).toBe(1)
  })
})
