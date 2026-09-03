/*---------------------------------------------------------------------------------------------
 *  Perforce "get latest revision" smoke (@p1).
 *
 *  Covers the pull (sync) chain end to end against the fake p4 (fixtures/
 *  fake-p4.mjs): a depot file seeded ahead of the synced revision (`headRev` >
 *  have) models "the server has newer revisions". Six journeys, one cold launch
 *  each:
 *
 *  1. The Explorer right-click "Get Latest Revision" targets a single file or a
 *     folder subtree (`<dir>/...`), leaving the rest of the client alone.
 *  2. A get refused with "can't clobber writable file" offers a Collect Changes
 *     button — clicking it must REALLY open (collect) the drifted file, not just
 *     re-discover it (the old implementation ran a clean refresh and collected
 *     nothing).
 *  3. The same refusal for a SCOPE-LESS get (the status-bar entry's whole-range
 *     get) collects over the client's default sync range rather than degrading
 *     to discovery-only.
 *  4. `perforce.previewSync` quick-picks the files a get would bring in, and
 *     reports "already at the latest" when nothing is pending.
 *  5. The OTHER refusal shape — an `allwrite noclobber` client skipping a
 *     locally-modified file on stdout with exit 0 — is reported as such by both
 *     the preview and the get, the View Diff button really opens the have-vs-local
 *     diff, and the Collect Changes button really collects. Unparsed, that shape
 *     made the get claim "already at the latest revision" for a file several
 *     revisions behind.
 *  6. Force Get is the escape hatch on BOTH refusal shapes: it only runs after a
 *     second confirmation, and then it really overwrites the uncollected local
 *     work with the head revision.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync } from 'node:fs'
import { test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored, type WorkbenchPO } from '@universe-editor/e2e-harness'
import type { Page } from '@playwright/test'
import type { SeedFile } from '../fixtures/perforceApp.js'

// Depot head is one revision ahead of what the client has synced (`haveRev` 1 vs
// `headRev` 2/3) — `p4 sync -n` then reports these files, which is what the
// preview quick-pick reads.
const BEHIND_HEAD = 'head revision two\n'
const behind: SeedFile = {
  relPath: 'behind.txt',
  content: 'have revision one\n',
  headRev: 2,
  headContent: BEHIND_HEAD,
}
const NESTED_HAVE = 'export const x = 1\n'
const NESTED_HEAD = 'export const x = 3\n'
const nestedBehind: SeedFile = {
  relPath: 'src/lib/util.ts',
  content: NESTED_HAVE,
  headRev: 3,
  headContent: NESTED_HEAD,
}
// Fault injection: a plain `p4 sync` on this file refuses with "can't clobber
// writable file" (exit 1) — the file has local work nobody collected yet.
const LOCAL_DRAFT = 'my local work\n'
const CLOBBERED_HEAD = 'head draft\n'
const clobbered: SeedFile = {
  relPath: 'draft.txt',
  content: 'have draft\n',
  headRev: 2,
  headContent: CLOBBERED_HEAD,
  clobber: true,
}
// The other refusal shape: an `allwrite noclobber` client skips just this file
// (`can't update modified file` on stdout, exit 0) and carries on. Unparsed, the
// get "succeeded" with nothing applied and the user was told the stale file was
// already at the latest revision.
const REFUSED_DRAFT = 'my uncollected refused work\n'
const REFUSED_HAVE = 'have refused\n'
const REFUSED_HEAD = 'head refused\n'
const refused: SeedFile = {
  relPath: 'refused.txt',
  content: REFUSED_HAVE,
  headRev: 2,
  headContent: REFUSED_HEAD,
  refused: true,
}

/** Open the seeded workspace, wait for the provider + command registration. */
async function openSyncWorkspace(
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
  await waitForPerforceCommands(workbench)
}

