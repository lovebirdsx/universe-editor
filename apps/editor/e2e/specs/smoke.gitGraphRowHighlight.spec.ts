/*---------------------------------------------------------------------------------------------
 *  Git graph row highlight must not paint over the swimlane column (@regression).
 *
 *  `.graphSvg` is a positioned sibling *before* `.rows` (both `z-index: auto`), so
 *  it always paints under the rows: a full-width row background hid that row's own
 *  lane lines and node dot. The fill is now a gradient hard-stopped at
 *  `--graph-width`; this spec pins the resulting invariant in pixels, which is the
 *  only place it is visible (the DOM and the row box are identical either way):
 *
 *    - hovering or selecting a row changes no pixel inside the lane column, and
 *    - the description area to its right does change (the fill still paints).
 *
 *  Not a @visual baseline on purpose: the invariant is structural, needs no
 *  cross-OS baseline image, and holds on every theme.
 *--------------------------------------------------------------------------------------------*/

import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { seedBaselineUserData, mkTempDir } from '@universe-editor/e2e-harness'
import { closeApp, launchCoreGitApp } from '../fixtures/coreGitApp.js'
import { evaluateWhenRestored } from '../pages/WorkbenchPO.js'

// Forgiving threshold for the lane column: "unchanged" tolerates rasterizer noise.
const LANE_THRESHOLD = 0.1
// Any difference at all for the description area — the default theme's hover fill
// (#2f2f35 over #1a1a1c) sits below LANE_THRESHOLD, so a strict threshold is what
// makes "did the fill paint at all?" an answerable question.
const FILL_THRESHOLD = 0

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
}

function makeUserDataDir(): string {
  const userDataDir = mkTempDir('universe-editor-e2e-ggrh-')
  seedBaselineUserData(userDataDir)
  return userDataDir
}

/** Two commits touching a.ts: `first` (older) and `second` (HEAD). */
function makeRepo(): { repoDir: string; firstHash: string; secondHash: string } {
  // realpath.native: `git rev-parse --show-toplevel` returns the long canonical
  // path; the raw mkdtemp path on CI Windows is an 8.3 short path.
  const repoDir = realpathSync.native(mkTempDir('universe-editor-e2e-ggrh-repo-'))
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

interface Strip {
  x: number
  y: number
  width: number
  height: number
}

async function shoot(page: Page, strip: Strip): Promise<PNG> {
  // Full-page shot + crop, deliberately not `page.screenshot({ clip })`: under
  // this Electron setup the clipped capture hands back a stale surface — a strip
  // kept matching its own baseline while a full shot taken in the same state
  // showed the hover fill — which would make every comparison below vacuously
  // pass. Cropping is also where the bounds check lives.
  const shot = PNG.sync.read(await page.screenshot())
  if (strip.x + strip.width > shot.width || strip.y + strip.height > shot.height) {
    throw new Error(
      `strip ${JSON.stringify(strip)} falls outside the ${shot.width}×${shot.height} page`,
    )
  }
  const out = new PNG({ width: strip.width, height: strip.height })
  PNG.bitblt(shot, out, strip.x, strip.y, strip.width, strip.height, 0, 0)
  return out
}

function changedPixels(before: PNG, after: PNG, threshold: number): number {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(
      `strip size changed between shots: ${before.width}×${before.height} → ` +
        `${after.width}×${after.height}`,
    )
  }
  return pixelmatch(before.data, after.data, null, before.width, before.height, { threshold })
}

function distinctColours(png: PNG): number {
  const seen = new Set<number>()
  for (let i = 0; i < png.data.length; i += 4) {
    seen.add(
      (png.data[i]! << 24) | (png.data[i + 1]! << 16) | (png.data[i + 2]! << 8) | png.data[i + 3]!,
    )
  }
  return seen.size
}

