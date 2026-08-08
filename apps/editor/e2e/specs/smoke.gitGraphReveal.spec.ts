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
import { seedBaselineUserData } from '@universe-editor/e2e-harness'
import { closeApp, launchCoreGitApp } from '../fixtures/coreGitApp.js'
import { evaluateWhenRestored } from '../pages/WorkbenchPO.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
}

function makeUserDataDir(): string {
  const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-ggr-'))
  seedBaselineUserData(userDataDir)
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

/** A linear history of `count` commits built with one `git fast-import` spawn
 *  (per-commit `git commit` is far too slow for 500+ on CI Windows). */
function makeManyCommitsRepo(count: number): { repoDir: string; oldestHash: string } {
  const repoDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'universe-editor-e2e-ggr-page-')))
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
      // The graph's first load runs a git query after cold-boot extension
      // activation — well beyond the default expect timeout under parallel
      // suite load, so wait like the SCM/timeline steps above do. The bridge
      // selects the target row and scrolls it into view (the CSS module class
      // keeps its `rowSelected` local name in the bundle).
      const row = editor.locator(`[data-hash="${firstHash}"]`)
      await expect(row).toBeVisible({ timeout: 30_000 })
      await expect(row).toHaveClass(/rowSelected/, { timeout: 30_000 })
    } finally {
      await closeApp(app)
    }
  })

  test('pages in older history when the target commit is beyond the first page', async () => {
    test.setTimeout(120_000)

    const userDataDir = makeUserDataDir()
    // 520 commits: the oldest sits past the 500-commit first page, so the
    // reveal must page in more history before it can select + scroll.
    const { repoDir, oldestHash } = makeManyCommitsRepo(520)

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
        oldestHash,
      )

      const editor = page.locator('[data-testid="gitGraph-editor"]')
      await expect(editor).toBeVisible()
      const row = editor.locator(`[data-hash="${oldestHash}"]`)
      await expect(row).toHaveClass(/rowSelected/, { timeout: 30_000 })
      // The reveal must also have scrolled the paged-in row into view.
      await expect(row).toBeInViewport()
    } finally {
      await closeApp(app)
    }
  })

  test('focus lands on the commit list on open, arrows move, Enter focuses Commit Changes', async () => {
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
      const body = editor.locator('[data-testid="gitGraph-scrollBody"]')
      // Opening the tab routes focus into the row list (same slow-first-load
      // window as the reveal tests).
      await expect(body).toBeFocused({ timeout: 30_000 })

      // The first commit (HEAD, no uncommitted node in this repo) is selected
      // on open, with its changes pushed into the Commit Changes view.
      await expect(editor.locator(`[data-hash="${secondHash}"]`)).toHaveClass(/rowSelected/, {
        timeout: 30_000,
      })

      // Arrow keys move the selection from there with no prior mouse click.
      await page.keyboard.press('ArrowDown')
      await expect(editor.locator(`[data-hash="${firstHash}"]`)).toHaveClass(/rowSelected/)

      // Enter hands focus to the Commit Changes view's file tree.
      await page.keyboard.press('Enter')
      const tree = page.locator('[data-testid="commitChanges-view"] [role="tree"]')
      await expect(tree).toBeFocused({ timeout: 30_000 })
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
      // Same slow-first-load window as the first test: give the git query room.
      await expect(editor.locator(`[data-hash="${firstHash}"]`)).toHaveClass(/rowSelected/, {
        timeout: 30_000,
      })
    } finally {
      await closeApp(app)
    }
  })
})
