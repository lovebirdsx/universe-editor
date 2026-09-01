/*---------------------------------------------------------------------------------------------
 *  Perforce changelist smoke (@p1).
 *
 *  Repro + guard for reported bugs, merged into two journeys (one cold launch
 *  each — every test here costs a full Electron + extension-host cold start):
 *
 *  Journey 1 (numbered changelists): a freshly created numbered changelist is
 *  empty and used to vanish from the SCM view (no drop target); files must move
 *  default → cl, and an unopened (revert -k'd) file → cl via the drop command's
 *  reconcile-into branch (`reconcile -c` collect, an unopened file isn't
 *  `reopen`-able); and deleting an (empty) changelist must remove its group. The
 *  delete target is a second seeded changelist that stays untouched by the move
 *  steps.
 *
 *  Journey 2 (default changelist rows): the move/reopen commands lived in
 *  non-inline menu groups and the file row had no context menu, so they had no
 *  UI entry point — right-click must surface them; and a group-scoped
 *  moveToReconcile must leave the file in no changelist group (revert -k keeps
 *  the disk edit as uncollected drift).
 *
 *  Backed by the fake p4 (fixtures/fake-p4.mjs), which models numbered
 *  changelists (change -i / changes / reopen). See fixtures/perforceApp.ts.
 *--------------------------------------------------------------------------------------------*/

import { test, expect, DEFAULT_SEEDS, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored, type WorkbenchPO } from '@universe-editor/e2e-harness'
import { writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'

const tracked = DEFAULT_SEEDS[0]!.relPath

/** Open the seeded workspace, wait for the provider + command registration. */
async function openScmWorkspace(
  page: Page,
  workbench: WorkbenchPO,
  openDir: string,
): Promise<void> {
  await evaluateWhenRestored(page)
  await workbench.openWorkspace(openDir)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
      timeout: 60_000,
      message: 'perforce extension should register a source control for the workspace',
    })
    .toBeGreaterThan(0)
  await workbench.runCommand('workbench.view.scm')
  await waitForPerforceCommands(workbench)
}

