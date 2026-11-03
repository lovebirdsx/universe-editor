/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  守护按需紧凑链：一次展开完成身份迁移，链缩短与折叠后刷新不丢焦点。
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { test, expect } from '../fixtures/electronApp.js'

test.use({
  workspaceSeeder: {
    seed(dir) {
      const leaf = path.join(dir, 'source', 'config', 'raw', 'tables')
      mkdirSync(leaf, { recursive: true })
      writeFileSync(path.join(leaf, 'data.json'), '{}')
      writeFileSync(path.join(dir, 'source', 'a.txt'), 'a')
    },
  },
})

test.describe('@p1 explorer compact folders', () => {
  test('a chain forms on demand with one expansion and keeps focus @regression', async ({
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()

    const sourceRow = page.getByRole('treeitem').filter({ hasText: /^source$/ })
    await expect(sourceRow).toBeVisible()
    await sourceRow.click()

    const configRow = page.getByRole('treeitem').filter({ hasText: /^config$/ })
    const chainRow = page.getByRole('treeitem').filter({ hasText: /^config\/raw\/tables$/ })
    await expect(configRow).toBeVisible()
    await expect(chainRow).toHaveCount(0)
    await configRow.click()

    await expect(chainRow).toBeVisible()
    await expect(chainRow).toHaveAttribute('aria-selected', 'true')
    await expect(chainRow).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('treeitem').filter({ hasText: /^data.json$/ })).toBeVisible()
    await expect(configRow).toHaveCount(0)

    await page.keyboard.press('ArrowLeft')
    await expect(chainRow).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('treeitem').filter({ hasText: /^data.json$/ })).toHaveCount(0)
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('treeitem').filter({ hasText: /^data.json$/ })).toBeVisible()
    await expect(chainRow).toHaveAttribute('aria-selected', 'true')
  })

  test('focus follows the row when a chain shortens @regression', async ({
    workbench,
    page,
    launchWorkspace,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await page
      .getByRole('treeitem')
      .filter({ hasText: /^source$/ })
      .click()
    await page
      .getByRole('treeitem')
      .filter({ hasText: /^config$/ })
      .click()

    const chainRow = page.getByRole('treeitem').filter({ hasText: /^config\/raw\/tables$/ })
    await expect(chainRow).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => page.evaluate(() => window.__E2E__!.isWorkspaceWatchArmed())).toBe(true)
    await fs.mkdir(path.join(launchWorkspace!.dir, 'source', 'config', 'raw', 'extra'))

    const shortRow = page.getByRole('treeitem').filter({ hasText: /^config\/raw$/ })
    await expect(shortRow).toBeVisible({ timeout: 8000 })
    await expect(shortRow).toHaveAttribute('aria-selected', 'true')
    await expect(shortRow).toHaveAttribute('aria-expanded', 'true')
  })

  test('a collapsed chain survives repeated refresh and reloads on expansion @regression', async ({
    workbench,
    page,
    launchWorkspace,
  }) => {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await page
      .getByRole('treeitem')
      .filter({ hasText: /^source$/ })
      .click()
    await page
      .getByRole('treeitem')
      .filter({ hasText: /^config$/ })
      .click()

    const chainRow = page.getByRole('treeitem').filter({ hasText: /^config\/raw\/tables$/ })
    await expect(chainRow).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('ArrowLeft')
    await expect(chainRow).toHaveAttribute('aria-expanded', 'false')
    await fs.writeFile(
      path.join(launchWorkspace!.dir, 'source', 'config', 'raw', 'tables', 'new.txt'),
      'new',
    )
    for (let i = 0; i < 3; i++) {
      await workbench.runCommand('workbench.files.action.refresh')
    }
    await expect(chainRow).toHaveAttribute('aria-expanded', 'false')
    await expect(chainRow).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('treeitem').filter({ hasText: /^new.txt$/ })).toHaveCount(0)

    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('treeitem').filter({ hasText: /^new.txt$/ })).toBeVisible()
    await expect(chainRow).toHaveAttribute('aria-selected', 'true')
  })
})
