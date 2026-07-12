/*---------------------------------------------------------------------------------------------
 *  Perforce changelist smoke (@p1).
 *
 *  Repro + guard for two reported bugs:
 *   1. "I create a new changelist but never see it" — a freshly created numbered
 *      changelist is empty, and the SCM view used to hide empty numbered groups, so
 *      it vanished, leaving no drop target. Numbered changelists must stay visible.
 *   2. "I can't move a file out of the default changelist" — the reopen /
 *      move-to-changelist commands lived in non-inline menu groups, and the SCM
 *      file row only rendered inline actions with no context menu, so those
 *      commands had no UI entry point. Right-clicking a file row must surface them.
 *
 *  Backed by the fake p4 (fixtures/fake-p4.mjs), which now models numbered
 *  changelists (change -i / changes / reopen). See fixtures/perforceApp.ts.
 *--------------------------------------------------------------------------------------------*/

import { test, expect, DEFAULT_SEEDS } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored } from '../pages/WorkbenchPO.js'

const tracked = DEFAULT_SEEDS[0]!.relPath

test.describe('@p1 perforce changelist', () => {
  test.describe('an empty numbered changelist', () => {
    // Pre-create a numbered changelist with no files. The bug was that the SCM view
    // hid empty numbered groups, so a just-created changelist vanished — leaving no
    // drop target to move files into.
    test.use({ p4Seeds: { files: DEFAULT_SEEDS, changelists: { '1000': 'feature work' } } })

    test('stays visible in the SCM view @regression', async ({ page, workbench, perforce }) => {
      test.setTimeout(120_000)
      await evaluateWhenRestored(page)

      await workbench.openWorkspace(perforce.openDir)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'perforce extension should register a source control for the workspace',
        })
        .toBeGreaterThan(0)

      await workbench.runCommand('workbench.view.scm')

      // The empty numbered changelist group must be visible in the SCM view.
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getVisibleScmGroupIds()), {
          timeout: 30_000,
          message: 'an empty numbered changelist should still be shown',
        })
        .toEqual(expect.arrayContaining([expect.stringMatching(/^cl:/)]))

      // And it should render as a group header row labelled with its description.
      const group = page.locator('[role="treeitem"]', { hasText: 'feature work' })
      await expect(group).toBeVisible({ timeout: 30_000 })
    })
  })

  test('a default-changelist file row exposes "Move to Changelist" via right-click @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    test.setTimeout(120_000)
    await evaluateWhenRestored(page)

    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)

    await workbench.runCommand('workbench.view.scm')

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
  })

  test.describe('moving a file into a changelist', () => {
    // Pre-create a numbered changelist so there's a concrete target to move into.
    test.use({ p4Seeds: { files: DEFAULT_SEEDS, changelists: { '1000': 'feature work' } } })

    test('perforce.reopenTo moves the file under the target changelist @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await evaluateWhenRestored(page)

      await workbench.openWorkspace(perforce.openDir)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'perforce extension should register a source control for the workspace',
        })
        .toBeGreaterThan(0)

      await workbench.runCommand('workbench.view.scm')

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

      // The file row must now live under the "feature work" changelist group. Its
      // group header row and the file row should both be present after the refresh.
      await expect(page.locator('[role="treeitem"]', { hasText: 'feature work' })).toBeVisible({
        timeout: 30_000,
      })
      await expect(page.locator('[role="treeitem"]', { hasText: tracked })).toBeVisible({
        timeout: 30_000,
      })
    })
  })
})
