/*---------------------------------------------------------------------------------------------
 *  Perforce Graph merged (multi-select) history (@p1).
 *
 *  Ctrl-selecting several Explorer rows and running "View File History" opens ONE
 *  tab whose rows are the UNION of the changes touching any selected path. The
 *  seed makes the union provable: 4520 touched both files, 4521 only a.txt, 4522
 *  only b.txt — so a single-path history would be missing a row either way, and
 *  only a selection-aware handler lists all three.
 *
 *  "Get This Revision" on 4520 is then a multi-path time travel: it must ask for
 *  confirmation first (non-head row) and land BOTH files on the revision that
 *  change produced (#2, a forward sync from the seeded have #1). Assertion is the
 *  dual channel per file: disk content and the fake depot's haveRev.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { test, expect, waitForPerforceCommands, readHaveRev } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import type { Locator } from '@playwright/test'
import type { P4SubmittedSeed, SeedFile } from '../fixtures/perforceApp.js'

const A_V1 = 'a v1\n'
const A_V2 = 'a v2\n'
const A_V3 = 'a v3\n'
const B_V1 = 'b v1\n'
const B_V2 = 'b v2\n'
const B_V3 = 'b v3\n'

const aTxt: SeedFile = {
  relPath: 'a.txt',
  content: A_V1,
  headRev: 3,
  headContent: A_V3,
  revisions: { '1': A_V1, '2': A_V2, '3': A_V3 },
}
const bTxt: SeedFile = {
  relPath: 'b.txt',
  content: B_V1,
  headRev: 3,
  headContent: B_V3,
  revisions: { '1': B_V1, '2': B_V2, '3': B_V3 },
}
const seeds: readonly SeedFile[] = [aTxt, bTxt]

// 4520 is the only change both files share; 4521/4522 each touch exactly one of
// them, which is what makes "the merged tab lists all three" a union assertion.
const SUBMITTED: readonly P4SubmittedSeed[] = [
  {
    changelist: '4520',
    user: 'e2e',
    // Unix seconds as a string, matching `p4 -ztag changes` output.
    time: '1751600000',
    description: 'both files to v2',
    rev: 2,
    files: [
      { relPath: 'a.txt', action: 'edit', rev: 2 },
      { relPath: 'b.txt', action: 'edit', rev: 2 },
    ],
  },
  {
    changelist: '4521',
    user: 'e2e',
    time: '1751600100',
    description: 'a to v3',
    rev: 3,
    files: [{ relPath: 'a.txt', action: 'edit', rev: 3 }],
  },
  {
    changelist: '4522',
    user: 'e2e',
    time: '1751600200',
    description: 'b to v3',
    rev: 3,
    files: [{ relPath: 'b.txt', action: 'edit', rev: 3 }],
  },
]

test.describe('@p1 perforce graph merged history', () => {
  test.use({ p4Seeds: { files: seeds, submitted: SUBMITTED } })

  test(
    'a multi-select history tab unions both paths and gets them together @regression',
    { tag: '@serial' },
    async ({ page, workbench, perforce, p4Workspace }) => {
      // Cold boot + host relaunch on workspace open + the merged changes query.
      test.setTimeout(120_000)
      await evaluateWhenRestored(page)
      await workbench.openWorkspace(perforce.openDir)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'perforce extension should register a source control for the workspace',
        })
        .toBeGreaterThan(0)
      // The SCM-count gate flips before the contributed command handlers register,
      // and the merged getChanges would resolve to no handler with no retry.
      await waitForPerforceCommands(workbench)
      // `workbench.view.explorer` is a toggle and would hide the Explorer when the
      // side bar already has focus — see WorkbenchPO.showExplorer.
      await workbench.showExplorer()

      const rowOf = (seed: SeedFile) => page.locator('[role="treeitem"]', { hasText: seed.relPath })
      for (const seed of seeds) {
        await expect(rowOf(seed)).toBeVisible({ timeout: 60_000 })
      }
      // Opening a workspace remounts the layout; while the split view is still
      // settling the Explorer rows can be laid out under the editor's welcome pane,
      // which then swallows the click for the whole retry budget (seen once as a
      // 30s "welcome intercepts pointer events" timeout). Gate on the row's box
      // actually being the hit target before clicking.
      const settled = async (row: Locator): Promise<boolean> => {
        const box = await row.boundingBox()
        if (box === null || box.width === 0) return false
        return await row.evaluate(
          (el, point: { x: number; y: number }) => {
            const hit = el.ownerDocument.elementFromPoint(point.x, point.y)
            return hit !== null && el.contains(hit)
          },
          { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        )
      }
      for (const seed of seeds) {
        await expect.poll(() => settled(rowOf(seed)), { timeout: 30_000 }).toBe(true)
      }

      // Ctrl-select both rows, then right-click one: the selection materializes as
      // the command's second argument, so b.txt is reached without being clicked.
      for (const seed of seeds) {
        await rowOf(seed).click({ modifiers: ['Control'] })
      }
      await rowOf(aTxt).click({ button: 'right' })
      const menu = page.getByRole('menu').first()
      await expect(menu).toBeVisible({ timeout: 10_000 })
      const submenuRow = menu.getByRole('menuitem', { name: 'Perforce', exact: true })
      await expect(submenuRow).toBeVisible({ timeout: 10_000 })
      await submenuRow.hover()
      const panel = page.getByTestId('context-menu-submenu')
      await expect(panel).toBeVisible({ timeout: 10_000 })
      await panel.getByText('View File History', { exact: true }).click()

      const editor = page.locator('[data-testid="perforceGraph-editor"]')
      await expect(editor).toBeVisible({ timeout: 30_000 })
      // Sorted-first basename plus the "+N" counter, in the header and the tab.
      await expect(editor.getByText('History: a.txt +1', { exact: true })).toBeVisible({
        timeout: 30_000,
      })
      await expect(page.getByRole('tab').filter({ hasText: 'a.txt +1' })).toBeVisible()

      // The union: 4521 only touched a.txt and 4522 only b.txt, so neither path
      // alone could produce this row set.
      for (const id of ['4522', '4521', '4520']) {
        await expect(editor.locator(`[data-id="${id}"]`)).toBeVisible({ timeout: 30_000 })
      }

      await editor.locator('[data-id="4520"]').click({ button: 'right' })
      const rowMenu = page.getByRole('menu').first()
      await expect(rowMenu).toBeVisible({ timeout: 10_000 })
      await rowMenu.getByText('Get This Revision', { exact: true }).click()

      // Moving several paths in time is confirmed before anything syncs.
      const dialog = page
        .getByRole('dialog')
        .filter({ has: page.getByRole('button', { name: 'Confirm Sync' }) })
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      await dialog.getByRole('button', { name: 'Confirm Sync' }).click()

      for (const [relPath, expected] of [
        ['a.txt', A_V2],
        ['b.txt', B_V2],
      ] as const) {
        await expect
          .poll(() => readFileSync(perforce.file(relPath), 'utf8'), {
            timeout: 30_000,
            message: `the merged get should write ${relPath} at revision #2`,
          })
          .toBe(expected)
        await expect
          .poll(() => readHaveRev(p4Workspace.stateFile, relPath), {
            timeout: 30_000,
            message: `the fake depot should report haveRev 2 for ${relPath}`,
          })
          .toBe(2)
      }
    },
  )
})
