/*---------------------------------------------------------------------------------------------
 *  Smoke spec: crossing the virtualization threshold keeps the scroll position (P1).
 *
 *  Regression guard for the Explorer "viewport jumps around when I click a
 *  folder" report. <Tree> used to swap its scroll container when the visible-row
 *  count crossed `workbench.tree.virtualizationThreshold` (200): below it the
 *  root `[role="tree"]` div owned the scrollbar, above it the VirtualList's
 *  inner div did. The new container started at scrollTop 0, so a user scrolled
 *  far down saw the viewport snap to the top on every click that pushed the
 *  count over the threshold — and again on the click that pushed it back under.
 *
 *  The tree root is now always the scroll container and the threshold only
 *  decides whether rows are windowed, so both crossings are asserted against the
 *  same element.
 *
 *  Second guard, same symptom, different cause: the tree seeds its keyboard
 *  cursor onto the workspace root the first time it receives DOM focus. That
 *  used to fire onReveal, scrolling the root row (the very top) into view — so
 *  the first click anywhere in a scrolled tree yanked the viewport up.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'

// Row budget is what this spec is about, so it is spelled out:
//   1 root + 40 dirs + 1 target dir + 140 files = 182 rows collapsed (not
//   windowed), 212 with the target expanded (windowed). Directories sort before
//   files, and `t-var` sorts after `f-*`, so the target lands at row index 41 —
//   comfortably inside the scrolled viewport at scrollTop 800.
const DIR_COUNT = 40
const FILE_COUNT = 140
const TARGET_DIR = 't-var'
const TARGET_CHILDREN = 30
const SCROLL_TOP = 800
const COLLAPSED_ROWS = 1 + DIR_COUNT + 1 + FILE_COUNT

interface ScrollProbe {
  readonly top: number
  readonly windowed: boolean
}

/**
 * The tree root owns the scroll position in every mode — that invariant is half
 * of what this spec guards, so it is read directly rather than discovered.
 * Windowing is inferred from the row count: below the threshold every row is in
 * the DOM, above it only the visible slice is.
 */
async function readScroll(page: Page): Promise<ScrollProbe | null> {
  return page.evaluate(() => {
    const tree = document.querySelector<HTMLElement>('[role="tree"]')
    if (!tree) return null
    const rows = tree.querySelectorAll('[role="treeitem"]').length
    return { top: tree.scrollTop, windowed: rows < 100 }
  })
}

async function setScroll(page: Page, top: number): Promise<void> {
  await page.evaluate((value) => {
    const tree = document.querySelector<HTMLElement>('[role="tree"]')
    if (tree) tree.scrollTop = value
  }, top)
}

async function seedWorkspace(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-threshold-'))
  await Promise.all([
    // Each filler dir holds one file so it renders a twistie but stays collapsed.
    ...Array.from({ length: DIR_COUNT }, async (_, i) => {
      const dir = path.join(tmpDir, `f-${String(i).padStart(2, '0')}`)
      await fs.mkdir(dir)
      await fs.writeFile(path.join(dir, 'inner.txt'), 'x')
    }),
    ...Array.from({ length: FILE_COUNT }, (_, i) =>
      fs.writeFile(path.join(tmpDir, `file-${String(i).padStart(3, '0')}.txt`), 'x'),
    ),
    (async () => {
      const dir = path.join(tmpDir, TARGET_DIR)
      await fs.mkdir(dir)
      await Promise.all(
        Array.from({ length: TARGET_CHILDREN }, (_, i) =>
          fs.writeFile(path.join(dir, `child-${String(i).padStart(2, '0')}.txt`), 'x'),
        ),
      )
    })(),
  ])
  return tmpDir
}

async function openSeededWorkspace(
  workbench: { waitForRestored(): Promise<void>; openWorkspace(dir: string): Promise<unknown> },
  page: Page,
): Promise<string> {
  const tmpDir = await seedWorkspace()
  await workbench.waitForRestored()
  await workbench.openWorkspace(tmpDir)

  const rows = page.locator('[role="treeitem"]')
  await expect(rows.first()).toBeVisible({ timeout: 10000 })
  // All 182 rows are in the DOM below the threshold — wait for the full set so
  // the row count is settled before we measure anything.
  await expect.poll(() => rows.count(), { timeout: 10000 }).toBe(COLLAPSED_ROWS)
  await expect.poll(() => readScroll(page).then((s) => s?.windowed), { timeout: 5000 }).toBe(false)

  return tmpDir
}

test.describe('@p1 explorer virtualization threshold scroll', () => {
  test('expanding and collapsing across the threshold keeps the scroll position @regression', async ({
    workbench,
    page,
  }) => {
    const tmpDir = await openSeededWorkspace(workbench, page)

    await setScroll(page, SCROLL_TOP)
    await expect
      .poll(() => readScroll(page).then((s) => s?.top), { timeout: 5000 })
      .toBe(SCROLL_TOP)

    // Expand: 182 → 212 rows, crossing into windowed rendering.
    const targetRow = page.locator('[role="treeitem"]', { hasText: TARGET_DIR })
    await targetRow.click()

    await expect
      .poll(() => readScroll(page), { timeout: 10000 })
      .toEqual({ top: SCROLL_TOP, windowed: true })

    // Collapse: 212 → 182 rows, crossing back out. The row is already the sole
    // selection + focus, so setSelection early-returns and no reveal competes.
    await page.locator('[role="treeitem"]', { hasText: TARGET_DIR }).first().click()

    await expect
      .poll(() => readScroll(page), { timeout: 10000 })
      .toEqual({ top: SCROLL_TOP, windowed: false })

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  test('first focus of the tree does not scroll to the root row @regression', async ({
    workbench,
    page,
  }) => {
    const tmpDir = await openSeededWorkspace(workbench, page)

    await setScroll(page, 700)
    await expect.poll(() => readScroll(page).then((s) => s?.top), { timeout: 5000 }).toBe(700)

    // Click inside the tree body. The mousedown focuses the container, which
    // seeds the keyboard cursor onto the workspace root — that must not scroll.
    await page
      .locator('[role="tree"]')
      .first()
      .click({ position: { x: 30, y: 200 } })

    await expect.poll(() => readScroll(page).then((s) => s?.top), { timeout: 5000 }).toBe(700)

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
