/*---------------------------------------------------------------------------------------------
 *  Explorer multi-select "Get" fan-out for Perforce (@p1).
 *
 *  Both gets fan out over the Explorer's Ctrl-selection (the selection
 *  materializes as the command's second argument): "Get Latest Revision"
 *  (`perforce.syncLatest`) and "Get Revision…" (`perforce.sync`) run one
 *  filespec per selected element. `beta.txt` is the regression point — it is
 *  selected but never right-clicked, so only a selection-aware handler reaches
 *  it. Both files start at #1 with head #2, so the latest get really moves
 *  them; the second journey re-runs through the quick pick (first item =
 *  Latest revision) over the same selection and lands the "already at the
 *  latest" report instead of acting on just the clicked row.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import type { SeedFile } from '../fixtures/perforceApp.js'

const seeds: readonly SeedFile[] = [
  { relPath: 'alpha.txt', content: 'alpha v1\n', headRev: 2, headContent: 'alpha v2\n' },
  { relPath: 'beta.txt', content: 'beta v1\n', headRev: 2, headContent: 'beta v2\n' },
]

test.describe('@p1 explorer perforce get multi-select', () => {
  test.use({ p4Seeds: { files: seeds } })

  test(
    'get latest and get revision act on the whole ctrl-selection @regression',
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
      // A toggle: it would HIDE the Explorer when the side bar already has focus.
      await workbench.showExplorer()

      const rowOf = (seed: SeedFile) => page.locator('[role="treeitem"]', { hasText: seed.relPath })
      for (const seed of seeds) {
        await expect(rowOf(seed)).toBeVisible({ timeout: 60_000 })
      }

      /** Ctrl-select every seed row, then open the context menu on `seeds[1]`. */
      const selectAllAndMenu = async () => {
        for (const seed of seeds) {
          await rowOf(seed).click({ modifiers: ['Control'] })
        }
        await rowOf(seeds[1]!).click({ button: 'right' })
        const menu = page.getByRole('menu').first()
        await expect(menu).toBeVisible({ timeout: 10_000 })
        return menu
      }

      await test.step('Get Latest Revision pulls every selected file to head', async () => {
        const menu = await selectAllAndMenu()
        await menu.getByText('Get Latest Revision', { exact: true }).click()

        // beta is the regression point: selected but never right-clicked.
        for (const seed of seeds) {
          await expect
            .poll(() => readFileSync(perforce.file(seed.relPath), 'utf8'), {
              timeout: 30_000,
              message: `${seed.relPath} should land on its head revision`,
            })
            .toBe(seed.headContent)
        }
      })

      await test.step('Get Revision… quick pick runs the same selection (already at the latest)', async () => {
        // A plain click first: the tree kept the old selection, and Ctrl-click
        // toggles — this rebuilds a clean two-row selection.
        await rowOf(seeds[0]!).click()
        const menu = await selectAllAndMenu()
        const submenuRow = menu.getByRole('menuitem', { name: 'Perforce', exact: true })
        await expect(submenuRow).toBeVisible({ timeout: 10_000 })
        await submenuRow.hover()
        const panel = page.getByTestId('context-menu-submenu')
        await expect(panel).toBeVisible({ timeout: 10_000 })
        await panel.getByText('Get Revision…', { exact: true }).click()

        const quickInput = page.getByTestId('quick-input')
        await expect(quickInput).toBeVisible({ timeout: 30_000 })
        await expect(quickInput.getByText('Latest revision', { exact: true })).toBeVisible()
        await page.keyboard.press('Enter')
        await workbench.quickInput.waitForHidden()

        // The selection-scoped run reports up-to-date instead of touching just
        // the clicked row — and both files stay intact at head.
        await expect(
          page
            .locator('[data-testid="notification-toast-item"]')
            .filter({ hasText: 'Already at the latest revision' }),
        ).toBeVisible({ timeout: 30_000 })
        for (const seed of seeds) {
          expect(readFileSync(perforce.file(seed.relPath), 'utf8')).toBe(seed.headContent)
        }
      })
    },
  )
})