test.describe('git graph row highlight', () => {
  test('hovering or selecting a row never paints over the swimlane column @regression', async () => {
    // Cold boot + git extension activation in a real repo is heavy on Windows CI.
    test.setTimeout(120_000)

    const userDataDir = makeUserDataDir()
    const { repoDir, firstHash, secondHash } = makeRepo()

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

      // Reveal the *older* commit: the default HEAD selection moves off the newer
      // row, so the row under experiment starts out unselected — which is what
      // makes the hover and the click below actual state changes.
      await page.evaluate(
        (hash) => window.__E2E__!.runCommand('_workbench.openGitGraph', hash),
        firstHash,
      )

      const editor = page.locator('[data-testid="gitGraph-editor"]')
      await expect(editor).toBeVisible()
      await expect(editor.locator(`[data-hash="${firstHash}"]`)).toHaveClass(/rowSelected/, {
        timeout: 30_000,
      })

      const row = editor.locator(`[data-hash="${secondHash}"]`)
      await expect(row).toBeVisible()

      const graphWidth = await row.evaluate((el) =>
        Number.parseFloat(getComputedStyle(el.parentElement!).getPropertyValue('--graph-width')),
      )
      expect(graphWidth).toBeGreaterThan(0)

      // The header is sticky and overlaps the scrollport once scrolled; a strip
      // that landed on it would compare two identical shots of the header forever.
      const header = await editor.locator('[data-testid="gitGraph-header"]').boundingBox()
      if (!header) throw new Error('git graph header has no bounding box')

      /** Fresh geometry every time: hovering and selecting can reflow the editor
       *  area, so a strip captured once and reused would silently drift. */
      const geometry = async () => {
        const box = await row.boundingBox()
        if (!box) throw new Error('commit row has no bounding box')
        expect(
          box.y,
          'the row must sit clear of the sticky header — otherwise this lane strip ' +
            'would be a slice of the header, which nothing here can change',
        ).toBeGreaterThanOrEqual(header.y + header.height)
        const x = Math.round(box.x)
        const y = Math.round(box.y)
        const height = Math.round(box.height)
        return {
          // 1px left / 2px right / 3px top and bottom keep the row borders, the
          // column's hard colour stop and the lane lines' row-to-row caps out of
          // the comparison.
          lane: { x: x + 1, y: y + 3, width: Math.round(graphWidth) - 3, height: height - 6 },
          text: { x: x + Math.round(graphWidth) + 4, y: y + 3, width: 160, height: height - 6 },
          // Centre of the lane column. Deliberately not `row.hover()` /
          // `row.click()`: those land on the row's centre, i.e. on the message
          // span, whose `onMouseEnter` fetches the full commit message.
          pointer: { x: x + graphWidth / 2, y: y + height / 2 },
        }
      }

      // Baseline: pointer parked outside the commit list.
      await page.mouse.move(0, 0)
      const baseline = await geometry()
      const laneBaseline = await shoot(page, baseline.lane)
      const textBaseline = await shoot(page, baseline.text)

      // Anti-vacuity: with no swimlanes drawn (wrong column width, empty graph)
      // both comparisons below would pass on a flat rectangle of background.
      expect(distinctColours(laneBaseline)).toBeGreaterThanOrEqual(2)

      // -- hover ------------------------------------------------------------
      const hover = await geometry()
      await page.mouse.move(hover.pointer.x, hover.pointer.y)
      // Polling the description area doubles as the repaint barrier: the lane
      // shot below only means something once the hover fill has actually landed
      // (a shot taken before the paint would trivially match the baseline).
      await expect
        .poll(
          async () =>
            changedPixels(textBaseline, await shoot(page, (await geometry()).text), FILL_THRESHOLD),
          { timeout: 10_000, message: 'hovering a row should repaint its description area' },
        )
        .toBeGreaterThan(0)
      expect(
        changedPixels(laneBaseline, await shoot(page, (await geometry()).lane), LANE_THRESHOLD),
        {
          message: 'hovering a row must leave its swimlane column untouched',
        },
      ).toBe(0)

      // -- selection --------------------------------------------------------
      await page.mouse.click(hover.pointer.x, hover.pointer.y)
      await expect(row).toHaveClass(/rowSelected/)
      await expect
        .poll(
          async () =>
            changedPixels(textBaseline, await shoot(page, (await geometry()).text), FILL_THRESHOLD),
          { timeout: 10_000, message: 'selecting a row should repaint its description area' },
        )
        .toBeGreaterThan(0)
      // Geometry is re-read above (per shot) and the sizes are compared, so a
      // reflow reads as a size failure rather than as changed pixels.
      expect(
        changedPixels(laneBaseline, await shoot(page, (await geometry()).lane), LANE_THRESHOLD),
        {
          message: 'selecting a row must leave its swimlane column untouched',
        },
      ).toBe(0)
    } finally {
      await closeApp(app)
    }
  })
})