test.describe('@p1 perforce sync', () => {
  test.describe('explorer right-click get latest', () => {
    test.use({ p4Seeds: { files: [behind, nestedBehind] } })

    // @serial: the only journey here that drives the real Explorer context menu,
    // so it needs the extension host to have finished contributing menu items
    // before the right-click lands. This suite cold-launches one Electron per
    // test, and stacked concurrent cold starts starve host activation (measured:
    // 2 of 3 parallel repeats fail on the menu never appearing, 3 of 3 pass with
    // --workers=1). Every other journey goes through runCommand or a probe, so
    // this is the one that has to be serialized rather than the whole file.
    test(
      'right-clicking a file or folder in the Explorer pulls just that target @regression',
      { tag: '@serial' },
      async ({ page, workbench, perforce }) => {
        test.setTimeout(120_000)
        await openSyncWorkspace(page, workbench, perforce.openDir)
        // The activity-bar item is a toggle too: clicking it while the Explorer is
        // already active AND the side bar focused closes the side bar.
        await workbench.showExplorer()

        const fileRow = page.locator('[role="treeitem"]', { hasText: 'behind.txt' })
        await expect(fileRow).toBeVisible({ timeout: 30_000 })

        await test.step('a file get updates only that file', async () => {
          await fileRow.click({ button: 'right' })
          const menu = page.getByRole('menu')
          await expect(menu).toBeVisible({ timeout: 10_000 })
          await menu.getByText('Get Latest Revision', { exact: true }).click()

          await expect
            .poll(() => readFileSync(perforce.file('behind.txt'), 'utf8'), {
              timeout: 30_000,
              message: 'the explorer get should write the head revision to disk',
            })
            .toBe(BEHIND_HEAD)
          // The sibling file is untouched — the get was file-scoped.
          expect(readFileSync(perforce.file(nestedBehind.relPath), 'utf8')).toBe(NESTED_HAVE)
        })

        await test.step('a folder get pulls the whole subtree', async () => {
          // Both gets update exactly one file, so the first step's result toast
          // would satisfy this step's toast assertion too. Clear the deck so the
          // toast waited on below can only be this get's.
          await workbench.runCommand('workbench.action.notifications.clearAll')
          await expect(page.locator('[data-testid="notification-toast-item"]')).toHaveCount(0)
          // The default layout renders nested folders compact — one row whose
          // label is "src/lib" (the accessible name collapses it to "srclib", but
          // the visible text keeps the separators). Right-click the `src` segment:
          // each segment carries its own context-menu target (`isDirectory: true`),
          // which the get command turns into the `<dir>/...` filespec.
          const folderRow = page.locator('[role="treeitem"]', { hasText: /src\/lib/ })
          await expect(folderRow).toBeVisible({ timeout: 30_000 })
          await folderRow.getByText('src', { exact: true }).click({ button: 'right' })
          const menu = page.getByRole('menu')
          await expect(menu).toBeVisible({ timeout: 10_000 })
          await menu.getByText('Get Latest Revision', { exact: true }).click()

          await expect
            .poll(() => readFileSync(perforce.file(nestedBehind.relPath), 'utf8'), {
              timeout: 30_000,
              message: 'the folder get should update the file under the subtree',
            })
            .toBe(NESTED_HEAD)
          // p4 writes the file before the get finishes, so the content assertion
          // alone would let teardown run while the progress notification is still
          // mounted — and its cancellation subscription is only released once the
          // host reports the run as ended. The result toast is the first thing
          // observable after that, so it is what makes teardown leak-free.
          await expect(
            page
              .locator('[data-testid="notification-toast-item"]')
              .filter({ hasText: 'Updated 1 file(s)' }),
          ).toBeVisible({ timeout: 30_000 })
        })
      },
    )
  })

  test.describe('clobber refusal collect button', () => {
    test.use({ p4Seeds: { files: [clobbered] } })

    test('the Collect Changes button on a clobber refusal really collects the drifted file @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openSyncWorkspace(page, workbench, perforce.openDir)

      const groupIds = (suffix: string) =>
        page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), suffix)

      await test.step('a clobber-refused get offers Collect Changes, and clicking really opens the file', async () => {
        // Drift the file on disk so Collect Changes has something to collect.
        writeFileSync(perforce.file(clobbered.relPath), LOCAL_DRAFT, 'utf8')
        // Fire-and-forget: the command parks on the error dialog. The host's
        // showErrorMessage-with-items renders as a confirm dialog — the same
        // surface the delete-changelist confirm uses in perforceChangelist.spec.ts.
        void page
          .evaluate(
            (p) => void window.__E2E__!.runCommand('perforce.syncLatest', { resourceUri: p }),
            perforce.file(clobbered.relPath),
          )
          .catch(() => {})

        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible({ timeout: 30_000 })
        await expect(dialog).toContainText('Get revision failed')
        await dialog.getByRole('button', { name: 'Collect Changes' }).click()

        // THE guard: the old implementation ran a clean refresh, which merely
        // discovers the drift — the file stays unopened. Really collecting opens
        // the file, so it must land in the default changelist.
        await expect
          .poll(() => groupIds(clobbered.relPath), {
            timeout: 30_000,
            message:
              'the collect button should really open (collect) the file into the default changelist',
          })
          .toEqual(['default'])
      })
    })
  })

  test.describe('clobber refusal collect button without a scope', () => {
    test.use({ p4Seeds: { files: [clobbered] } })

    test('a scope-less get refused by clobber collects the drift over the default sync range @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openSyncWorkspace(page, workbench, perforce.openDir)

      const groupIds = (suffix: string) =>
        page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), suffix)

      await test.step('Collect Changes on a scope-less refusal collects over the default sync range', async () => {
        // Drift the file on disk so Collect Changes has something to collect.
        writeFileSync(perforce.file(clobbered.relPath), LOCAL_DRAFT, 'utf8')
        // No resource argument — the status-bar entry style whole-range get.
        // Its refusal is over the client's own default sync scope, so the
        // collect must target that range too; the old implementation fell back
        // to a clean refresh, which merely re-discovered the drift and opened
        // nothing (the file would stay unopened).
        void page
          .evaluate(() => void window.__E2E__!.runCommand('perforce.syncLatest'))
          .catch(() => {})

        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible({ timeout: 30_000 })
        await expect(dialog).toContainText('Get revision failed')
        await dialog.getByRole('button', { name: 'Collect Changes' }).click()

        // THE guard: really collecting opens the file, so it must land in the
        // default changelist.
        await expect
          .poll(() => groupIds(clobbered.relPath), {
            timeout: 30_000,
            message:
              'the collect button should really open (collect) the file into the default changelist',
          })
          .toEqual(['default'])
      })
    })
  })

  test.describe('preview quick pick', () => {
    test.use({ p4Seeds: { files: [behind] } })

    test('perforce.previewSync lists what a get would bring in, and reports up-to-date when current @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openSyncWorkspace(page, workbench, perforce.openDir)

      await test.step('a pending get previews its files in a quick pick', async () => {
        // Fire-and-forget: the command parks on the quick pick until dismissed.
        void page
          .evaluate(() => void window.__E2E__!.runCommand('perforce.previewSync'))
          .catch(() => {})

        const quickInput = page.getByTestId('quick-input')
        await expect(quickInput).toBeVisible({ timeout: 30_000 })
        // The placeholder only renders as an input attribute, not text; the item
        // row itself is the assertion: label = file name, description = action#rev.
        await expect(quickInput.getByText('behind.txt', { exact: true })).toBeVisible()
        await expect(quickInput.getByText('updated #2', { exact: true })).toBeVisible()
        await page.keyboard.press('Escape')
        await workbench.quickInput.waitForHidden()
      })

      await test.step('after pulling, the preview reports up-to-date instead of a list', async () => {
        await workbench.runCommand('perforce.syncLatest', {
          resourceUri: perforce.file('behind.txt'),
        })
        await expect
          .poll(() => readFileSync(perforce.file('behind.txt'), 'utf8'), {
            timeout: 30_000,
            message: 'the pull should write the head revision to disk',
          })
          .toBe(BEHIND_HEAD)

        await workbench.runCommand('perforce.previewSync')
        await expect(
          page
            .locator('[data-testid="notification-toast-item"]')
            .filter({ hasText: 'Already at the latest revision' }),
        ).toBeVisible({ timeout: 30_000 })
      })
    })
  })

  test.describe('locally-modified refusal', () => {
    test.use({ p4Seeds: { files: [refused] } })

    test('a get p4 refused for uncollected local changes says so instead of claiming up-to-date @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openSyncWorkspace(page, workbench, perforce.openDir)

      const groupIds = (suffix: string) =>
        page.evaluate((s) => window.__E2E__!.getScmGroupIdsForResource(s), suffix)
      const upToDateToast = page
        .locator('[data-testid="notification-toast-item"]')
        .filter({ hasText: 'Already at the latest revision' })

      // The refusal is p4 protecting local work that nobody collected, so the
      // drift has to exist on disk for Collect Changes (and View Diff) to have
      // something to show — same setup as the clobber journeys above.
      writeFileSync(perforce.file(refused.relPath), REFUSED_DRAFT, 'utf8')

      await test.step('the preview lists the refused file rather than reporting up-to-date', async () => {
        // THE first guard: the refusal is a plain stdout line that `-ztag` drops,
        // so a single-file preview came back with zero records and reported "up to
        // date" — the same lie as the get itself.
        void page
          .evaluate(
            (p) => void window.__E2E__!.runCommand('perforce.previewSync', { resourceUri: p }),
            perforce.file(refused.relPath),
          )
          .catch(() => {})

        const quickInput = page.getByTestId('quick-input')
        await expect(quickInput).toBeVisible({ timeout: 30_000 })
        await expect(quickInput.getByText('refused.txt', { exact: true })).toBeVisible()
        // description = `<action> #<rev>`; the action reads as prose because it
        // also lands in the Explorer badge tooltip.
        await expect(quickInput.getByText('not updated #2', { exact: true })).toBeVisible()
        await expect(upToDateToast).toHaveCount(0)
        await page.keyboard.press('Escape')
        await workbench.quickInput.waitForHidden()
      })

      await test.step('the get reports the refusal instead of claiming up-to-date', async () => {
        // THE main guard: this used to pop "Already at the latest revision" while
        // the file sat a revision behind.
        void page
          .evaluate(
            (p) => void window.__E2E__!.runCommand('perforce.syncLatest', { resourceUri: p }),
            perforce.file(refused.relPath),
          )
          .catch(() => {})

        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible({ timeout: 30_000 })
        await expect(dialog).toContainText('not updated')
        await expect(upToDateToast).toHaveCount(0)
        // Nothing landed on disk: p4 refused, so the local work is still there
        // untouched (a force-get would have destroyed exactly this).
        expect(readFileSync(perforce.file(refused.relPath), 'utf8')).toBe(REFUSED_DRAFT)

        // THE fourth guard: View Diff used to do nothing at all. The host mapped
        // a two-item message onto primary/secondary/cancel and then read the pick
        // back off `choice`, so clicking the second item resolved to undefined and
        // the extension's `picked === BTN_DIFF` never matched. Opening the diff
        // also leaves the drift uncollected.
        await dialog.getByRole('button', { name: 'View Diff' }).click()
        await expect
          .poll(() => page.evaluate(() => window.__E2E__!.getActiveDiffContent()), {
            timeout: 30_000,
            message: 'View Diff should open the have-vs-local diff for the refused file',
          })
          .toEqual({ original: REFUSED_HAVE, modified: REFUSED_DRAFT })
        await expect(dialog).toHaveCount(0)
      })
    })
  })

  test.describe('force get', () => {
    test.use({ p4Seeds: { files: [refused, clobbered] } })

    test('Force Get overwrites the uncollected work on both refusal shapes, but only after a second confirmation @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openSyncWorkspace(page, workbench, perforce.openDir)

      const dialog = page.getByRole('dialog')

      /**
       * Drive one file's get through refusal → Force Get → confirmation, and
       * assert the head revision really landed on top of the local draft.
       * Both refusal shapes reach the same two-step flow, so they share it.
       */
      const forceGet = async (
        relPath: string,
        refusalText: string,
        head: string,
      ): Promise<void> => {
        writeFileSync(perforce.file(relPath), LOCAL_DRAFT, 'utf8')
        // Fire-and-forget: the command parks on the refusal dialog.
        void page
          .evaluate(
            (p) => void window.__E2E__!.runCommand('perforce.syncLatest', { resourceUri: p }),
            perforce.file(relPath),
          )
          .catch(() => {})

        await expect(dialog).toBeVisible({ timeout: 30_000 })
        await expect(dialog).toContainText(refusalText)
        await dialog.getByRole('button', { name: 'Force Get' }).click()

        // The second confirmation is the whole safety story: `sync -f` silently
        // discards work p4 just refused to touch, so it never runs off one click.
        await expect(dialog).toContainText('This cannot be undone', { timeout: 30_000 })
        await dialog.getByRole('button', { name: 'Force Get' }).click()

        await expect
          .poll(() => readFileSync(perforce.file(relPath), 'utf8'), {
            timeout: 30_000,
            message: 'the forced get should overwrite the local draft with the head revision',
          })
          .toBe(head)
      }

      await test.step('the stdout refusal shape (`can’t update modified file`)', async () => {
        await forceGet(refused.relPath, 'not updated', REFUSED_HEAD)
      })

      await test.step('the stderr clobber shape (`Can’t clobber writable file`)', async () => {
        await forceGet(clobbered.relPath, 'Get revision failed', CLOBBERED_HEAD)
      })
    })
  })
})
