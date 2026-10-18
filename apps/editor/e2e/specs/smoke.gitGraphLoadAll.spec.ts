/*---------------------------------------------------------------------------------------------
 *  Git Graph "Load all commits" smoke test (@p0).
 *
 *  520 commits is one page + 20, so the paged view stops at 500 and the stream
 *  has to bring in the remaining 20. The assertion also covers virtualization:
 *  after the stream the oldest row is not mounted until End scrolls it into the
 *  window, and it must come out selected.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test'
import { realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { seedBaselineUserData, mkTempDir } from '@universe-editor/e2e-harness'
import { closeApp, launchCoreGitApp } from '../fixtures/coreGitApp.js'
import { evaluateWhenRestored } from '../pages/WorkbenchPO.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
}

function makeUserDataDir(): string {
  const userDataDir = mkTempDir('universe-editor-e2e-ggla-')
  seedBaselineUserData(userDataDir)
  return userDataDir
}

/** A linear history of `count` commits built with one `git fast-import` spawn. */
function makeManyCommitsRepo(count: number): { repoDir: string; oldestHash: string } {
  const repoDir = realpathSync.native(mkTempDir('universe-editor-e2e-ggla-repo-'))
  git(repoDir, 'init')
  git(repoDir, 'config', 'user.email', 'e2e@example.com')
  git(repoDir, 'config', 'user.name', 'E2E')
  const branch = git(repoDir, 'symbolic-ref', '--short', 'HEAD')
  const lines = ['blob', 'mark :1', 'data 2', 'a']
  for (let i = 1; i <= count; i++) {
    const message = `c${i}`
    lines.push(
      `commit refs/heads/${branch}`,
      `mark :${i + 1}`,
      `committer E2E <e2e@example.com> ${1700000000 + i} +0000`,
      `data ${message.length}`,
      message,
      ...(i > 1 ? [`from :${i}`] : []),
      'M 100644 :1 a.ts',
      '',
    )
  }
  lines.push('done', '')
  execFileSync('git', ['fast-import', '--done'], {
    cwd: repoDir,
    input: lines.join('\n'),
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  git(repoDir, 'reset', '--hard')
  const oldestHash = git(repoDir, 'rev-list', '--max-parents=0', 'HEAD')
  return { repoDir, oldestHash }
}

test.describe('@p0 git graph load all', () => {
  test('streams past the first page, then End reaches the oldest commit @p0', async () => {
    // Cold boot + git extension activation in a real repo is heavy on Windows CI.
    test.setTimeout(120_000)

    const userDataDir = makeUserDataDir()
    const { repoDir, oldestHash } = makeManyCommitsRepo(520)

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

      await page.evaluate(() => window.__E2E__!.runCommand('git-graph.view'))

      const editor = page.locator('[data-testid="gitGraph-editor"]')
      await expect(editor).toBeVisible()
      const count = editor.locator('[data-testid="gitGraph-commitCount"]')
      // The first page stops at 500 commits with more history available.
      await expect(count).toContainText('500 commits+', { timeout: 30_000 })
      await expect(editor.locator('[data-testid="gitGraph-loadAll"]')).toBeVisible()

      // Drive the command-palette entry rather than the footer button so the
      // registered Action2 path is covered too.
      await page.evaluate(() => window.__E2E__!.runCommand('git-graph.loadAll'))

      // Streaming finishes with the full count and hides both paging buttons.
      await expect(count).toContainText('520 commits', { timeout: 30_000 })
      await expect(count).not.toContainText('+')
      await expect(editor.locator('[data-testid="gitGraph-loadAll"]')).toHaveCount(0)
      await expect(editor.locator('[data-testid="gitGraph-loadMore"]')).toHaveCount(0)

      // 520 rows are windowed; the oldest row only exists once End scrolls it in.
      const body = editor.locator('[data-testid="gitGraph-scrollBody"]')
      await body.focus()
      await page.keyboard.press('End')
      const oldest = editor.locator(`[data-hash="${oldestHash}"]`)
      await expect(oldest).toBeVisible({ timeout: 30_000 })
      await expect(oldest).toHaveClass(/rowSelected/)
      await expect(oldest).toBeInViewport()
    } finally {
      await closeApp(app)
    }
  })
})
