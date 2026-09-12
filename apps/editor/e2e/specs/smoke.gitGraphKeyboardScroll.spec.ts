/*---------------------------------------------------------------------------------------------
 *  Git Graph keyboard scroll smoke (P1).
 *
 *  Guards the sticky-header occlusion bug: `.header` is the scroll container's
 *  first in-flow child and sticks to its top, so the row list starts one header
 *  height into the content. Chromium's `scrollIntoView({ block: 'nearest' })` —
 *  used by `useGraphKeyboardNav` to follow the selection — only compares against
 *  the scrollport rect and knows nothing about the overlay, so a row parked under
 *  the header counted as already visible: scrolling back up with the keyboard
 *  clamped `scrollTop` to the header height and the first row stayed hidden
 *  (the mouse wheel could still reach it, which is what made it look like the
 *  keyboard "stopped at the second row").
 *
 *  Setup: 120 commits (one `git fast-import`) — far more than a viewport's worth
 *  of 24px rows, so the list scrolls, and well under GIT_GRAPH_PAGE_SIZE so the
 *  whole history sits on the first page.
 *
 *  `toBeInViewport()` cannot see this: IntersectionObserver reports no occlusion,
 *  a fully covered row still comes back at ratio 1. The assertions therefore
 *  compare the first row's rect against the header's bottom edge, plus a hit test.
 *--------------------------------------------------------------------------------------------*/

import { test, expect, type Page } from '@playwright/test'
import { realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { seedBaselineUserData, mkTempDir } from '@universe-editor/e2e-harness'
import { closeApp, launchCoreGitApp } from '../fixtures/coreGitApp.js'
import { evaluateWhenRestored } from '../pages/WorkbenchPO.js'

const COMMITS = 120

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
}

function makeUserDataDir(): string {
  const userDataDir = mkTempDir('universe-editor-e2e-ggks-')
  seedBaselineUserData(userDataDir)
  return userDataDir
}

/** A linear history of `count` commits built with one `git fast-import` spawn
 *  (per-commit `git commit` is far too slow for hundreds of commits on CI Windows). */
function makeManyCommitsRepo(count: number): { repoDir: string } {
  // realpath.native: `git rev-parse --show-toplevel` returns the long canonical
  // path; the raw mkdtemp path on CI Windows is an 8.3 short path.
  const repoDir = realpathSync.native(mkTempDir('universe-editor-e2e-ggks-repo-'))
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
  return { repoDir }
}

interface GraphGeometry {
  readonly scrollTop: number
  readonly scrollRange: number
  readonly bodyTop: number
  readonly bodyBottom: number
  readonly headerBottom: number
  readonly rowTop: number
  readonly rowBottom: number
  /** The first row's centre point hits something else — i.e. it is covered. */
  readonly occluded: boolean
}

/** Scroll metrics plus the geometry of the DOM's first row (rows render in order,
 *  so the first `[data-hash]` is the topmost one). */
function readTopRowGeometry(page: Page): Promise<GraphGeometry> {
  return page.evaluate(() => {
    const body = document.querySelector('[data-testid="gitGraph-scrollBody"]') as HTMLElement | null
    const header = document.querySelector('[data-testid="gitGraph-header"]') as HTMLElement | null
    const row = body?.querySelector('[data-hash]') as HTMLElement | null
    if (!body || !header || !row) throw new Error('git graph geometry: rows not rendered')
    const b = body.getBoundingClientRect()
    const h = header.getBoundingClientRect()
    const r = row.getBoundingClientRect()
    // `.graphSvg` is pointer-events: none, so it cannot shadow the row here.
    const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)
    return {
      scrollTop: Math.round(body.scrollTop),
      scrollRange: Math.round(body.scrollHeight - body.clientHeight),
      bodyTop: b.top,
      bodyBottom: b.bottom,
      headerBottom: h.bottom,
      rowTop: r.top,
      rowBottom: r.bottom,
      occluded: hit !== null && hit !== row && !row.contains(hit),
    }
  })
}

/** The first row must be fully below the sticky header and inside the scrollport.
 *  1px tolerance for DPI rounding under Xvfb. */
function expectFirstRowBelowHeader(g: GraphGeometry, context: string): void {
  expect(g.scrollTop, `${context}: the view must be scrolled to the very top`).toBeLessThanOrEqual(
    1,
  )
  expect(
    g.headerBottom - g.rowTop,
    `${context}: the first row must sit below the sticky header, not behind it`,
  ).toBeLessThanOrEqual(1)
  expect(
    g.rowTop,
    `${context}: the first row must not be above the scrollport`,
  ).toBeGreaterThanOrEqual(g.bodyTop - 1)
  expect(
    g.rowBottom,
    `${context}: the first row must fit inside the scrollport`,
  ).toBeLessThanOrEqual(g.bodyBottom + 1)
  expect(g.occluded, `${context}: a hit test on the first row must reach the row`).toBe(false)
}

test.describe('@p1 git graph keyboard scroll', () => {
  test('Home brings the first row out from under the sticky header @regression', async () => {
    // Cold boot + git extension activation in a real repo is heavy on Windows CI.
    test.setTimeout(120_000)

    const userDataDir = makeUserDataDir()
    const { repoDir } = makeManyCommitsRepo(COMMITS)

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

      await page.evaluate(() => window.__E2E__!.runCommand('git-graph.view'))

      const editor = page.locator('[data-testid="gitGraph-editor"]')
      await expect(editor).toBeVisible()
      const body = editor.locator('[data-testid="gitGraph-scrollBody"]')
      // Opening the tab routes focus into the row list (same slow-first-load
      // window as the reveal tests).
      await expect(body).toBeFocused({ timeout: 30_000 })

      // The list has to scroll at all, otherwise there is nothing to come back from.
      await expect
        .poll(async () => (await readTopRowGeometry(page)).scrollRange, {
          timeout: 30_000,
          message: `${COMMITS} rows should overflow the viewport`,
        })
        .toBeGreaterThan(400)

      // Keyboard only: all the way down, then Home back to the first row.
      await page.keyboard.press('End')
      await expect
        .poll(async () => {
          const g = await readTopRowGeometry(page)
          return g.scrollRange - g.scrollTop
        })
        .toBeLessThanOrEqual(2)

      await page.keyboard.press('Home')
      expectFirstRowBelowHeader(await readTopRowGeometry(page), 'after Home')

      // Arrows must keep it visible too: one row down and back up.
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowUp')
      expectFirstRowBelowHeader(await readTopRowGeometry(page), 'after ArrowDown/ArrowUp')
    } finally {
      await closeApp(app)
    }
  })
})
