/*---------------------------------------------------------------------------------------------
 *  Git Graph ref-badge layout smoke test (@regression).
 *
 *  A long commit subject must give its row space up to the branch badges instead of
 *  squeezing them into ellipses: `.refs` takes no part in the row's shrink, so the subject
 *  is the only item that ellipsizes.
 *
 *  The row is deliberately not assumed to be wide, because CI is not always wide: the
 *  Windows runner's 1024x768 virtual screen clamps the 1280x800 default window, and `.refs`
 *  is capped at 55% of its column — two long branch names genuinely do not fit there and do
 *  get an ellipsis. That is the accepted rendering (the pill tooltip still names the whole
 *  ref, see GitGraphEditor.refBadges.test), not the regression this case guards.
 *
 *  What has to hold at any window width is what the fix introduced: how much room `.refs`
 *  gets cannot depend on how long the subject is. So the row is measured twice in one pass,
 *  the second time with the subject cut to a single character, and the two `.refs` widths
 *  must match — a residual `flex-shrink` on `.refs` is exactly what pulls them apart. The
 *  subject's own overflow stays asserted so the pair cannot match vacuously, and the
 *  per-badge "shows its whole name" check runs only while the badges fit the room `.refs`
 *  was allotted; when the column itself is the constraint that check is waived with the
 *  numbers logged rather than passing mute.
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

/** What the row's flex line did to the ref badges and to the subject, measured in the page.
 *  A badge whose text is wider than its own content box is the truncation the layout has to
 *  prevent — Chromium swaps the tail for an ellipsis on any overflow, so the comparison is
 *  sub-pixel: a whole pixel of slack would already hide a lost character.
 *
 *  `textWidth` comes from a Range over the badge's contents, which reports the text's layout
 *  boxes rather than what `overflow: hidden` painted: a badge that already lost its tail
 *  still measures its whole name. `refs.width` and `refs.widthWithShortSubject` are two
 *  reads of the same box with only the subject's length differing between them — the subject
 *  must not move `.refs` at all. `refs.naturalWidth` is what the badges want, which is what
 *  `.refs` would be without its own `max-width`. */
function measureRow(el: Element): {
  badges: { text: string; textWidth: number; contentWidth: number; naturalWidth: number }[]
  refs: { width: number; widthWithShortSubject: number; naturalWidth: number }
  column: number
  message: { client: number; scroll: number }
} {
  const refs = el.querySelector('[data-testid="gitGraph-refs"]') as HTMLElement
  const message = el.querySelector('[data-testid="gitGraph-message"]') as HTMLElement

  const contentBox = (box: HTMLElement): number => {
    const style = getComputedStyle(box)
    return (
      box.getBoundingClientRect().width -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight)
    )
  }

  const width = refs.getBoundingClientRect().width
  // The subject as React rendered it is a single text node. `nodeValue` (not `textContent`)
  // keeps that node's identity, so the restore below leaves no reconciler state pointing at
  // a detached node. The write dirties layout and the rect read flushes it synchronously —
  // nothing to wait for, and no chance for a re-render to slip between the two reads.
  const subject = message.firstChild
  if (subject?.nodeType !== Node.TEXT_NODE) {
    throw new Error('gitGraph-message should hold the subject as a single text node')
  }
  const realSubject = subject.nodeValue ?? ''
  subject.nodeValue = 'x'
  const widthWithShortSubject = refs.getBoundingClientRect().width
  subject.nodeValue = realSubject

  const badges = [...refs.children].map((child) => {
    const box = child as HTMLElement
    const style = getComputedStyle(box)
    const range = document.createRange()
    range.selectNodeContents(box)
    const textWidth = range.getBoundingClientRect().width
    return {
      text: (box.textContent ?? '').trim(),
      textWidth,
      contentWidth: contentBox(box),
      naturalWidth:
        textWidth +
        parseFloat(style.paddingLeft) +
        parseFloat(style.paddingRight) +
        parseFloat(style.borderLeftWidth) +
        parseFloat(style.borderRightWidth) +
        parseFloat(style.marginLeft) +
        parseFloat(style.marginRight),
    }
  })

  // Badges carry a `margin-right` today (`.refs` sets no `gap`); counting a gap if one is
  // ever added keeps the natural sum comparable to the width `.refs` is actually allotted.
  const gap = parseFloat(getComputedStyle(refs).columnGap) || 0
  return {
    badges,
    refs: {
      width,
      widthWithShortSubject,
      naturalWidth:
        badges.reduce((sum, badge) => sum + badge.naturalWidth, 0) +
        gap * Math.max(0, badges.length - 1),
    },
    column: contentBox(refs.parentElement as HTMLElement),
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

      const { badges, refs, column, message } = await row.evaluate(measureRow)

      const long = badges.find((badge) => badge.text === LONG_BRANCH)
      expect(long, `branch badge ${LONG_BRANCH} should be on the row`).toBeDefined()
      expect(long!.contentWidth).toBeGreaterThan(20)
      // The pressure that used to squeeze the badge. Without it the pair below could match
      // vacuously — a row that never laid out measures zero twice.
      expect(message.scroll).toBeGreaterThan(message.client + 1)

      // The invariant that holds at every window width: the subject's length must not change
      // how much room `.refs` gets. Goes red the moment `.refs` takes part in the row's
      // shrink again, whatever the row's budget happens to be.
      expect(
        Math.abs(refs.width - refs.widthWithShortSubject),
        `.refs must keep one width whatever the subject length is: ${refs.width}px with the ` +
          `real subject, ${refs.widthWithShortSubject}px with a one-character subject`,
      ).toBeLessThanOrEqual(0.01)

      // The badges only fit while `.refs` stays under its own `max-width`; a narrow column
      // clamps it first, and the ellipsis behind the tooltip is the accepted rendering there.
      if (refs.naturalWidth > refs.widthWithShortSubject + 1) {
        console.log(
          `[gitGraphRefLayout] badge-fits check waived: badges want ${refs.naturalWidth}px, ` +
            `.refs is allotted ${refs.widthWithShortSubject}px of a ${column}px column`,
        )
      } else {
        for (const badge of badges) {
          expect(
            badge.textWidth,
            `badge "${badge.text}" should show its whole name`,
          ).toBeLessThanOrEqual(badge.contentWidth + 0.01)
        }
      }
    } finally {
      await closeApp(app)
    }
  })
})
