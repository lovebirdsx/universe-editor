/*---------------------------------------------------------------------------------------------
 *  Smoke spec: Explorer right-click "Open Preview" for markdown / html (P1).
 *
 *  The Explorer row's hover eye button bypasses the command system, so it could
 *  never back a menu entry. This guards the command that now does: gated on
 *  `explorerResourceIsPreviewable`, a key ExplorerContextMenu seeds in its
 *  per-row scope. That scoped-vs-root split is invisible to unit tests (they
 *  hand-build the context service), so the menu actually opening on a real row —
 *  and staying empty on a row with no preview flavor — is asserted end to end.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

test.describe('@p1 explorer open preview', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        writeFileSync(join(dir, 'README.md'), '# Title\n')
        writeFileSync(join(dir, 'main.ts'), 'export const x = 1\n')
      },
    },
  })

  test('right-clicking a markdown file opens its preview', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    const readme = page.locator('[role="treeitem"]', { hasText: 'README.md' })
    await expect(readme).toBeVisible({ timeout: 10000 })

    await readme.click({ button: 'right' })
    const menu = page.getByRole('menu')
    // The label falls back to the code default: the fixtures pin
    // workbench.language=en-US and the en-US table carries no override.
    const openPreview = menu.getByRole('menuitem', { name: 'Open Preview' })
    await expect(openPreview).toBeVisible()
    await openPreview.click()

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), { timeout: 5000 })
      .toBe('markdown.preview')

    // A file with no preview flavor must not offer the entry. Right-clicking a
    // second row also proves the key is scoped per row, not sticky from the
    // first right-click.
    const main = page.locator('[role="treeitem"]', { hasText: 'main.ts' })
    await main.click({ button: 'right' })
    await expect(menu.getByRole('menuitem', { name: 'Open Preview' })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeVisible()

    // Dismiss the menu so teardown finds a clean overlay state.
    await page.keyboard.press('Escape')
  })
})
