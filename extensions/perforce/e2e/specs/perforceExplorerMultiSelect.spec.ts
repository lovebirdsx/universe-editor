/*---------------------------------------------------------------------------------------------
 *  Explorer multi-select fan-out for Perforce commands (@p1).
 *
 *  Before the Explorer context menu materialized the tree selection as a second
 *  command argument, every extension command reached the host with only the
 *  right-clicked row — a Ctrl-selection of several files still acted on exactly
 *  one. `gamma.txt` below is the regression point: it is selected but never
 *  right-clicked, so only a selection-aware handler restores it.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync } from 'node:fs'
import { test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import type { SeedFile } from '../fixtures/perforceApp.js'

const seeds: readonly SeedFile[] = [
  { relPath: 'alpha.txt', content: 'alpha have revision\n' },
  { relPath: 'beta.txt', content: 'beta have revision\n' },
  { relPath: 'gamma.txt', content: 'gamma have revision\n' },
]

/** Drifted on disk but never `p4 edit`-ed — the "uncollected drift" that
 *  Discard Uncollected Changes (`p4 clean`) restores to the have revision. */
const drift = (seed: SeedFile): string => `drifted: ${seed.content}`

test.describe('@p1 explorer perforce multi-select', () => {
  test.use({ p4Seeds: { files: seeds } })

  test(
    'discard uncollected changes acts on the whole ctrl-selection, not just the clicked row @regression',
    { tag: '@serial' },
    async ({ page, workbench, perforce }) => {
      test.setTimeout(120_000)
      await evaluateWhenRestored(page)

      // Drift the files before the workspace opens so the Explorer's first render
      // already looks at divergent disk content.
      for (const seed of seeds) {
        writeFileSync(perforce.file(seed.relPath), drift(seed), 'utf8')
      }

      await workbench.openWorkspace(perforce.openDir)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'perforce extension should register a source control for the workspace',
        })
        .toBeGreaterThan(0)
      await waitForPerforceCommands(workbench)
      await workbench.runCommand('workbench.view.explorer')

      const rowOf = (seed: SeedFile) => page.locator('[role="treeitem"]', { hasText: seed.relPath })
      for (const seed of seeds) {
        await expect(rowOf(seed)).toBeVisible({ timeout: 60_000 })
      }

      // Ctrl+click the three rows: each toggles the row into the selection.
      for (const seed of seeds) {
        await rowOf(seed).click({ modifiers: ['Control'] })
      }

      // Right-click beta — inside the selection, so the menu keeps all three.
      await rowOf(seeds[1]!).click({ button: 'right' })

      const menu = page.getByRole('menu').first()
      await expect(menu).toBeVisible({ timeout: 10_000 })
      const submenuRow = menu.getByRole('menuitem', { name: 'Perforce', exact: true })
      await expect(submenuRow).toBeVisible({ timeout: 10_000 })
      await submenuRow.hover()
      const panel = page.getByTestId('context-menu-submenu')
      await expect(panel).toBeVisible({ timeout: 10_000 })
      await panel.getByText('Discard Uncollected Changes', { exact: true }).click()

      // The confirm names the whole selection — "3 files", not just the clicked row.
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      await expect(dialog).toContainText('Discard working-tree changes for 3 files')
      await dialog.getByRole('button', { name: 'Revert' }).click()

      // All three files land back on their have revisions. gamma is the
      // regression point: selected but never right-clicked.
      for (const seed of seeds) {
        await expect
          .poll(() => readFileSync(perforce.file(seed.relPath), 'utf8'), {
            timeout: 30_000,
            message: `${seed.relPath} should be restored to its have revision`,
          })
          .toBe(seed.content)
      }
    },
  )
})
