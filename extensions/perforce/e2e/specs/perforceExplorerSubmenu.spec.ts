/*---------------------------------------------------------------------------------------------
 *  Explorer context-menu submenu geometry (@regression).
 *
 *  Guards the bug that shipped with the Perforce submenu: the panel is
 *  `position: fixed` and was positioned in viewport coordinates, but Floating UI
 *  puts a `transform` on the surface root, which makes that root the containing
 *  block for fixed descendants. The coordinates were therefore applied twice and
 *  the panel landed roughly the surface's own origin away from the row it hangs
 *  off — far down-right, mostly outside the window.
 *
 *  Unit tests cannot see this: happy-dom reports every rect as zero. Real
 *  geometry is only observable here.
 *
 *  Perforce contributes the only real Explorer-context submenu in the repo
 *  (`perforce.explorerMenu`), which is why this lives in the perforce suite.
 *--------------------------------------------------------------------------------------------*/

import { test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import type { SeedFile } from '../fixtures/perforceApp.js'

const seed: SeedFile = { relPath: 'submenu.txt', content: 'contents\n' }

test.describe('@p1 explorer context menu submenus', () => {
  test.use({ p4Seeds: { files: [seed] } })

  // @serial for the same reason as perforceSync's explorer journey: this is a
  // real right-click, so the extension host must have finished contributing menu
  // items, and stacked concurrent cold starts starve that activation.
  test(
    'a submenu panel opens beside its row and stays inside the window @regression',
    { tag: '@serial' },
    async ({ page, workbench, perforce }) => {
      test.setTimeout(120_000)

      await evaluateWhenRestored(page)
      await workbench.openWorkspace(perforce.openDir)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'perforce extension should register a source control for the workspace',
        })
        .toBeGreaterThan(0)
      await waitForPerforceCommands(workbench)
      // The activity-bar item is a toggle too: clicking it while the Explorer is
      // already active AND the side bar focused closes the side bar.
      await workbench.showExplorer()

      const fileRow = page.locator('[role="treeitem"]', { hasText: 'submenu.txt' })
      await expect(fileRow).toBeVisible({ timeout: 30_000 })
      await fileRow.click({ button: 'right' })

      const menu = page.getByRole('menu').first()
      await expect(menu).toBeVisible({ timeout: 10_000 })

      const submenuRow = menu.getByRole('menuitem', { name: 'Perforce', exact: true })
      await expect(submenuRow).toBeVisible({ timeout: 10_000 })
      await submenuRow.hover()

      const panel = page.getByTestId('context-menu-submenu')
      await expect(panel).toBeVisible({ timeout: 10_000 })
      // The panel measures itself in a hidden frame before it settles.
      await expect
        .poll(async () => (await panel.boundingBox())?.width ?? 0, { timeout: 10_000 })
        .toBeGreaterThan(0)

      const rowBox = await submenuRow.boundingBox()
      const panelBox = await panel.boundingBox()
      expect(rowBox).not.toBeNull()
      expect(panelBox).not.toBeNull()
      if (!rowBox || !panelBox) return

      // page.viewportSize() is null under Electron (no emulated viewport).
      const view = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }))

      // Fully inside the window — the double-offset bug pushed it off the edge.
      expect(panelBox.x).toBeGreaterThanOrEqual(0)
      expect(panelBox.y).toBeGreaterThanOrEqual(0)
      expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(view.width + 1)
      expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(view.height + 1)

      // Adjacent to its row rather than adrift: it either starts at the row's
      // right edge (the preferred side) or ends at its left edge (flipped), and
      // it overlaps the row vertically.
      const hugsRight = Math.abs(panelBox.x - (rowBox.x + rowBox.width)) <= 2
      const hugsLeft = Math.abs(panelBox.x + panelBox.width - rowBox.x) <= 2
      expect(
        hugsRight || hugsLeft,
        `panel x=${panelBox.x} w=${panelBox.width} should hug row x=${rowBox.x} w=${rowBox.width}`,
      ).toBe(true)
      expect(panelBox.y).toBeLessThanOrEqual(rowBox.y + rowBox.height)
      expect(panelBox.y + panelBox.height).toBeGreaterThanOrEqual(rowBox.y)

      // The panel's items are reachable: clicking one runs its command, which
      // would have been impossible with the panel off-screen.
      await panel.getByText('Copy Depot Path', { exact: true }).click()
      await expect(page.getByTestId('context-menu-submenu')).toBeHidden({ timeout: 10_000 })
    },
  )
})
