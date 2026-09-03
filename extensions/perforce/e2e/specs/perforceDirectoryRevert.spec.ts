/*---------------------------------------------------------------------------------------------
 *  Explorer directory Revert (@p1, @regression).
 *
 *  Guards the bug where right-clicking a directory in the Explorer → Perforce →
 *  Revert silently did nothing: the context menu always materializes the tree
 *  selection as the command's second argument (the single-clicked directory is
 *  part of that selection), so the handler's old "selection is empty AND primary
 *  isDirectory" fork could never fire. The directory fell into the per-file
 *  branch, `p4 opened <bare-dir>` matched nothing, the confirm asked to
 *  "Discard working-tree changes for 'sub'" (uncollected-only wording), and the
 *  only action was `p4 clean <bare-dir>` — not recursive, skipping opened files.
 *  Net effect: nothing happened at all.
 *
 *  The regression points: the confirm must use the leave-the-changelist wording
 *  (it lists the opened file — never the discard wording), and after Revert the
 *  opened file must be restored to its have revision AND leave the default
 *  changelist, while a drifted file outside the directory stays untouched.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync } from 'node:fs'
import { test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import type { SeedFile } from '../fixtures/perforceApp.js'

const inner: SeedFile = {
  relPath: 'sub/inner.txt',
  content: 'inner have revision\n',
  // Already open for edit in the default changelist — the revert must take it
  // out of the changelist (via `p4 revert`) and restore the have revision.
  opened: { action: 'edit', change: 'default' },
}
const outside: SeedFile = {
  relPath: 'outside.txt',
  content: 'outside have revision\n',
}

const seeds: readonly SeedFile[] = [inner, outside]

/** Drifted on disk: diverges from the have revision but is not a new p4 edit. */
const drift = (seed: SeedFile): string => `drifted: ${seed.content}`

test.describe('@p1 explorer directory revert', () => {
  test.use({ p4Seeds: { files: seeds } })

  test(
    'reverting a directory leaves its opened files out of the changelist and restores them @regression',
    { tag: '@serial' },
    async ({ page, workbench, perforce }) => {
      test.setTimeout(120_000)
      await evaluateWhenRestored(page)

      // Drift both files before the workspace opens so the Explorer's first
      // render already sees divergent disk content.
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
      await workbench.showExplorer()

      // The seeded open state must have materialized as a default-changelist row.
      await expect
        .poll(
          () => page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), 'sub/inner.txt'),
          { timeout: 30_000, message: 'inner.txt should be opened in the default changelist' },
        )
        .toEqual(['default'])

      // Click (select) the directory row, then right-click it.
      const dirRow = page.locator('[role="treeitem"]', { hasText: 'sub' })
      await expect(dirRow).toBeVisible({ timeout: 60_000 })
      await dirRow.click()
      await dirRow.click({ button: 'right' })

      const menu = page.getByRole('menu').first()
      await expect(menu).toBeVisible({ timeout: 10_000 })
      const submenuRow = menu.getByRole('menuitem', { name: 'Perforce', exact: true })
      await expect(submenuRow).toBeVisible({ timeout: 10_000 })
      await submenuRow.hover()
      const panel = page.getByTestId('context-menu-submenu')
      await expect(panel).toBeVisible({ timeout: 10_000 })
      await panel.getByText('Revert', { exact: true }).click()

      // The confirm must speak about leaving the changelist and name the opened
      // file — the bug showed the uncollected-only "Discard working-tree
      // changes" wording (and then did nothing).
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      await expect(dialog).toContainText('These files will leave their changelist')
      await expect(dialog).toContainText('inner.txt')
      await expect(dialog).not.toContainText('Discard working-tree changes')
      await dialog.getByRole('button', { name: 'Revert' }).click()

      // inner.txt lands back on its have revision and leaves the default
      // changelist (the `p4 revert <dir>/...` + `p4 clean <dir>/...` pair).
      await expect
        .poll(() => readFileSync(perforce.file(inner.relPath), 'utf8'), {
          timeout: 30_000,
          message: 'inner.txt should be restored to its have revision',
        })
        .toBe(inner.content)
      await expect
        .poll(
          () => page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), 'sub/inner.txt'),
          { timeout: 30_000, message: 'inner.txt should no longer be in any changelist' },
        )
        .toEqual([])

      // The revert was scoped to the directory: the drifted file outside it is
      // untouched (its drift survives; it was never opened).
      expect(readFileSync(perforce.file(outside.relPath), 'utf8')).toBe(drift(outside))
    },
  )
})
