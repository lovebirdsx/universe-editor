/*---------------------------------------------------------------------------------------------
 *  Perforce "get latest revision" smoke (@p1).
 *
 *  Covers the pull (sync) chain end to end against the fake p4 (fixtures/
 *  fake-p4.mjs): a depot file seeded ahead of the synced revision (`headRev` >
 *  have) models "the server has newer revisions". Six journeys, one cold launch
 *  each:
 *
 *  1. The two-tier behind-check (cheap `changes -m 1 -s submitted` gate → expensive
 *     `sync -n`) surfaces a status-bar count + grey "↓" marker;
 *     clicking the count pulls to head and zeroes both.
 *  2. The Explorer right-click "Get Latest Revision" targets a single file or a
 *     folder subtree (`<dir>/...`), leaving the rest of the client alone.
 *  3. A get refused with "can't clobber writable file" offers a Collect Changes
 *     button — clicking it must REALLY open (collect) the drifted file, not just
 *     re-discover it (the old implementation ran a clean refresh and collected
 *     nothing).
 *  4. The same refusal for a SCOPE-LESS get (the status-bar entry's whole-range
 *     get) collects over the client's default sync range rather than degrading
 *     to discovery-only.
 *  5. `perforce.previewSync` quick-picks the files a get would bring in, and
 *     reports "already at the latest" when nothing is pending.
 *  6. The OTHER refusal shape — an `allwrite noclobber` client skipping a
 *     locally-modified file on stdout with exit 0 — is reported as such by both
 *     the preview and the get, a run that both refuses and updates reports BOTH
 *     counts, and the Collect Changes button really collects. Unparsed, that
 *     shape made the get claim "already at the latest revision" for a file
 *     several revisions behind.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync } from 'node:fs'
import { test, expect, waitForPerforceCommands } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored, type WorkbenchPO } from '@universe-editor/e2e-harness'
import type { Page } from '@playwright/test'
import type { P4ChangeMetaSeed, SeedFile } from '../fixtures/perforceApp.js'

// Depot head is one revision ahead of what the client has synced (`haveRev` 1 vs
// `headRev` 2/3) — `p4 sync -n` then reports these files, which is what the
// behind-check and the preview quick-pick both read.
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
const clobbered: SeedFile = {
  relPath: 'draft.txt',
  content: 'have draft\n',
  headRev: 2,
  headContent: 'head draft\n',
  clobber: true,
}
// The other refusal shape: an `allwrite noclobber` client skips just this file
// (`can't update modified file` on stdout, exit 0) and carries on. Unparsed, the
// get "succeeded" with nothing applied and the user was told the stale file was
// already at the latest revision.
const REFUSED_DRAFT = 'my uncollected refused work\n'
const refused: SeedFile = {
  relPath: 'refused.txt',
  content: 'have refused\n',
  headRev: 2,
  headContent: 'head refused\n',
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
  test.describe('behind count and pull', () => {
    test.use({ p4Seeds: { files: [behind] } })

    test('a behind file counts in the status bar, and pulling it zeroes the count @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openSyncWorkspace(page, workbench, perforce.openDir)

      const hasBehindEntry = async (): Promise<boolean> =>
        (await workbench.statusBar.entriesFromProbe()).some((e) => /files behind/.test(e.text))

      await test.step('the behind-check surfaces a count AND a grey marker', async () => {
        // Assertion order is the guard: a spec that only ever asserts "zero" also
        // passes when the whole behind-check is deleted. This first poll proves
        // the count really appeared — the auto behind-check runs once at startup
        // (its cheap gate falls through on the fake depot, whose submitted-change
        // marker is initially unknown), then `sync -n` finds the seeded head gap.
        await expect
          .poll(hasBehindEntry, {
            timeout: 60_000,
            message: 'the behind count should appear once the first behind-check completes',
          })
          .toBe(true)
        await expect
          .poll(
            () => page.evaluate(() => window.__E2E__!.getScmDecorationForResource('behind.txt')),
            {
              timeout: 30_000,
              message: 'the behind file should carry the grey "↓" marker',
            },
          )
          .toEqual(expect.objectContaining({ description: '↓' }))
      })

      await test.step('clicking the behind status-bar item pulls to head and clears both', async () => {
        // The behind item's command is `perforce.syncScope` (whole sync scope) —
        // deliberately not the file-scoped `perforce.syncLatest`, which would
        // fetch only the active editor's file while the label promises N. The
        // scope pick now opens first; "Latest revision" is the one-shot head pull.
        const behindItem = page.locator('[data-testid="part-statusbar"] button', {
          hasText: /files behind/,
        })
        await expect(behindItem).toBeVisible({ timeout: 30_000 })
        await behindItem.click()

        const quickInput = page.getByTestId('quick-input')
        await expect(quickInput).toBeVisible({ timeout: 30_000 })
        await quickInput.getByRole('option', { name: /Latest revision/ }).click()

        // The pull writes the head revision to disk…
        await expect
          .poll(() => readFileSync(perforce.file('behind.txt'), 'utf8'), {
            timeout: 60_000,
            message: 'the pull should write the head revision to disk',
          })
          .toBe(BEHIND_HEAD)
        // …and the post-get behind re-check zeroes the count + drops the grey marker.
        await expect
          .poll(hasBehindEntry, {
            timeout: 60_000,
            message: 'the behind count should disappear after the pull',
          })
          .toBe(false)
        expect(
          await page.evaluate(() => window.__E2E__!.getScmDecorationForResource('behind.txt')),
        ).toBeNull()
      })
    })
  })

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
        await workbench.activityBar.click('workbench.view.explorer')

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
          // The sibling behind file is untouched — the get was file-scoped.
          expect(readFileSync(perforce.file(nestedBehind.relPath), 'utf8')).toBe(NESTED_HAVE)
          // The post-get behind re-check confirms server-side: exactly one file left.
          await expect
            .poll(
              async () =>
                (await workbench.statusBar.entriesFromProbe()).some((e) =>
                  /1 files behind/.test(e.text),
                ),
              { timeout: 30_000, message: 'the behind count should drop from 2 to 1' },
            )
            .toBe(true)
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

      await test.step('the drift surfaces in Changes to Reconcile', async () => {
        writeFileSync(perforce.file(clobbered.relPath), LOCAL_DRAFT, 'utf8')
        // Watcher arm window: rewrite the same drift to re-trigger discovery.
        await expect
          .poll(
            async () => {
              const ids = await groupIds(clobbered.relPath)
              if (!ids.includes('reconcile')) {
                writeFileSync(perforce.file(clobbered.relPath), LOCAL_DRAFT, 'utf8')
              }
              return ids
            },
            {
              timeout: 30_000,
              intervals: [500, 1000],
              message: 'the drift should surface in the reconcile group',
            },
          )
          .toEqual(expect.arrayContaining(['reconcile']))
      })

      await test.step('a clobber-refused get offers Collect Changes, and clicking really opens the file', async () => {
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
        // discovers the drift — the file stays listed in the reconcile group and
        // is never opened. Really collecting opens the file, so it must land in
        // the default changelist and leave the reconcile group.
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

      await test.step('the drift surfaces in Changes to Reconcile', async () => {
        writeFileSync(perforce.file(clobbered.relPath), LOCAL_DRAFT, 'utf8')
        // Watcher arm window: rewrite the same drift to re-trigger discovery.
        await expect
          .poll(
            async () => {
              const ids = await groupIds(clobbered.relPath)
              if (!ids.includes('reconcile')) {
                writeFileSync(perforce.file(clobbered.relPath), LOCAL_DRAFT, 'utf8')
              }
              return ids
            },
            {
              timeout: 30_000,
              intervals: [500, 1000],
              message: 'the drift should surface in the reconcile group',
            },
          )
          .toEqual(expect.arrayContaining(['reconcile']))
      })

      await test.step('Collect Changes on a scope-less refusal collects over the default sync range', async () => {
        // No resource argument — the status-bar entry style whole-range get.
        // Its refusal is over the client's own default sync scope, so the
        // collect must target that range too; the old implementation fell back
        // to a clean refresh, which merely re-discovered the drift and opened
        // nothing (the file would stay listed in the reconcile group).
        void page
          .evaluate(() => void window.__E2E__!.runCommand('perforce.syncLatest'))
          .catch(() => {})

        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible({ timeout: 30_000 })
        await expect(dialog).toContainText('Get revision failed')
        await dialog.getByRole('button', { name: 'Collect Changes' }).click()

        // THE guard: really collecting opens the file, so it must land in the
        // default changelist and leave the reconcile group.
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
    test.use({ p4Seeds: { files: [refused, behind] } })

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

      await test.step('the uncollected local work surfaces in Changes to Reconcile', async () => {
        // The refusal is p4 protecting local work that nobody collected, so the
        // drift has to exist on disk for Collect Changes to have anything to
        // collect — same setup as the clobber journeys above.
        writeFileSync(perforce.file(refused.relPath), REFUSED_DRAFT, 'utf8')
        await expect
          .poll(
            async () => {
              const ids = await groupIds(refused.relPath)
              if (!ids.includes('reconcile')) {
                writeFileSync(perforce.file(refused.relPath), REFUSED_DRAFT, 'utf8')
              }
              return ids
            },
            {
              timeout: 30_000,
              intervals: [500, 1000],
              message: 'the drift should surface in the reconcile group',
            },
          )
          .toEqual(expect.arrayContaining(['reconcile']))
      })

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
        // the file sat a revision behind and the status bar never changed.
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
        // Dismiss without collecting: the collect button is exercised by the
        // mixed-run step below, which needs the drift still uncollected.
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
      })

      await test.step('a run that both refuses and updates reports both counts, and Collect Changes really collects', async () => {
        // THE third guard: leading with the refusal must not swallow what landed.
        // A scope-wide get here refuses refused.txt and updates behind.txt in the
        // same exit-0 run; reporting only the refusal would leave the user
        // believing nothing was fetched (and the docs promise otherwise).
        void page
          .evaluate(() => void window.__E2E__!.runCommand('perforce.syncScope'))
          .catch(() => {})

        // The scope pick opens first; pick "Latest revision" for the #head sync
        // this journey needs (the seed has no submitted changelists to offer).
        const quickInput = page.getByTestId('quick-input')
        await expect(quickInput).toBeVisible({ timeout: 30_000 })
        await quickInput.getByRole('option', { name: /Latest revision/ }).click()

        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible({ timeout: 30_000 })
        await expect(dialog).toContainText('not updated')
        await expect(dialog).toContainText('Updated 1 file(s)')
        await expect(upToDateToast).toHaveCount(0)
        // The other file really did land, which is what the count claims.
        expect(readFileSync(perforce.file(behind.relPath), 'utf8')).toBe(BEHIND_HEAD)
        expect(readFileSync(perforce.file(refused.relPath), 'utf8')).toBe(REFUSED_DRAFT)

        await dialog.getByRole('button', { name: 'Collect Changes' }).click()
        await expect
          .poll(() => groupIds(refused.relPath), {
            timeout: 30_000,
            message:
              'the collect button should open (collect) the file into the default changelist',
          })
          .toEqual(['default'])
      })
    })
  })

  test.describe('sync scope changelist picker', () => {
    const AT_1002 = 'revision two from change 1002\n'
    const AT_1003 = 'revision three (head)\n'
    const behindAt: SeedFile = {
      relPath: 'behind.txt',
      content: 'revision one (have)\n',
      headRev: 3,
      headContent: AT_1003,
      revisions: { '2': AT_1002 },
    }
    const changeMeta: Readonly<Record<string, P4ChangeMetaSeed>> = {
      '1001': { user: 'e2e', time: '1760000000', desc: 'already synced', rev: 1 },
      '1002': { user: 'e2e', time: '1760000100', desc: 'middle change', rev: 2 },
      '1003': { user: 'e2e', time: '1760000200', desc: 'newest change', rev: 3 },
    }
    const cstat: Readonly<Record<string, 'have' | 'need' | 'partial'>> = {
      '1001': 'have',
      '1002': 'need',
      '1003': 'need',
    }

    test.use({ p4Seeds: { files: [behindAt], changeMeta, cstat } })

    test('picking a changelist syncs the scope to that revision, not head @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await openSyncWorkspace(page, workbench, perforce.openDir)

      // Fire-and-forget: the command parks on the quick pick until a row is chosen.
      void page
        .evaluate(() => void window.__E2E__!.runCommand('perforce.syncScope'))
        .catch(() => {})
      const quickInput = page.getByTestId('quick-input')
      await expect(quickInput).toBeVisible({ timeout: 30_000 })

      await test.step('the picker lists latest plus the behind changelists, dropping the already-synced one', async () => {
        await expect(quickInput.getByText('Latest revision', { exact: true })).toBeVisible()
        // Newest-first: 1003 then 1002 — the two `need` changelists.
        await expect(quickInput.getByText('newest change', { exact: true })).toBeVisible()
        await expect(quickInput.getByText('middle change', { exact: true })).toBeVisible()
        // 1001 is `have`: cstat classified it as already synced, so it must not be offered.
        await expect(quickInput.getByText('already synced', { exact: true })).toHaveCount(0)
      })

      await test.step('picking @1002 syncs the scope to that revision, not head', async () => {
        await quickInput.getByRole('option', { name: /middle change/ }).click()

        // The run sits in a cancellable notification progress. The bar is
        // determinate because the @1002 dry-run supplies a total (1 file), and it
        // stays mounted through the post-sync refresh, so it is observable despite
        // the fake's instant file writes.
        await expect(
          page.locator('[data-testid="notification-progress-determinate"]'),
        ).toBeVisible({ timeout: 30_000 })

        // Final result toast.
        await expect(
          page
            .locator('[data-testid="notification-toast-item"]')
            .filter({ hasText: 'Updated 1 file(s)' }),
        ).toBeVisible({ timeout: 30_000 })

        // On disk: the @1002 revision, not head.
        await expect
          .poll(() => readFileSync(perforce.file('behind.txt'), 'utf8'), { timeout: 30_000 })
          .toBe(AT_1002)
      })
    })
  })
})
