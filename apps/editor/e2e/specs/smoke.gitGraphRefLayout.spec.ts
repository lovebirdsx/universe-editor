/*---------------------------------------------------------------------------------------------
 *  Git Graph ref-badge layout smoke test (@regression).
 *
 *  A long commit subject must give its row space up to the branch badges instead of
 *  squeezing them into ellipses: `.refs` takes no part in the row's shrink, so the
 *  subject is the only item that ellipsizes. Both the branch name and the subject
 *  are long enough that the row's flex line is genuinely over budget in the default
 *  1280x800 window — the "subject is truncated" assertion is what keeps the badge
 *  assertion from passing vacuously.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test'
import { writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { seedBaselineUserData, mkTempDir } from '@universe-editor/e2e-harness'
import { closeApp, launchCoreGitApp } from '../fixtures/coreGitApp.js'
import { evaluateWhenRestored } from '../pages/WorkbenchPO.js'

const LONG_BRANCH = 'testuser/long-branch-name'
const LONG_SUBJECT =
  'a deliberately long commit subject that has to yield its row space to the branch badges, because the subject is the one that ellipsizes once the row is over budget'

/** What the row's flex line did to the ref badges and to the subject, measured in
 *  the page. A badge whose text is wider than its own content box is the truncation
 *  the layout has to prevent — Chromium swaps the tail for an ellipsis on any
 *  overflow, so the comparison is sub-pixel: a whole pixel of slack would already
 *  hide a lost character. */
function measureRow(el: Element): {
  badges: { text: string; textWidth: number; contentWidth: number }[]
  message: { client: number; scroll: number }
} {
  const refs = el.querySelector('[data-testid="gitGraph-refs"]')!
  const message = el.querySelector('[data-testid="gitGraph-message"]') as HTMLElement
  return {
    badges: [...refs.children].map((child) => {
      const box = child as HTMLElement
      const style = getComputedStyle(box)
      const range = document.createRange()
      range.selectNodeContents(box)
      return {
        text: (box.textContent ?? '').trim(),
        textWidth: range.getBoundingClientRect().width,
        contentWidth:
          box.getBoundingClientRect().width -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight),
      }
    }),
    message: { client: message.clientWidth, scroll: message.scrollWidth },
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
}

function makeUserDataDir(): string {
  const userDataDir = mkTempDir('universe-editor-e2e-ggrl-')
  seedBaselineUserData(userDataDir)
  return userDataDir
}

/** One commit carrying both the default branch and {@link LONG_BRANCH}, so its row
 *  shows two head badges. */
function makeRepo(): { repoDir: string; hash: string } {
  // realpath.native: `git rev-parse --show-toplevel` returns the long canonical
  // path; the raw mkdtemp path on CI Windows is an 8.3 short path.
  const repoDir = realpathSync.native(mkTempDir('universe-editor-e2e-ggrl-repo-'))
  git(repoDir, 'init')
  git(repoDir, 'config', 'user.email', 'e2e@example.com')
  git(repoDir, 'config', 'user.name', 'E2E')
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1\n', 'utf8')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', LONG_SUBJECT)
  git(repoDir, 'checkout', '-b', LONG_BRANCH)
  return { repoDir, hash: git(repoDir, 'rev-parse', 'HEAD') }
}

test.describe('@p1 git graph ref layout', () => {
  test('a long subject ellipsizes instead of squeezing the branch badges @regression', async () => {
    // Cold boot + git extension activation in a real repo is heavy on Windows CI.
    test.setTimeout(120_000)

    const userDataDir = makeUserDataDir()
    const { repoDir, hash } = makeRepo()

    // Launch with the repo pinned as the workspace (positional arg → openWindowForFolder):
    // a post-boot openWorkspace would re-pin the workspace + flip trust, restarting the
    // extension host twice and re-activating git — pure startup waste.
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

      await page.evaluate((h) => window.__E2E__!.runCommand('_workbench.openGitGraph', h), hash)

      const editor = page.locator('[data-testid="gitGraph-editor"]')
      const row = editor.locator(`[data-hash="${hash}"]`)
      await expect(row).toHaveClass(/rowSelected/, { timeout: 30_000 })
      await expect(row).toBeInViewport()

      // `content-visibility: auto` reports zero widths until the row is laid out
      // (and a zero-width badge would trivially "fit"), so wait for the subject to
      // have claimed its floor — the message cannot render narrower than min-width.
      await expect
        .poll(
          () =>
            row.evaluate(
              (el) =>
                (el.querySelector('[data-testid="gitGraph-message"]') as HTMLElement).clientWidth,
            ),
          { timeout: 30_000, message: 'commit row should lay out' },
        )
        .toBeGreaterThanOrEqual(80)

      const { badges, message } = await row.evaluate(measureRow)

      const long = badges.find((badge) => badge.text === LONG_BRANCH)
      expect(long, `branch badge ${LONG_BRANCH} should be on the row`).toBeDefined()
      expect(long!.contentWidth).toBeGreaterThan(20)
      // The pressure that used to squeeze the badge — without it the check below is
      // no evidence at all.
      expect(message.scroll).toBeGreaterThan(message.client + 1)
      for (const badge of badges) {
        expect(
          badge.textWidth,
          `badge "${badge.text}" should show its whole name`,
        ).toBeLessThanOrEqual(badge.contentWidth + 0.01)
      }
    } finally {
      await closeApp(app)
    }
  })
})