test.describe('@p1 perforce changelist', () => {
  test.describe('numbered changelists', () => {
    // Pre-create two numbered changelists with no files: cl:1000 is the move
    // target, cl:1001 exists only to be deleted (it must stay empty throughout).
    test.use({
      p4Seeds: {
        files: DEFAULT_SEEDS,
        changelists: { '1000': 'feature work', '1001': 'obsolete work' },
      },
    })

    test('stay visible when empty and route file moves between default and changelist @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openScmWorkspace(page, workbench, perforce.openDir)

      const groupIdsFor = (relPath: string) =>
        page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), relPath)

      await test.step('an empty numbered changelist stays visible in the SCM view', async () => {
        // The bug: the SCM view hid empty numbered groups, so a just-created
        // changelist vanished — leaving no drop target to move files into.
        await expect
          .poll(() => page.evaluate(() => window.__E2E__!.getVisibleScmGroupIds()), {
            timeout: 30_000,
            message: 'empty numbered changelists should still be shown',
          })
          .toEqual(expect.arrayContaining(['cl:1000', 'cl:1001']))
        const group = page.locator('[role="treeitem"]', { hasText: 'feature work' })
        await expect(group).toBeVisible({ timeout: 30_000 })
      })

      await test.step('perforce.reopenTo moves a default-changelist file under the target changelist', async () => {
        // Open the file for edit — it lands in the default changelist.
        await workbench.runCommand('perforce.edit', { resourceUri: perforce.file(tracked) })
        await expect(page.locator('[role="treeitem"]', { hasText: tracked })).toBeVisible({
          timeout: 30_000,
        })

        // Drive the drag-and-drop landing command directly (HTML5 DnD isn't reliably
        // scriptable): move the file into cl:1000, exactly what a drop onto that group
        // header runs. Args mirror what ScmGroupRow sends: (groupArg, selection).
        await workbench.runCommand(
          'perforce.reopenTo',
          { scmResourceGroupId: 'cl:1000', resourceUri: perforce.file(tracked) },
          [{ resourceUri: perforce.file(tracked), scmResourceGroupId: 'default' }],
        )
        await expect(page.locator('[role="treeitem"]', { hasText: 'feature work' })).toBeVisible({
          timeout: 30_000,
        })
        await expect
          .poll(() => groupIdsFor(tracked), {
            timeout: 30_000,
            message: 'the file should land under cl:1000',
          })
          .toEqual(['cl:1000'])
      })

      await test.step('dropping an unopened file onto a changelist collects it there', async () => {
        // Diverge the file on disk, then move it out of cl:1000 without touching
        // the working tree (`revert -k`): it leaves the changelist and becomes
        // uncollected drift (changelistOf === undefined).
        writeFileSync(perforce.file(tracked), 'locally edited content\n', 'utf8')
        await workbench.runCommand('perforce.moveToReconcile', {
          resourceUri: perforce.file(tracked),
        })

        // An unopened file isn't `reopen`-able, so the drop command must collect
        // it straight into cl:1000 (reconcile -a -e -d -c), not `reopen`.
        await workbench.runCommand(
          'perforce.reopenTo',
          { scmResourceGroupId: 'cl:1000', resourceUri: perforce.file(tracked) },
          [{ resourceUri: perforce.file(tracked), scmResourceGroupId: 'default' }],
        )
        await expect
          .poll(() => groupIdsFor(tracked), {
            timeout: 30_000,
            message: 'the unopened file should be collected into cl:1000',
          })
          .toEqual(['cl:1000'])
      })

      await test.step('perforce.deleteChangelist removes an empty changelist', async () => {
        // Trigger the delete WITHOUT awaiting: the command blocks on its own confirm
        // dialog, so awaiting the command Promise here would deadlock the test (the
        // dialog click below never runs). Fire-and-forget, then drive the dialog.
        void page
          .evaluate(
            () =>
              void window.__E2E__!.runCommand('perforce.deleteChangelist', {
                scmResourceGroupId: 'cl:1001',
              }),
          )
          .catch(() => {})
        const dialog = page.getByRole('dialog')
        await dialog.getByRole('button', { name: 'Delete Changelist' }).click()

        await expect
          .poll(() => page.evaluate(() => window.__E2E__!.getVisibleScmGroupIds()), {
            timeout: 30_000,
            message: 'the empty changelist group should be gone after deletion',
          })
          .not.toEqual(expect.arrayContaining(['cl:1001']))
      })
    })
  })

  test('a default-changelist file row offers move commands via right-click and moves out of its changelist @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    test.setTimeout(120_000)
    await openScmWorkspace(page, workbench, perforce.openDir)

    await test.step('right-click surfaces the move / reopen commands', async () => {
      // Open the tracked file for edit so it lands in the default changelist as a row.
      await workbench.runCommand('perforce.edit', { resourceUri: perforce.file(tracked) })
      const row = page.locator('[role="treeitem"]', { hasText: tracked })
      await expect(row).toBeVisible({ timeout: 30_000 })

      // Right-click the row — the bug was that no context menu existed, so the
      // move/reopen commands (in non-inline groups) had no entry point.
      await row.click({ button: 'right' })

      // The context menu must offer moving the file to another changelist. Scope to
      // the popup menu so we don't match the inline action button of the same name.
      const menu = page.getByRole('menu')
      await expect(menu).toBeVisible({ timeout: 10_000 })
      await expect(menu.getByText('Move to Changelist', { exact: true })).toBeVisible()
      // And a command that only lives in a non-inline group must be there too.
      await expect(menu.getByText('Move to New Changelist', { exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
    })

    await test.step('perforce.moveToReconcile leaves the file in no changelist group', async () => {
      // Diverge the working-tree content, then move it out of the changelist:
      // `revert -k` keeps the edited content on disk, so it becomes uncollected
      // drift that no changelist group claims.
      writeFileSync(perforce.file(tracked), 'locally edited content\n', 'utf8')
      await workbench.runCommand('perforce.moveToReconcile', {
        scmResourceGroupId: 'default',
      })
      await expect
        .poll(
          () => page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), tracked),
          {
            timeout: 30_000,
            message: 'the file should belong to no changelist group after revert -k',
          },
        )
        .toEqual([])
    })
  })
})
