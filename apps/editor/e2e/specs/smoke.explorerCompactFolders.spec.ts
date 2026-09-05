/*---------------------------------------------------------------------------------------------
 *  Smoke spec: Explorer compact folders (P1).
 *
 *  Two regressions this guards:
 *   A) A single-directory chain one level below an already-cached directory used
 *      to render as a plain row and only compact on the next ArrowRight. Because
 *      a compact row is keyed by its chain *tail*, compacting late moves the row
 *      id out from under the model's focus/selection and the highlight silently
 *      disappears. The chain must be compacted on the first frame the parent is
 *      expanded, so pressing ArrowRight only expands — the id never moves.
 *   B) When a chain shortens because a sibling appears mid-chain, the row id
 *      moves up to the new tail; focus must follow it rather than go dark.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { test, expect } from '../fixtures/electronApp.js'

test.describe('@p1 explorer compact folders', () => {
  test('a chain under a cached parent is compact before any keypress @regression', async ({
    workbench,
    page,
    scratchDir,
  }) => {
    const tmpDir = scratchDir('ue2-compact-')
    // `source` itself is not a chain (two children), so the root's own prefetch
    // stops there — `config`'s chain is the one that has to form on expand.
    const leafDir = path.join(tmpDir, 'source', 'config', 'raw', 'tables')
    await fs.mkdir(leafDir, { recursive: true })
    await fs.writeFile(path.join(leafDir, 'data.json'), '{}')
    await fs.writeFile(path.join(tmpDir, 'source', 'a.txt'), 'a')

    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    await expect
      .poll(() => workbench.getContextKey<boolean>('sideBarVisible'), { timeout: 5000 })
      .toBe(true)

    const sourceRow = page.locator('[role="treeitem"]', { hasText: 'source' }).first()
    await expect(sourceRow).toBeVisible({ timeout: 5000 })
    await sourceRow.click()

    // The whole chain renders as one row on the first frame…
    const chainRow = page.locator('[role="treeitem"]', { hasText: 'config/raw/tables' })
    await expect(chainRow).toBeVisible({ timeout: 5000 })
    // …and there is no plain `config` row. Anchor the regex: a bare 'config'
    // filter would also match the compact row's own text.
    await expect(page.locator('[role="treeitem"]', { hasText: /^config$/ })).toHaveCount(0)

    await chainRow.click()
    await expect(chainRow).toHaveAttribute('aria-selected', 'true')

    // Clicking a directory toggles it; collapse so ArrowRight is the press that
    // expands rather than the one that steps into the first child.
    await page.keyboard.press('ArrowLeft')
    await expect(page.locator('[role="treeitem"]', { hasText: 'data.json' })).toHaveCount(0)

    await page.keyboard.press('ArrowRight')

    await expect(page.locator('[role="treeitem"]', { hasText: 'data.json' })).toBeVisible({
      timeout: 5000,
    })
    // Same row, still selected — expanding did not move the id.
    await expect(chainRow).toHaveAttribute('aria-selected', 'true')
  })

  test('focus follows the row when a chain shortens @regression', async ({
    workbench,
    page,
    scratchDir,
  }) => {
    const tmpDir = scratchDir('ue2-compact-shrink-')
    const rawDir = path.join(tmpDir, 'source', 'config', 'raw')
    await fs.mkdir(path.join(rawDir, 'tables'), { recursive: true })
    await fs.writeFile(path.join(rawDir, 'tables', 'data.json'), '{}')
    await fs.writeFile(path.join(tmpDir, 'source', 'a.txt'), 'a')

    await workbench.waitForRestored()
    await workbench.openWorkspace(tmpDir)

    await expect
      .poll(() => workbench.getContextKey<boolean>('sideBarVisible'), { timeout: 5000 })
      .toBe(true)

    const sourceRow = page.locator('[role="treeitem"]', { hasText: 'source' }).first()
    await expect(sourceRow).toBeVisible({ timeout: 5000 })
    await sourceRow.click()

    const chainRow = page.locator('[role="treeitem"]', { hasText: 'config/raw/tables' })
    await expect(chainRow).toBeVisible({ timeout: 5000 })
    await chainRow.click()
    await expect(chainRow).toHaveAttribute('aria-selected', 'true')

    // A sibling appears mid-chain: the chain now ends at `raw`, so the row id
    // moves up from `tables` to `raw`.
    await fs.mkdir(path.join(rawDir, 'extra'))

    // Anchored: `config/raw` as a substring also matches the *old* long row, so
    // a loose filter would pass without the chain ever having shortened.
    const shortRow = page.locator('[role="treeitem"]', { hasText: /^config\/raw$/ })
    await expect(shortRow).toBeVisible({ timeout: 8000 })
    await expect(shortRow).toHaveAttribute('aria-selected', 'true', { timeout: 8000 })
  })
})
